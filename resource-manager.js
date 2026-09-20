/**
 * Downloadable Orbit resources.
 *
 * Resources are deliberately installed outside the application bundle so an
 * application update never removes them and large data files do not have to be
 * shipped with every installer.
 */

const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const { pipeline } = require("stream/promises");
const tar = require("tar");

const RESOURCE_DEFINITIONS = Object.freeze({
  places: Object.freeze({
    id: "places",
    version: "v1",
    downloadUrl:
      "https://github.com/kiyantk/orbit/releases/download/resources-v1/orbit-places-v1.tar.gz",
    downloadSizeBytes: 541_000_000,
    downloadSizeLabel: "541 MB",
    installDirectory: "places",
    expectedFiles: ["places.db"],
  }),
  "smart-search": Object.freeze({
    id: "smart-search",
    version: "v1",
    downloadUrl:
      "https://github.com/kiyantk/orbit/releases/download/resources-v1/orbit-smartsearch-v1.tar.gz",
    downloadSizeBytes: 107_000_000,
    downloadSizeLabel: "107 MB",
    installDirectory: "smart-search",
    expectedFiles: [
      "Xenova/clip-vit-base-patch32/config.json",
      "Xenova/clip-vit-base-patch32/preprocessor_config.json",
      "Xenova/clip-vit-base-patch32/tokenizer.json",
      "Xenova/clip-vit-base-patch32/tokenizer_config.json",
      "Xenova/clip-vit-base-patch32/onnx/text_model_quantized.onnx",
      "Xenova/clip-vit-base-patch32/onnx/vision_model_quantized.onnx",
    ],
  }),
  ocr: Object.freeze({
    id: "ocr",
    version: "v2",
    downloadUrl:
      "https://github.com/kiyantk/orbit/releases/download/resources-v1/orbit-ocr-v2.tar.gz",
    downloadSizeBytes: 95_000_000,
    downloadSizeLabel: "95 MB",
    installDirectory: "ocr",
    expectedFiles: [
      "PaddleOCR-v6-medium/detection/inference.json",
      "PaddleOCR-v6-medium/detection/inference.onnx",
      "PaddleOCR-v6-medium/detection/inference.yml",
      "PaddleOCR-v6-medium/recognition/inference.json",
      "PaddleOCR-v6-medium/recognition/inference.onnx",
      "PaddleOCR-v6-medium/recognition/inference.yml",
    ],
  }),
  "facial-recognition": Object.freeze({
    id: "facial-recognition",
    version: "v1",
    downloadUrl:
      "https://github.com/kiyantk/orbit/releases/download/resources-v1/orbit-facialrecognition-v1.tar.gz",
    downloadSizeBytes: 236_000_000,
    downloadSizeLabel: "236 MB",
    installDirectory: "facial-recognition",
    expectedFiles: [
      "InsightFace-AntelopeV2/glintr100.onnx",
      "InsightFace-AntelopeV2/scrfd_10g_bnkps.onnx",
    ],
  }),
});

const MAX_REDIRECTS = 5;
const PROGRESS_NOTIFY_INTERVAL_MS = 250;

class ResourceManager {
  constructor({ userDataDir, onStatusChange = () => {}, definitions = RESOURCE_DEFINITIONS }) {
    this.resourcesDirectory = path.join(userDataDir, "resources");
    this.definitions = definitions;
    this.onStatusChange = onStatusChange;
    this.states = new Map();
    this.downloads = new Map();
  }

  getInstallDirectory(id) {
    const definition = this._definitionFor(id);
    return path.join(this.resourcesDirectory, definition.installDirectory);
  }

  getExpectedFilePath(id, expectedFile) {
    return path.join(this.getInstallDirectory(id), expectedFile);
  }

  isInstalled(id) {
    const definition = this._definitionFor(id);
    const installDirectory = this.getInstallDirectory(id);

    return definition.expectedFiles.every((relativePath) => {
      try {
        return fs.statSync(path.join(installDirectory, relativePath)).isFile();
      } catch {
        return false;
      }
    });
  }

