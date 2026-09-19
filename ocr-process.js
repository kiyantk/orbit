/** PaddleOCR ONNX inference process. Model configuration is read from the
 * downloaded inference.yml files so the resource remains self-contained. */
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const heicDecode = require("heic-decode");
const ort = require("onnxruntime-node");
const YAML = require("yaml");

// OCR indexing must stay a background task. Limit both inference and image
// preprocessing to one core; the queue itself is already single-file.
const OCR_INFERENCE_THREADS = 1;
const OCR_SESSION_OPTIONS = {
  intraOpNumThreads: OCR_INFERENCE_THREADS,
  interOpNumThreads: OCR_INFERENCE_THREADS,
};
// PaddleOCR's standard detection resize limit. It is substantially cheaper
// than 1280px while retaining useful detail for normal photo text.
const DETECTION_MAX_SIDE_LENGTH = 960;
sharp.concurrency(OCR_INFERENCE_THREADS);

let detector = null;
let recognizer = null;
let characters = [];
let recognitionHeight = 48;
let recognitionWidth = 320;
let detectionNormalisation = { mean: [0.485, 0.456, 0.406], std: [0.229, 0.224, 0.225] };
let recognitionNormalisation = { mean: [0.5, 0.5, 0.5], std: [0.5, 0.5, 0.5] };

function findValue(value, matcher) {
  if (!value || typeof value !== "object") return null;
  for (const [key, child] of Object.entries(value)) {
    if (matcher(key)) return child;
    const nested = findValue(child, matcher);
    if (nested != null) return nested;
  }
  return null;
}

function parseCharacterDictionary(config) {
  const dictionary = findValue(config, (key) => /character_dict$/i.test(key));
  if (Array.isArray(dictionary)) return dictionary.map(String);
  if (typeof dictionary === "string" && dictionary.trim()) {
    const maybePath = dictionary.trim();
    if (fs.existsSync(maybePath)) return fs.readFileSync(maybePath, "utf8").split(/\r?\n/).filter(Boolean);
    return [...maybePath];
  }
  throw new Error("recognition inference.yml does not contain PostProcess.character_dict");
}

function configureRecognition(config) {
  const shape = findValue(config, (key) => /rec_image_shape|image_shape/i.test(key));
  const values = Array.isArray(shape) ? shape.map(Number) : [];
  if (values.length >= 3) {
    recognitionHeight = values.at(-2) || recognitionHeight;
    recognitionWidth = values.at(-1) || recognitionWidth;
  }
}

function normalisationFromConfig(config, fallback) {
  const mean = findValue(config, (key) => key.toLowerCase() === "mean");
  const std = findValue(config, (key) => key.toLowerCase() === "std");
  if (!Array.isArray(mean) || !Array.isArray(std) || mean.length < 3 || std.length < 3) {
    return fallback;
  }
  return {
    mean: mean.slice(0, 3).map(Number),
    std: std.slice(0, 3).map((value) => Number(value) || 1),
  };
}

async function initialise(modelDirectory) {
  const detectionDir = path.join(modelDirectory, "PaddleOCR-v6-medium", "detection");
  const recognitionDir = path.join(modelDirectory, "PaddleOCR-v6-medium", "recognition");
  const detConfig = YAML.parse(fs.readFileSync(path.join(detectionDir, "inference.yml"), "utf8"));
  const recConfig = YAML.parse(fs.readFileSync(path.join(recognitionDir, "inference.yml"), "utf8"));
  characters = parseCharacterDictionary(recConfig);
  configureRecognition(recConfig);
  detectionNormalisation = normalisationFromConfig(detConfig, detectionNormalisation);
  recognitionNormalisation = normalisationFromConfig(recConfig, recognitionNormalisation);
  detector = await ort.InferenceSession.create(
    path.join(detectionDir, "inference.onnx"), OCR_SESSION_OPTIONS,
  );
  recognizer = await ort.InferenceSession.create(
    path.join(recognitionDir, "inference.onnx"), OCR_SESSION_OPTIONS,
  );
}

function nchw(rgb, width, height, normalisation) {
  const result = new Float32Array(3 * width * height);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    for (let channel = 0; channel < 3; channel += 1) {
      const value = rgb[pixel * 3 + channel] / 255;
      result[channel * width * height + pixel] =
        (value - normalisation.mean[channel]) / normalisation.std[channel];
    }
  }
  return result;
}

function outputTensor(output) {
  return Object.values(output)[0];
}

function detectionBoxes(tensor, imageWidth, imageHeight) {
  const dims = tensor.dims;
  const mapHeight = dims.at(-2);
  const mapWidth = dims.at(-1);
  const seen = new Uint8Array(mapWidth * mapHeight);
  const boxes = [];
  const data = tensor.data;
  const threshold = 0.3;
  for (let start = 0; start < seen.length; start += 1) {
    if (seen[start] || data[start] < threshold) continue;
    const queue = [start]; seen[start] = 1;
    let minX = mapWidth, minY = mapHeight, maxX = 0, maxY = 0, count = 0;
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const index = queue[cursor]; const x = index % mapWidth; const y = Math.floor(index / mapWidth);
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); count += 1;
      for (const neighbour of [index - 1, index + 1, index - mapWidth, index + mapWidth]) {
        if (neighbour < 0 || neighbour >= seen.length || seen[neighbour]) continue;
        const nx = neighbour % mapWidth;
        if (Math.abs(nx - x) > 1 || data[neighbour] < threshold) continue;
        seen[neighbour] = 1; queue.push(neighbour);
      }
    }
    if (count < 8 || maxX - minX < 2 || maxY - minY < 2) continue;
    const pad = 2;
    minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad);
    maxX = Math.min(mapWidth - 1, maxX + pad); maxY = Math.min(mapHeight - 1, maxY + pad);
    boxes.push({
      left: Math.floor(minX / mapWidth * imageWidth), top: Math.floor(minY / mapHeight * imageHeight),
      width: Math.max(1, Math.ceil((maxX - minX + 1) / mapWidth * imageWidth)),
      height: Math.max(1, Math.ceil((maxY - minY + 1) / mapHeight * imageHeight)),
    });
  }
  return boxes.sort((a, b) => a.top - b.top || a.left - b.left);
}

