/** Local SCRFD + ArcFace/GlintR100 ONNX inference process. */
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const heicDecode = require("heic-decode");
const ort = require("onnxruntime-node");
const { ensureDynamicScrfdOutputMetadata } = require("./onnx-model-metadata");

const INFERENCE_THREADS = 1;
const SESSION_OPTIONS = { intraOpNumThreads: INFERENCE_THREADS, interOpNumThreads: INFERENCE_THREADS };
const DETECTION_MAX_SIDE = 960;
const DETECTION_THRESHOLD = 0.55;
const NMS_THRESHOLD = 0.4;
const MIN_RECOGNITION_FACE_SIZE = 48;
const ARCFACE_DESTINATION = [
  [38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366],
  [41.5493, 92.3655], [70.7299, 92.2041],
];

sharp.concurrency(INFERENCE_THREADS);
let detector = null;
let recognizer = null;

function nchwArcFace(rgb, width, height) {
  const result = new Float32Array(3 * width * height);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const source = pixel * 3;
    result[pixel] = (rgb[source] - 127.5) / 128;
    result[width * height + pixel] = (rgb[source + 1] - 127.5) / 128;
    result[2 * width * height + pixel] = (rgb[source + 2] - 127.5) / 128;
  }
  return result;
}

function flattenTensor(tensor) {
  return tensor?.data instanceof Float32Array ? tensor.data : Float32Array.from(tensor?.data ?? []);
}

function iou(left, right) {
  const x1 = Math.max(left.x1, right.x1);
  const y1 = Math.max(left.y1, right.y1);
  const x2 = Math.min(left.x2, right.x2);
  const y2 = Math.min(left.y2, right.y2);
  const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = (left.x2 - left.x1) * (left.y2 - left.y1) + (right.x2 - right.x1) * (right.y2 - right.y1) - intersection;
  return union > 0 ? intersection / union : 0;
}

function nonMaximumSuppression(candidates) {
  const selected = [];
  for (const candidate of candidates.sort((a, b) => b.score - a.score)) {
    if (selected.every((existing) => iou(candidate, existing) < NMS_THRESHOLD)) selected.push(candidate);
  }
  return selected;
}

function detectorOutputGroups(output) {
  const tensors = detector.outputNames.map((name) => output[name]);
  const scores = tensors.filter((tensor) => tensor?.dims?.at(-1) === 1);
  const boxes = tensors.filter((tensor) => tensor?.dims?.at(-1) === 4);
  const landmarks = tensors.filter((tensor) => tensor?.dims?.at(-1) === 10);
  if (scores.length !== 3 || boxes.length !== 3 || landmarks.length !== 3) {
    throw new Error("Unexpected SCRFD output layout; expected three score, box and landmark tensors");
  }
  return { scores, boxes, landmarks };
}

function decodeScrfd(output, inputWidth, inputHeight, originalWidth, originalHeight) {
  const groups = detectorOutputGroups(output);
  const strides = [8, 16, 32];
  const candidates = [];
  for (let level = 0; level < strides.length; level += 1) {
    const stride = strides[level];
    const scores = flattenTensor(groups.scores[level]);
    const boxes = flattenTensor(groups.boxes[level]);
    const landmarks = flattenTensor(groups.landmarks[level]);
    const gridWidth = Math.floor(inputWidth / stride);
    const expectedAnchors = Math.floor(inputHeight / stride) * gridWidth * 2;
    const anchorCount = Math.min(scores.length, Math.floor(boxes.length / 4), Math.floor(landmarks.length / 10), expectedAnchors);
    for (let anchor = 0; anchor < anchorCount; anchor += 1) {
      const score = scores[anchor];
      if (score < DETECTION_THRESHOLD) continue;
      const cell = Math.floor(anchor / 2);
      const centerX = (cell % gridWidth) * stride;
      const centerY = Math.floor(cell / gridWidth) * stride;
      const boxOffset = anchor * 4;
      const x1 = Math.max(0, centerX - boxes[boxOffset] * stride);
      const y1 = Math.max(0, centerY - boxes[boxOffset + 1] * stride);
      const x2 = Math.min(inputWidth, centerX + boxes[boxOffset + 2] * stride);
      const y2 = Math.min(inputHeight, centerY + boxes[boxOffset + 3] * stride);
      if (x2 - x1 < 2 || y2 - y1 < 2) continue;
      const landmarkOffset = anchor * 10;
      const points = [];
      for (let point = 0; point < 5; point += 1) {
        points.push([
          (centerX + landmarks[landmarkOffset + point * 2] * stride) * originalWidth / inputWidth,
          (centerY + landmarks[landmarkOffset + point * 2 + 1] * stride) * originalHeight / inputHeight,
        ]);
      }
      candidates.push({
        score,
        x1: x1 * originalWidth / inputWidth,
        y1: y1 * originalHeight / inputHeight,
        x2: x2 * originalWidth / inputWidth,
        y2: y2 * originalHeight / inputHeight,
        landmarks: points,
      });
    }
  }
  return nonMaximumSuppression(candidates);
}