  getStatus(id) {
    const definition = this._definitionFor(id);
    const active = this.downloads.has(id);
    const installed = this.isInstalled(id);
    const savedState = this.states.get(id);

    let state = savedState?.state;
    if (!active) {
      if (installed) state = "ready";
      else if (state !== "download-failed") state = "download-required";
    }

    return this._publicStatus(definition, {
      state: state ?? (installed ? "ready" : "download-required"),
      downloadedBytes: savedState?.downloadedBytes ?? 0,
      totalBytes: savedState?.totalBytes ?? definition.downloadSizeBytes,
      error: savedState?.error ?? null,
    }, installed);
  }

  download(id) {
    const definition = this._definitionFor(id);

    if (this.isInstalled(id)) {
      const status = this._setState(definition, { state: "ready" });
      return Promise.resolve(status);
    }

    const existingDownload = this.downloads.get(id);
    if (existingDownload) return existingDownload;

    const download = this._install(definition)
      .finally(() => this.downloads.delete(id));
    this.downloads.set(id, download);
    return download;
  }

  async _install(definition) {
    const token = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const archivePath = path.join(
      this.resourcesDirectory,
      `.${definition.id}-${definition.version}-${token}.tar.gz.part`,
    );
    const stagingDirectory = path.join(
      this.resourcesDirectory,
      `.${definition.id}-${definition.version}-${token}.staging`,
    );

    try {
      await fs.promises.mkdir(this.resourcesDirectory, { recursive: true });
      this._setState(definition, {
        state: "downloading",
        downloadedBytes: 0,
        totalBytes: definition.downloadSizeBytes,
        error: null,
      });

      await this._downloadArchive(definition, archivePath);

      this._setState(definition, {
        state: "extracting",
        downloadedBytes: this.states.get(definition.id)?.downloadedBytes ?? 0,
        totalBytes: this.states.get(definition.id)?.totalBytes ?? definition.downloadSizeBytes,
        error: null,
      });
      await fs.promises.mkdir(stagingDirectory, { recursive: true });
      await tar.x({
        file: archivePath,
        cwd: stagingDirectory,
        strict: true,
        preservePaths: false,
      });

      const installRoot = await this._findInstallRoot(definition, stagingDirectory);
      if (!installRoot) {
        throw new Error(
          `The downloaded archive does not contain the expected ${definition.id} files.`,
        );
      }

      const installDirectory = this.getInstallDirectory(definition.id);
      await fs.promises.rm(installDirectory, { recursive: true, force: true });
      await fs.promises.rename(installRoot, installDirectory);

      // If the archive had a wrapper directory (for example models/), its
      // parent may still remain. The installed child has already moved away.
      if (installRoot !== stagingDirectory) {
        await fs.promises.rm(stagingDirectory, { recursive: true, force: true });
      }

      try {
        await fs.promises.rm(archivePath, { force: true });
      } catch (error) {
        console.warn(`[resources] Unable to remove ${archivePath}: ${error.message}`);
      }

      const status = this._setState(definition, {
        state: "ready",
        downloadedBytes: 0,
        totalBytes: definition.downloadSizeBytes,
        error: null,
      });
      return status;
    } catch (error) {
      await Promise.allSettled([
        fs.promises.rm(archivePath, { force: true }),
        fs.promises.rm(stagingDirectory, { recursive: true, force: true }),
      ]);
      this._setState(definition, {
        state: "download-failed",
        error: error.message || "The resource download failed.",
      });
      throw error;
    }
  }

  async _downloadArchive(definition, archivePath) {
    const response = await this._getResponse(definition.downloadUrl);
    const headerLength = Number.parseInt(response.headers["content-length"], 10);
    const totalBytes = Number.isFinite(headerLength) && headerLength > 0
      ? headerLength
      : definition.downloadSizeBytes;
    let downloadedBytes = 0;
    let lastNotificationAt = 0;

    const publishProgress = (force = false) => {
      const now = Date.now();
      if (!force && now - lastNotificationAt < PROGRESS_NOTIFY_INTERVAL_MS) {
        return;
      }
      lastNotificationAt = now;
      this._setState(definition, {
        state: "downloading",
        downloadedBytes,
        totalBytes,
        error: null,
      });
    };

    response.on("data", (chunk) => {
      downloadedBytes += chunk.length;
      publishProgress();
    });

    await pipeline(response, fs.createWriteStream(archivePath, { flags: "wx" }));
    publishProgress(true);
  }

