/**
 * embedding-process.js
 *
 * Spawned as a child process via child_process.fork().
 *
 * Image encoding: image-feature-extraction pipeline (Xenova/clip-vit-base-patch32)
 * Text encoding:  AutoTokenizer + CLIPTextModelWithProjection (same model)
 *
 * Both produce L2-normalised 512-d vectors in the same CLIP embedding space.
 */

const fs   = require("fs");
const path = require("path");
const os   = require("os");

// Image pipeline (pipeline API works fine for images)
let imagePipeline = null;

// Text encoder (must use low-level API — pipeline API can't handle text for CLIP)
let tokenizer  = null;
let textModel  = null;

let cacheDir = null;

async function initPipelines(dir) {
  cacheDir = dir;
  try {
    const {
      pipeline,
      env,
      AutoTokenizer,
      CLIPTextModelWithProjection,
    } = await import("@xenova/transformers");

    // Both must point to the same root that contains Xenova/clip-vit-base-patch32/
    env.cacheDir          = dir;
    env.localModelPath    = dir;
    env.allowLocalModels  = true;   // explicitly enable local loading
    env.allowRemoteModels = false;  // block all network fetches
    env.backends.onnx.wasm.numThreads = 1;

    const MODEL = "Xenova/clip-vit-base-patch32";

    console.log(`[embed] Loading model from: ${dir}`);
    console.log(`[embed] Expected path: ${path.join(dir, MODEL)}`);

    // Verify the folder actually exists before trying to load
    const modelDir = path.join(dir, MODEL);
    if (!fs.existsSync(modelDir)) {
      throw new Error(`Model directory not found: ${modelDir}`);
    }

    imagePipeline = await pipeline(
      "image-feature-extraction",
      MODEL,
      { quantized: true }
    );

    tokenizer = await AutoTokenizer.from_pretrained(MODEL);
    textModel  = await CLIPTextModelWithProjection.from_pretrained(MODEL, { quantized: true });

    process.send({ type: "ready" });
  } catch (err) {
    process.send({ type: "initError", error: err.message });
  }
}

async function embedImage(fileId, filePath, imageBuffer) {
  let tempPath = null;
  try {
    let inputPath;
    if (imageBuffer) {
      const buf = Buffer.isBuffer(imageBuffer)
        ? imageBuffer
        : Buffer.from(
            imageBuffer.buffer,
            imageBuffer.byteOffset ?? 0,
            imageBuffer.byteLength,
          );
      tempPath  = path.join(os.tmpdir(), `orbit_embed_${fileId}_${Date.now()}.jpg`);
      fs.writeFileSync(tempPath, buf);
      inputPath = tempPath;
    } else {
      inputPath = filePath;
    }

    const output = await imagePipeline(inputPath, { pooling: "mean", normalize: true });
    process.send({ type: "embedResult", fileId, embedding: Array.from(output.data) });
  } catch (err) {
    process.send({ type: "embedError", fileId, error: err.message });
  } finally {
    if (tempPath) try { fs.unlinkSync(tempPath); } catch {}
  }
}

// async function embedText(text) {
//   try {
//     // Tokenize
//     const textInputs = tokenizer([text], { padding: true, truncation: true });

//     // Run text model — returns { text_embeds: Tensor[1, 512] }
//     const { text_embeds } = await textModel(textInputs);

//     // L2-normalise so it's in the same space as the image embeddings
//     const vec  = Array.from(text_embeds.data); // Float32Array → plain array
//     const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
//     const normalised = vec.map(v => v / norm);

//     process.send({ type: "textResult", embedding: normalised });
//   } catch (err) {
//     process.send({ type: "textError", error: err.message });
//   }
// }

async function embedText(text) {
  try {
    const textInputs = tokenizer([text], { padding: true, truncation: true });
    const { text_embeds } = await textModel(textInputs);
 
    // text_embeds shape: [1, 512] — flatten to a plain array
    const raw  = Array.from(text_embeds.data);
 
    // L2-normalise to unit length so dot product == cosine similarity
    const norm = Math.sqrt(raw.reduce((s, v) => s + v * v, 0)) || 1;
    const normalised = raw.map(v => v / norm);
 
    // Sanity check — log if magnitude is way off (helps catch future regressions)
    const checkNorm = Math.sqrt(normalised.reduce((s, v) => s + v * v, 0));
    if (Math.abs(checkNorm - 1.0) > 0.01) {
      console.warn(`[embed] text vector norm after normalisation: ${checkNorm} (expected ~1.0)`);
    }
 
    process.send({ type: "textResult", embedding: normalised });
  } catch (err) {
    process.send({ type: "textError", error: err.message });
  }
}

process.on("message", async (msg) => {
  switch (msg.type) {

    case "init":
      await initPipelines(msg.cacheDir);
      break;

    case "embed":
      if (!imagePipeline) {
        process.send({ type: "embedError", fileId: msg.fileId, error: "pipeline not ready" });
        return;
      }
      await embedImage(msg.fileId, msg.filePath, msg.imageBuffer ?? null);
      break;

    case "embedText":
      if (!tokenizer || !textModel) {
        process.send({ type: "textError", error: "text model not ready" });
        return;
      }
      await embedText(msg.text);
      break;

    case "stop":
      process.exit(0);
      break;
  }
});