function solveLinearSystem(matrix, vector) {
  const size = vector.length;
  const augmented = matrix.map((row, index) => [...row, vector[index]]);
  for (let pivot = 0; pivot < size; pivot += 1) {
    let best = pivot;
    for (let row = pivot + 1; row < size; row += 1) {
      if (Math.abs(augmented[row][pivot]) > Math.abs(augmented[best][pivot])) best = row;
    }
    if (Math.abs(augmented[best][pivot]) < 1e-8) return null;
    [augmented[pivot], augmented[best]] = [augmented[best], augmented[pivot]];
    const divisor = augmented[pivot][pivot];
    for (let column = pivot; column <= size; column += 1) augmented[pivot][column] /= divisor;
    for (let row = 0; row < size; row += 1) {
      if (row === pivot) continue;
      const factor = augmented[row][pivot];
      for (let column = pivot; column <= size; column += 1) augmented[row][column] -= factor * augmented[pivot][column];
    }
  }
  return augmented.map((row) => row[size]);
}

// Fits x' = a*x - b*y + tx and y' = b*x + a*y + ty to the five ArcFace points.
function similarityTransform(source) {
  const normal = Array.from({ length: 4 }, () => [0, 0, 0, 0]);
  const rhs = [0, 0, 0, 0];
  const addEquation = (row, value) => {
    for (let i = 0; i < 4; i += 1) {
      rhs[i] += row[i] * value;
      for (let j = 0; j < 4; j += 1) normal[i][j] += row[i] * row[j];
    }
  };
  for (let index = 0; index < 5; index += 1) {
    const [x, y] = source[index];
    const [u, v] = ARCFACE_DESTINATION[index];
    addEquation([x, -y, 1, 0], u);
    addEquation([y, x, 0, 1], v);
  }
  return solveLinearSystem(normal, rhs);
}

function alignedFace(raw, width, height, landmarks) {
  const transform = similarityTransform(landmarks);
  if (!transform) return null;
  const [a, b, tx, ty] = transform;
  const determinant = a * a + b * b;
  if (determinant < 1e-8) return null;
  const output = new Uint8Array(112 * 112 * 3);
  const sample = (x, y, channel) => {
    const left = Math.floor(x);
    const top = Math.floor(y);
    const right = Math.min(width - 1, left + 1);
    const bottom = Math.min(height - 1, top + 1);
    const dx = x - left;
    const dy = y - top;
    const topValue = raw[(top * width + left) * 3 + channel] * (1 - dx) + raw[(top * width + right) * 3 + channel] * dx;
    const bottomValue = raw[(bottom * width + left) * 3 + channel] * (1 - dx) + raw[(bottom * width + right) * 3 + channel] * dx;
    return topValue * (1 - dy) + bottomValue * dy;
  };
  for (let y = 0; y < 112; y += 1) {
    for (let x = 0; x < 112; x += 1) {
      const dx = x - tx;
      const dy = y - ty;
      const sourceX = (a * dx + b * dy) / determinant;
      const sourceY = (-b * dx + a * dy) / determinant;
      const target = (y * 112 + x) * 3;
      if (sourceX < 0 || sourceY < 0 || sourceX >= width - 1 || sourceY >= height - 1) continue;
      output[target] = Math.round(sample(sourceX, sourceY, 0));
      output[target + 1] = Math.round(sample(sourceX, sourceY, 1));
      output[target + 2] = Math.round(sample(sourceX, sourceY, 2));
    }
  }
  return output;
}

function l2Normalize(values) {
  let norm = 0;
  for (const value of values) norm += value * value;
  norm = Math.sqrt(norm) || 1;
  return Array.from(values, (value) => value / norm);
}

function recognitionQuality(face) {
  const width = face.x2 - face.x1;
  const height = face.y2 - face.y1;
  const minSide = Math.min(width, height);
  const leftEye = face.landmarks[0];
  const rightEye = face.landmarks[1];
  const eyeDistance = Math.hypot(rightEye[0] - leftEye[0], rightEye[1] - leftEye[1]);
  const landmarkScore = Math.max(0, Math.min(1, eyeDistance / Math.max(1, minSide * 0.35)));
  return face.score * Math.min(1, minSide / 140) * landmarkScore;
}

