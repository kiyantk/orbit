/**
 * embedding-worker.js
 *
 * Runs inside a Worker thread — the full EmbeddingService lives here so that
 * sharp/heic-decode conversions and DB I/O never block the main process event
 * loop.
 *
 * Message protocol (main → worker):
 *   { type: "start",        db: <serialized path>, dataDir, modelCacheDir }
 *   { type: "pause" }
 *   { type: "resume" }
 *   { type: "stop" }
 *   { type: "embedText",    text, requestId }
 *   { type: "getStatus",    requestId }
 *
 * Message protocol (worker → main):
 *   { type: "progress",     modelReady, initError, total, done, paused, percentage }
 *   { type: "textResult",   requestId, embedding }
 *   { type: "textError",    requestId, error }
 *   { type: "statusResult", requestId, ...statusFields }
 *   { type: "log",          level, message }   // forwarded to main-process console
 */

const { parentPort, workerData } = require("worker_threads");
const path     = require("path");
const fs       = require("fs");
const { fork } = require("child_process");

// ── Lazy-loaded image libs (only loaded when actually needed) ─────────────────
let sharp      = null;
let heicDecode = null;
function lazyLoadImageLibs() {
  if (!sharp)      sharp      = require("sharp");
  if (!heicDecode) heicDecode = require("heic-decode");
}

// ── Constants ─────────────────────────────────────────────────────────────────
const INTER_FILE_DELAY_MS     = 150;
const ERROR_BACKOFF_THRESHOLD = 5;
const ERROR_BACKOFF_MS        = 30_000;
const RECHECK_INTERVAL_MS     = 60_000;
const SOURCE_RETRY_DELAY_MS   = 5_000;
const CHILD_RESTART_DELAY_MS  = 8_000;
const NEEDS_CONVERSION        = new Set([".heic", ".heif", ".tif", ".tiff"]);

// ── Helpers ───────────────────────────────────────────────────────────────────
function log(level, message) {
  parentPort.postMessage({ type: "log", level, message });
}

// ── State ─────────────────────────────────────────────────────────────────────
let db            = null;
let dataDir       = null;
let modelCacheDir = null;

let child         = null;
let paused        = false;
let stopped       = false;
let running       = false;
let loopTimer     = null;

let pipelineReady     = false;
let initError         = null;
let consecutiveErrors = 0;
const skippedIds      = new Set();
const unavailableRoots = new Set();

let imagePending = null;   // { resolve, reject }
let textPending  = null;   // { resolve, reject, requestId }

let total = 0;
let done  = 0;
let deferredLoopDelayMs = null;

function isSourceDriveUnavailable(filePath) {
  const root = path.parse(filePath).root;
  if (!root || fs.existsSync(root)) {
    unavailableRoots.delete(root);
    return false;
  }

  if (!unavailableRoots.has(root)) {
    unavailableRoots.add(root);
    log(
      "warn",
      `embedding paused; source drive is unavailable. Retrying in ${SOURCE_RETRY_DELAY_MS / 1000}s: ${root}`,
    );
  }
  return true;
}