  _getResponse(url, redirectCount = 0) {
    return new Promise((resolve, reject) => {
      const requestUrl = new URL(url);
      const client = requestUrl.protocol === "http:" ? http : https;
      const request = client.get(
        requestUrl,
        {
          headers: {
            "User-Agent": "Orbit resource downloader",
            Accept: "application/octet-stream",
          },
        },
        (response) => {
          const statusCode = response.statusCode ?? 0;
          const redirectLocation = response.headers.location;

          if (
            statusCode >= 300 &&
            statusCode < 400 &&
            redirectLocation &&
            redirectCount < MAX_REDIRECTS
          ) {
            response.resume();
            this._getResponse(new URL(redirectLocation, requestUrl).toString(), redirectCount + 1)
              .then(resolve, reject);
            return;
          }

          if (statusCode < 200 || statusCode >= 300) {
            response.resume();
            reject(new Error(`Download request failed with status ${statusCode}.`));
            return;
          }

          resolve(response);
        },
      );

      request.on("error", reject);
    });
  }

  async _findInstallRoot(definition, stagingDirectory) {
    if (await this._containsExpectedFiles(definition, stagingDirectory)) {
      return stagingDirectory;
    }

    const expectedSegments = definition.expectedFiles[0].split("/");
    const expectedName = expectedSegments.at(-1);
    const candidateRoots = new Set();

    const visit = async (directory) => {
      const entries = await fs.promises.readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          await visit(entryPath);
        } else if (entry.isFile() && entry.name === expectedName) {
          let candidateRoot = path.dirname(entryPath);
          for (let index = 0; index < expectedSegments.length - 1; index += 1) {
            candidateRoot = path.dirname(candidateRoot);
          }
          if (this._isWithin(stagingDirectory, candidateRoot)) {
            candidateRoots.add(candidateRoot);
          }
        }
      }
    };

    await visit(stagingDirectory);
    for (const candidateRoot of candidateRoots) {
      if (await this._containsExpectedFiles(definition, candidateRoot)) {
        return candidateRoot;
      }
    }
    return null;
  }

  async _containsExpectedFiles(definition, directory) {
    for (const relativePath of definition.expectedFiles) {
      try {
        if (!(await fs.promises.stat(path.join(directory, relativePath))).isFile()) {
          return false;
        }
      } catch {
        return false;
      }
    }
    return true;
  }

  _isWithin(parent, candidate) {
    const relative = path.relative(parent, candidate);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  }

  _setState(definition, nextState) {
    const state = {
      ...this.states.get(definition.id),
      ...nextState,
    };
    this.states.set(definition.id, state);
    const status = this._publicStatus(definition, state, this.isInstalled(definition.id));
    try {
      this.onStatusChange(status);
    } catch (error) {
      console.warn(`[resources] Unable to publish ${definition.id} status: ${error.message}`);
    }
    return status;
  }

  _publicStatus(definition, state, installed) {
    const totalBytes = state.totalBytes ?? definition.downloadSizeBytes;
    const downloadedBytes = state.downloadedBytes ?? 0;
    const progressPercent = state.state === "downloading" && totalBytes > 0
      ? Math.min(99, Math.floor((downloadedBytes / totalBytes) * 100))
      : state.state === "ready"
        ? 100
        : 0;

    return {
      id: definition.id,
      version: definition.version,
      state: state.state,
      installed,
      downloadSizeBytes: definition.downloadSizeBytes,
      downloadSizeLabel: definition.downloadSizeLabel,
      downloadedBytes,
      totalBytes,
      progressPercent,
      error: state.error ?? null,
    };
  }

  _definitionFor(id) {
    const definition = this.definitions[id];
    if (!definition) throw new Error(`Unknown resource: ${id}`);
    return definition;
  }
}

module.exports = {
  ResourceManager,
  RESOURCE_DEFINITIONS,
};