async function loadImage(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  let image;
  if (extension === ".heic" || extension === ".heif") {
    const decoded = await heicDecode({ buffer: fs.readFileSync(filePath) });
    image = sharp(decoded.data, { raw: { width: decoded.width, height: decoded.height, channels: 4 } }).rotate();
  } else {
    image = sharp(filePath, { animated: false }).rotate();
  }
  const { data, info } = await image.removeAlpha().raw().toBuffer({ resolveWithObject: true });
  if (!info.width || !info.height) throw new Error("Image dimensions unavailable");
  return { raw: data, width: info.width, height: info.height };
}

async function detect(filePath) {
  const image = await loadImage(filePath);
  const scale = Math.min(1, DETECTION_MAX_SIDE / Math.max(image.width, image.height));
  const detectionWidth = Math.max(32, Math.round(image.width * scale / 32) * 32);
  const detectionHeight = Math.max(32, Math.round(image.height * scale / 32) * 32);
  const { data } = await sharp(image.raw, { raw: { width: image.width, height: image.height, channels: 3 } })
    .resize(detectionWidth, detectionHeight, { fit: "fill" }).raw().toBuffer({ resolveWithObject: true });
  const input = new ort.Tensor("float32", nchwArcFace(data, detectionWidth, detectionHeight), [1, 3, detectionHeight, detectionWidth]);
  const output = await detector.run({ [detector.inputNames[0]]: input });
  const detected = decodeScrfd(output, detectionWidth, detectionHeight, image.width, image.height);
  const faces = [];
  for (const face of detected) {
    const width = face.x2 - face.x1;
    const height = face.y2 - face.y1;
    const quality = recognitionQuality(face);
    const record = {
      box: { left: face.x1 / image.width, top: face.y1 / image.height, width: width / image.width, height: height / image.height },
      landmarks: face.landmarks.map(([x, y]) => [x / image.width, y / image.height]),
      detectorConfidence: face.score,
      quality,
    };
    if (Math.min(width, height) >= MIN_RECOGNITION_FACE_SIZE && quality >= 0.2) {
      const aligned = alignedFace(image.raw, image.width, image.height, face.landmarks);
      if (aligned) {
        const recognitionInput = new ort.Tensor("float32", nchwArcFace(aligned, 112, 112), [1, 3, 112, 112]);
        const recognitionOutput = await recognizer.run({ [recognizer.inputNames[0]]: recognitionInput });
        const tensor = recognitionOutput[recognizer.outputNames[0]];
        const embedding = flattenTensor(tensor);
        if (embedding.length === 512) record.embedding = l2Normalize(embedding);
      }
    }
    faces.push(record);
  }
  return faces;
}

async function initialise(modelDirectory) {
  const modelRoot = path.join(modelDirectory, "InsightFace-AntelopeV2");
  const detectorSourcePath = path.join(modelRoot, "scrfd_10g_bnkps.onnx");
  let detectorPath = detectorSourcePath;
  try {
    // The AntelopeV2 SCRFD graph accepts dynamic spatial inputs but declares
    // its output candidate counts as 640x640 constants. Load a metadata-only
    // derived copy so ORT's declared and actual output shapes agree.
    detectorPath = await ensureDynamicScrfdOutputMetadata(detectorSourcePath);
  } catch (error) {
    // Do not turn a metadata-cache failure into an indexing outage. The source
    // model is still valid; it merely produces ORT's shape warning.
    process.send?.({ type: "log", level: "warn", message: `Using source SCRFD model: ${error.message}` });
  }
  detector = await ort.InferenceSession.create(detectorPath, SESSION_OPTIONS);
  recognizer = await ort.InferenceSession.create(path.join(modelRoot, "glintr100.onnx"), SESSION_OPTIONS);
}

process.on("message", async (message) => {
  if (message.type === "init") {
    try {
      await initialise(message.modelDirectory);
      process.send?.({ type: "ready" });
    } catch (error) {
      process.send?.({ type: "initError", error: error.message });
    }
  } else if (message.type === "detect") {
    try {
      const faces = await detect(message.filePath);
      process.send?.({ type: "result", fileId: message.fileId, faces });
    } catch (error) {
      process.send?.({ type: "detectError", fileId: message.fileId, error: error.message });
    }
  } else if (message.type === "stop") {
    process.exit(0);
  }
});