// ── DB helpers ────────────────────────────────────────────────────────────────
function ensureTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS embeddings (
      file_id    INTEGER PRIMARY KEY,
      embedding  BLOB NOT NULL,
      created_at INTEGER DEFAULT (strftime('%s', 'now'))
    )
  `);
}

function refreshCounts() {
  try {
    total = db.prepare(`SELECT COUNT(*) AS c FROM files WHERE file_type = 'image'`).get()?.c ?? 0;
    done  = db.prepare(`SELECT COUNT(*) AS c FROM embeddings`).get()?.c ?? 0;
  } catch {}
}

function getNextFile() {
  const skipped    = [...skippedIds];
  const excludeSQL = skipped.length ? `AND f.id NOT IN (${skipped.join(",")})` : "";
  return db.prepare(`
    SELECT f.id, f.path
    FROM   files f
    LEFT   JOIN embeddings e ON f.id = e.file_id
    WHERE  f.file_type = 'image'
      AND  e.file_id IS NULL
      ${excludeSQL}
    LIMIT 1
  `).get() ?? null;
}

// ── Progress emission ─────────────────────────────────────────────────────────
function emitProgress() {
  refreshCounts();
  parentPort.postMessage({
    type:       "progress",
    modelReady: pipelineReady,
    initError,
    total,
    done,
    paused,
    percentage: total > 0 ? Math.round((done / total) * 100) : 0,
  });
}

// ── HEIC / TIFF → JPEG buffer ─────────────────────────────────────────────────
async function convertToJpegBuffer(file) {
  const ext = path.extname(file.path).toLowerCase();
  try {
    lazyLoadImageLibs();
    if (ext === ".heic" || ext === ".heif") {
      const inputBuffer = fs.readFileSync(file.path);
      const heicImage   = await heicDecode({ buffer: inputBuffer });
      return await sharp(heicImage.data, {
        raw: { width: heicImage.width, height: heicImage.height, channels: 4 },
      })
        .resize(512, 512, { fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 85 })
        .toBuffer();
    }
    if (ext === ".tif" || ext === ".tiff") {
      return await sharp(file.path)
        .resize(512, 512, { fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 85 })
        .toBuffer();
    }
  } catch (err) {
    log("warn", `conversion failed for ${file.path}: ${err.message}`);
  }
  return null;
}

// ── Child process (ONNX inference) ────────────────────────────────────────────
function spawnChild() {
  const scriptPath = path.join(__dirname, "embedding-process.js");
  if (!fs.existsSync(scriptPath)) {
    initError     = "embedding-process.js not found";
    pipelineReady = false;
    emitProgress();
    return;
  }

  child = fork(scriptPath, [], { stdio: ["pipe", "pipe", "pipe", "ipc"] });

  child.stdout?.on("data", d => log("info",  `[embed-child] ${d.toString().trim()}`));
  child.stderr?.on("data", d => log("error", `[embed-child] ${d.toString().trim()}`));

  child.on("message", handleChildMessage);

  child.on("exit", (code, signal) => {
    if (stopped) return;
    log("warn", `child exited (code=${code}, signal=${signal}), restarting…`);
    pipelineReady = false;
    child         = null;
    imagePending?.reject(new Error("child exited"));
    imagePending = null;
    textPending?.reject(new Error("child exited"));
    textPending = null;
    setTimeout(() => { if (!stopped) spawnChild(); }, CHILD_RESTART_DELAY_MS);
  });

  child.on("error", err => log("error", `child process error: ${err.message}`));

  child.send({ type: "init", cacheDir: modelCacheDir });
}

function handleChildMessage(msg) {
  switch (msg.type) {

    case "ready":
      pipelineReady     = true;
      initError         = null;
      consecutiveErrors = 0;
      emitProgress();
      scheduleLoop(500);
      break;

    case "initError":
      pipelineReady = false;
      initError     = msg.error;
      emitProgress();
      break;

    case "embedResult": {
      const buffer = Buffer.from(new Float32Array(msg.embedding).buffer);
      try {
        db.prepare(
          `INSERT OR REPLACE INTO embeddings (file_id, embedding) VALUES (?, ?)`
        ).run(msg.fileId, buffer);
        consecutiveErrors = 0;
        done++;
      } catch (err) {
        log("error", `DB write error: ${err.message}`);
      }
      emitProgress();
      const ip = imagePending;
      imagePending = null;
      ip?.resolve();
      break;
    }

    case "embedError": {
      const missingFile = /404 Not Found|ENOENT|no such file/i.test(
        msg.error || "",
      );
      const file = db.prepare("SELECT path FROM files WHERE id = ?").get(msg.fileId);
      const sourceUnavailable =
        missingFile && file && isSourceDriveUnavailable(file.path);
      log(
        "warn",
        sourceUnavailable
          ? `embedding deferred for file ${msg.fileId}`
          : missingFile
          ? `embedding skipped for missing file ${msg.fileId}`
          : `embed error for file ${msg.fileId}: ${msg.error}`,
      );
      if (sourceUnavailable) {
        deferredLoopDelayMs = SOURCE_RETRY_DELAY_MS;
      } else {
        skippedIds.add(msg.fileId);
      }
      emitProgress();
      const ip2 = imagePending;
      imagePending = null;
      ip2?.resolve();
      break;
    }

    case "textResult": {
      const tp = textPending;
      textPending = null;
      parentPort.postMessage({
        type:      "textResult",
        requestId: tp?.requestId,
        embedding: msg.embedding,
      });
      tp?.resolve(msg.embedding);
      break;
    }

    case "textError": {
      const tp2 = textPending;
      textPending = null;
      parentPort.postMessage({
        type:      "textError",
        requestId: tp2?.requestId,
        error:     msg.error,
      });
      tp2?.reject(new Error(msg.error));
      break;
    }
  }
}

// ── Processing loop ───────────────────────────────────────────────────────────
function scheduleLoop(delayMs = INTER_FILE_DELAY_MS) {
  clearTimeout(loopTimer);
  if (stopped) return;
  running   = true;
  loopTimer = setTimeout(() => loop(), delayMs);
}

async function loop() {
  if (stopped || paused) { running = false; return; }
  if (!pipelineReady)    { running = false; return; }

  if (consecutiveErrors >= ERROR_BACKOFF_THRESHOLD) {
    log("warn", `${consecutiveErrors} consecutive conversion errors, backing off ${ERROR_BACKOFF_MS}ms`);
    consecutiveErrors = 0;
    scheduleLoop(ERROR_BACKOFF_MS);
    return;
  }

  const file = getNextFile();
  if (!file) {
    refreshCounts();
    emitProgress();
    running   = false;
    loopTimer = setTimeout(() => { running = true; loop(); }, RECHECK_INTERVAL_MS);
    return;
  }

  if (!fs.existsSync(file.path)) {
    if (isSourceDriveUnavailable(file.path)) {
      scheduleLoop(SOURCE_RETRY_DELAY_MS);
      return;
    }
    log("warn", `embedding skipped for missing file: ${file.path}`);
    skippedIds.add(file.id);
    scheduleLoop(INTER_FILE_DELAY_MS);
    return;
  }

  const ext = path.extname(file.path).toLowerCase();

  if (NEEDS_CONVERSION.has(ext)) {
    const imageBuffer = await convertToJpegBuffer(file);
    if (!imageBuffer) {
      if (isSourceDriveUnavailable(file.path)) {
        scheduleLoop(SOURCE_RETRY_DELAY_MS);
        return;
      }
      skippedIds.add(file.id);
      consecutiveErrors++;
      scheduleLoop(INTER_FILE_DELAY_MS);
      return;
    }
    consecutiveErrors = 0;
    await new Promise((resolve) => {
      imagePending = { resolve, reject: resolve };
      child.send({
        type:        "embed",
        fileId:      file.id,
        filePath:    file.path,
        imageBuffer: imageBuffer.toString("base64"),
      });
    });
  } else {
    await new Promise((resolve) => {
      imagePending = { resolve, reject: resolve };
      child.send({ type: "embed", fileId: file.id, filePath: file.path });
    });
  }

  const nextDelay = deferredLoopDelayMs ?? INTER_FILE_DELAY_MS;
  deferredLoopDelayMs = null;
  scheduleLoop(nextDelay);
}

// ── embedText (called on demand from main process) ────────────────────────────
function embedText(text, requestId) {
  if (!child || !pipelineReady) {
    parentPort.postMessage({
      type:      "textError",
      requestId,
      error:     "pipeline not ready",
    });
    return;
  }

  // Cancel any superseded in-flight text request
  if (textPending) {
    textPending.reject(new Error("superseded"));
    parentPort.postMessage({
      type:      "textError",
      requestId: textPending.requestId,
      error:     "superseded",
    });
    textPending = null;
  }

  textPending = {
    requestId,
    resolve: () => {},
    reject:  () => {},
  };

  child.send({ type: "embedText", text });
}

// ── Main-thread message handler ───────────────────────────────────────────────
parentPort.on("message", async (msg) => {
  switch (msg.type) {

    case "start": {
      // Receive DB path and open it here in the worker
      const Database = require("better-sqlite3");
      db            = new Database(msg.dbPath);
      dataDir       = msg.dataDir;
      modelCacheDir = msg.modelCacheDir;
      ensureTable();
      spawnChild();
      break;
    }

    case "pause":
      paused = true;
      break;

    case "resume":
      if (paused) {
        paused = false;
        scheduleLoop(100);
      }
      break;

    case "stop":
      stopped = true;
      paused  = false;
      clearTimeout(loopTimer);
      running = false;
      if (child) {
        try { child.send({ type: "stop" }); } catch {}
        setTimeout(() => { try { child.kill(); } catch {} }, 1000);
        child = null;
      }
      imagePending?.reject(new Error("stopped"));
      imagePending = null;
      textPending?.reject(new Error("stopped"));
      textPending = null;
      break;

    case "embedText":
      embedText(msg.text, msg.requestId);
      break;

    case "getStatus": {
      refreshCounts();
      parentPort.postMessage({
        type:       "statusResult",
        requestId:  msg.requestId,
        modelReady: pipelineReady,
        initError,
        total,
        done,
        paused,
        stopped,
        percentage: total > 0 ? Math.round((done / total) * 100) : 0,
      });
      break;
    }
  }
});
