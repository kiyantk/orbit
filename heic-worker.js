const { workerData, parentPort } = require("worker_threads");
const heicDecode = require("heic-decode");
const sharp = require("sharp");
const fs = require("fs");

(async () => {
  try {
    const inputBuffer = fs.readFileSync(workerData.filePath);
    const heicImage = await heicDecode({ buffer: inputBuffer });
    const outputBuffer = await sharp(heicImage.data, {
      raw: { width: heicImage.width, height: heicImage.height, channels: 4 },
    }).jpeg({ quality: 80 }).toBuffer();
    // Node marks normal Buffer backing stores as non-transferable. Copy into a
    // standalone ArrayBuffer so it can be transferred once, rather than cloned
    // into the main process and copied again for the cache.
    const transferableBuffer = outputBuffer.buffer.slice(
      outputBuffer.byteOffset,
      outputBuffer.byteOffset + outputBuffer.byteLength,
    );
    parentPort.postMessage(
      {
        success: true,
        buffer: transferableBuffer,
        byteLength: transferableBuffer.byteLength,
      },
      [transferableBuffer],
    );
  } catch (err) {
    parentPort.postMessage({ success: false, error: err.message });
  }
})();
