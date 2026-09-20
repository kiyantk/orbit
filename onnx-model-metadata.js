/**
 * Builds a derived ONNX copy when a model's graph metadata is narrower than
 * its actual supported tensor shapes. The original downloaded model is never
 * modified. This is specifically for SCRFD's dynamic H/W input combined with
 * fixed 640x640 candidate-count annotations on its nine outputs.
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { onnx } = require("onnx-proto");

const SCRFD_DYNAMIC_OUTPUT_PATCH_VERSION = "v1";

function sourceHash(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function hasDynamicScrfdOutputMetadata(model) {
  return model?.graph?.output?.length === 9 && model.graph.output.every((output) => {
    const dimensions = output.type?.tensorType?.shape?.dim;
    return Array.isArray(dimensions) && dimensions.length === 2 && Boolean(dimensions[0].dimParam);
  });
}

function patchScrfdOutputMetadata(model) {
  if (model?.graph?.output?.length !== 9) {
    throw new Error("Expected the 9-output SCRFD landmark model.");
  }

  model.graph.output.forEach((output, index) => {
    const dimensions = output.type?.tensorType?.shape?.dim;
    if (!Array.isArray(dimensions) || dimensions.length !== 2) {
      throw new Error(`Unexpected SCRFD output shape for ${output.name ?? index}.`);
    }
    // Axis 0 is the candidate count (H/stride × W/stride × anchors). It is
    // dynamic whenever SCRFD receives a dynamic spatial input. Keep the
    // feature axis (1, 4, or 10) unchanged.
    delete dimensions[0].dimValue;
    dimensions[0].dimParam = `orbit_scrfd_candidates_${index}`;
  });
}

async function ensureDynamicScrfdOutputMetadata(sourcePath) {
  const source = await fs.promises.readFile(sourcePath);
  const hash = sourceHash(source).slice(0, 16);
  const directory = path.dirname(sourcePath);
  const parsed = path.parse(sourcePath);
  const targetPath = path.join(
    directory,
    `.${parsed.name}.orbit-dynamic-output-${SCRFD_DYNAMIC_OUTPUT_PATCH_VERSION}-${hash}${parsed.ext}`,
  );

  try {
    const existing = onnx.ModelProto.decode(await fs.promises.readFile(targetPath));
    if (hasDynamicScrfdOutputMetadata(existing)) return targetPath;
  } catch {
    // Missing/corrupt derived data is safe to recreate from the unchanged
    // downloaded model below.
  }

  const model = onnx.ModelProto.decode(source);
  patchScrfdOutputMetadata(model);
  const encoded = Buffer.from(onnx.ModelProto.encode(model).finish());
  const temporaryPath = `${targetPath}.${process.pid}.${Date.now()}.part`;
  try {
    await fs.promises.writeFile(temporaryPath, encoded, { flag: "wx" });
    await fs.promises.rename(temporaryPath, targetPath);
  } catch (error) {
    await fs.promises.rm(temporaryPath, { force: true }).catch(() => {});
    // Another Orbit process may have completed the exact same derived copy.
    if (error.code !== "EEXIST") throw error;
  }

  const verified = onnx.ModelProto.decode(await fs.promises.readFile(targetPath));
  if (!hasDynamicScrfdOutputMetadata(verified)) {
    throw new Error("The derived SCRFD model does not contain dynamic output metadata.");
  }
  return targetPath;
}

module.exports = {
  ensureDynamicScrfdOutputMetadata,
  patchScrfdOutputMetadata,
};