async function recognise(image, box, imageWidth, imageHeight) {
  // Detection coordinates are approximate and may extend a pixel beyond the
  // image edge. Clamp the complete region before Sharp sees it: a negative
  // width/height is what produces its "extract_area: bad extract area" error.
  const left = Math.max(0, Math.min(imageWidth - 1, Math.floor(box.left)));
  const top = Math.max(0, Math.min(imageHeight - 1, Math.floor(box.top)));
  const width = Math.max(1, Math.min(Math.ceil(box.width), imageWidth - left));
  const height = Math.max(1, Math.min(Math.ceil(box.height), imageHeight - top));
  const crop = image.clone().extract({
    left, top, width, height,
  });
  const cropMetadata = await crop.metadata();
  const targetWidth = Math.max(8, Math.min(recognitionWidth, Math.round(recognitionHeight * cropMetadata.width / cropMetadata.height)));
  const { data } = await crop.resize(targetWidth, recognitionHeight, { fit: "fill" }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const input = new Float32Array(3 * recognitionHeight * recognitionWidth);
  const compact = nchw(data, targetWidth, recognitionHeight, recognitionNormalisation);
  for (let channel = 0; channel < 3; channel += 1) {
    for (let row = 0; row < recognitionHeight; row += 1) {
      const sourceStart = channel * targetWidth * recognitionHeight + row * targetWidth;
      const destinationStart = channel * recognitionWidth * recognitionHeight + row * recognitionWidth;
      input.set(compact.subarray(sourceStart, sourceStart + targetWidth), destinationStart);
    }
  }
  const tensor = new ort.Tensor("float32", input, [1, 3, recognitionHeight, recognitionWidth]);
  const output = outputTensor(await recognizer.run({ [recognizer.inputNames[0]]: tensor }));
  const timeSteps = output.dims.at(-2);
  const classes = output.dims.at(-1);
  let text = ""; let scoreSum = 0; let scoreCount = 0; let previous = -1;
  for (let step = 0; step < timeSteps; step += 1) {
    let best = 0; let bestValue = -Infinity;
    for (let cls = 0; cls < classes; cls += 1) {
      const value = output.data[step * classes + cls];
      if (value > bestValue) { best = cls; bestValue = value; }
    }
    if (best !== 0 && best !== previous) {
      text += characters[best - 1] ?? "";
      scoreSum += bestValue; scoreCount += 1;
    }
    previous = best;
  }
  return {
    text: text.trim(), confidence: scoreCount ? scoreSum / scoreCount : 0,
    points: [[left / imageWidth, top / imageHeight], [(left + width) / imageWidth, top / imageHeight], [(left + width) / imageWidth, (top + height) / imageHeight], [left / imageWidth, (top + height) / imageHeight]],
  };
}

function orientedDimensions(metadata) {
  if (metadata.autoOrient?.width && metadata.autoOrient?.height) {
    return metadata.autoOrient;
  }
  if ([5, 6, 7, 8].includes(metadata.orientation)) {
    return { width: metadata.height, height: metadata.width };
  }
  return { width: metadata.width, height: metadata.height };
}

async function ocr(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  let image;
  if (extension === ".heic" || extension === ".heif") {
    const decoded = await heicDecode({ buffer: fs.readFileSync(filePath) });
    image = sharp(decoded.data, {
      raw: { width: decoded.width, height: decoded.height, channels: 4 },
    }).rotate();
  } else {
    image = sharp(filePath, { animated: false }).rotate();
  }
  const metadata = await image.metadata();
  const { width: imageWidth, height: imageHeight } = orientedDimensions(metadata);
  if (!imageWidth || !imageHeight) throw new Error("image dimensions unavailable");
  const scale = Math.min(1, DETECTION_MAX_SIDE_LENGTH / Math.max(imageWidth, imageHeight));
  const inputWidth = Math.max(32, Math.round(imageWidth * scale / 32) * 32);
  const inputHeight = Math.max(32, Math.round(imageHeight * scale / 32) * 32);
  const { data } = await image.clone().resize(inputWidth, inputHeight).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const detectionInput = new ort.Tensor("float32", nchw(data, inputWidth, inputHeight, detectionNormalisation), [1, 3, inputHeight, inputWidth]);
  const output = outputTensor(await detector.run({ [detector.inputNames[0]]: detectionInput }));
  const boxes = detectionBoxes(output, imageWidth, imageHeight);
  const recognised = [];
  for (const box of boxes) {
    const result = await recognise(image, box, imageWidth, imageHeight);
    if (result.text) recognised.push(result);
  }
  return recognised;
}

process.on("message", async (message) => {
  if (message.type === "init") {
    try { await initialise(message.modelDirectory); process.send?.({ type: "ready" }); }
    catch (error) { process.send?.({ type: "initError", error: error.message }); }
  } else if (message.type === "ocr") {
    try { process.send?.({ type: "result", fileId: message.fileId, boxes: await ocr(message.filePath) }); }
    catch (error) { process.send?.({ type: "ocrError", error: error.message }); }
  } else if (message.type === "stop") {
    process.exit(0);
  }
});
