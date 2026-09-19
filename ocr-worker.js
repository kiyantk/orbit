/**
 * Background queue and SQLite writer for the PaddleOCR index. Inference runs
 * in a child process so a native ONNX failure cannot take Electron down.
 */
const { parentPort } = require("worker_threads");
const { fork } = require("child_process");
const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");
const {
  OCR_PIPELINE_VERSION,
  OCR_METADATA_TABLE,
  OCR_INDEX_TABLE,
  OCR_FTS_TABLE,
} = require("./ocr-schema");

const RECHECK_INTERVAL_MS = 60_000;
// Yield briefly between jobs. CPU is capped in the inference process, so a
// longer pause only slows indexing without lowering its peak CPU use further.
const INTER_FILE_DELAY_MS = 250;
const SOURCE_RETRY_DELAY_MS = 5_000;

let db = null;
let child = null;
let paused = false;
let stopped = false;
let modelReady = false;
let initError = null;
let total = 0;
let done = 0;
let loopTimer = null;
let pending = null;
let modelDirectory = null;
const unavailableRoots = new Set();

function log(level, message) {
  parentPort.postMessage({ type: "log", level, message });
}

function tableExists(name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

function ensureSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${OCR_METADATA_TABLE} (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ${OCR_INDEX_TABLE} (
      file_id INTEGER PRIMARY KEY,
      text TEXT NOT NULL,
      boxes BLOB NOT NULL,
      box_count INTEGER NOT NULL DEFAULT 0,
      mean_confidence REAL,
      model_version TEXT NOT NULL,
      indexed_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
    );
  `);

  if (!tableExists(OCR_FTS_TABLE)) {
    db.exec(`
      CREATE VIRTUAL TABLE ${OCR_FTS_TABLE} USING fts5(
        text,
        content='${OCR_INDEX_TABLE}',
        content_rowid='file_id',
        tokenize='unicode61 remove_diacritics 2'
      );
      CREATE TRIGGER ocr_index_ai AFTER INSERT ON ${OCR_INDEX_TABLE} BEGIN
        INSERT INTO ${OCR_FTS_TABLE}(rowid, text) VALUES (new.file_id, new.text);
      END;
      CREATE TRIGGER ocr_index_ad AFTER DELETE ON ${OCR_INDEX_TABLE} BEGIN
        INSERT INTO ${OCR_FTS_TABLE}(${OCR_FTS_TABLE}, rowid, text)
          VALUES ('delete', old.file_id, old.text);
      END;
      CREATE TRIGGER ocr_index_au AFTER UPDATE ON ${OCR_INDEX_TABLE} BEGIN
        INSERT INTO ${OCR_FTS_TABLE}(${OCR_FTS_TABLE}, rowid, text)
          VALUES ('delete', old.file_id, old.text);
        INSERT INTO ${OCR_FTS_TABLE}(rowid, text) VALUES (new.file_id, new.text);
      END;
    `);
  }

  const currentVersion = db.prepare(`SELECT value FROM ${OCR_METADATA_TABLE} WHERE key = 'pipeline_version'`).get()?.value;
  if (currentVersion !== OCR_PIPELINE_VERSION) {
    db.transaction(() => {
      db.exec(`DELETE FROM ${OCR_INDEX_TABLE}`);
      db.prepare(`
        INSERT INTO ${OCR_METADATA_TABLE}(key, value) VALUES ('pipeline_version', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(OCR_PIPELINE_VERSION);
    })();
  }
}

function refreshCounts() {
  total = db.prepare("SELECT COUNT(*) AS c FROM files WHERE file_type = 'image'").get()?.c ?? 0;
  done = db.prepare(`
    SELECT COUNT(*) AS c FROM files f
    JOIN ${OCR_INDEX_TABLE} i ON i.file_id = f.id
    WHERE f.file_type = 'image' AND i.model_version = ?
  `).get(OCR_PIPELINE_VERSION)?.c ?? 0;
}

function emitProgress() {
  if (db) refreshCounts();
  parentPort.postMessage({
    type: "progress", modelReady, initError, total, done, paused,
    percentage: total > 0 ? Math.round((done / total) * 100) : 0,
  });
}

function nextFile() {
  return db.prepare(`
    SELECT f.id, f.path FROM files f
    LEFT JOIN ${OCR_INDEX_TABLE} i
      ON i.file_id = f.id AND i.model_version = ?
    WHERE f.file_type = 'image' AND i.file_id IS NULL
    ORDER BY f.id LIMIT 1
  `).get(OCR_PIPELINE_VERSION) ?? null;
}

function isSourceDriveUnavailable(filePath) {
  const root = path.parse(filePath).root;
  if (!root || fs.existsSync(root)) {
    unavailableRoots.delete(root);
    return false;
  }
  if (!unavailableRoots.has(root)) {
    unavailableRoots.add(root);
    log("warn", `OCR deferred; source drive is unavailable: ${root}`);
  }
  return true;
}

function encodeBoxes(boxes) {
  const encoded = new Uint16Array(boxes.length * 8);
  boxes.forEach((box, index) => {
    box.points.flat().forEach((value, pointIndex) => {
      encoded[index * 8 + pointIndex] = Math.max(0, Math.min(65535, Math.round(value * 65535)));
    });
  });
  return Buffer.from(encoded.buffer);
}

function storeResult(result) {
  // Ignore low-value one-character detections but retain an empty completion
  // row if no useful text remains, so the image is not queued forever.
  const boxes = (Array.isArray(result.boxes) ? result.boxes : []).filter((box) =>
    Array.from(String(box?.text ?? "").trim()).length > 1,
  );
  const text = boxes.map((box) => box.text).filter(Boolean).join("\n");
  const confidence = boxes.length
    ? boxes.reduce((sum, box) => sum + (Number(box.confidence) || 0), 0) / boxes.length
    : null;
  db.prepare(`
    INSERT INTO ${OCR_INDEX_TABLE}
      (file_id, text, boxes, box_count, mean_confidence, model_version, indexed_at)
    VALUES (?, ?, ?, ?, ?, ?, strftime('%s', 'now'))
    ON CONFLICT(file_id) DO UPDATE SET
      text = excluded.text, boxes = excluded.boxes, box_count = excluded.box_count,
      mean_confidence = excluded.mean_confidence, model_version = excluded.model_version,
      indexed_at = excluded.indexed_at
  `).run(result.fileId, text, encodeBoxes(boxes), boxes.length, confidence, OCR_PIPELINE_VERSION);
}

function schedule(delay = INTER_FILE_DELAY_MS) {
  clearTimeout(loopTimer);
  if (!stopped) loopTimer = setTimeout(processNext, delay);
}

function processNext() {
  if (stopped || paused || !modelReady || pending) return;
  const file = nextFile();
  if (!file) {
    emitProgress();
    schedule(RECHECK_INTERVAL_MS);
    return;
  }
  if (!fs.existsSync(file.path)) {
    if (isSourceDriveUnavailable(file.path)) schedule(SOURCE_RETRY_DELAY_MS);
    else {
      log("warn", `OCR skipped missing file: ${file.path}`);
      try { storeResult({ fileId: file.id, boxes: [] }); } catch {}
      emitProgress();
      schedule();
    }
    return;
  }
  pending = file;
  child.send({ type: "ocr", fileId: file.id, filePath: file.path });
}

function startChild(modelDirectory) {
  child = fork(path.join(__dirname, "ocr-process.js"), [], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  child.stdout?.on("data", (data) => log("info", `[ocr-child] ${data.toString().trim()}`));
  child.stderr?.on("data", (data) => log("error", `[ocr-child] ${data.toString().trim()}`));
  child.on("message", (message) => {
    if (message.type === "ready") {
      modelReady = true;
      initError = null;
      emitProgress();
      schedule(250);
    } else if (message.type === "initError") {
      initError = message.error || "Unable to load OCR models";
      modelReady = false;
      emitProgress();
    } else if (message.type === "result") {
      try {
        storeResult(message);
      } catch (error) {
        log("error", `OCR database write failed: ${error.message}`);
      }
      pending = null;
      emitProgress();
      schedule();
    } else if (message.type === "ocrError") {
      const file = pending;
      pending = null;
      if (file && !isSourceDriveUnavailable(file.path)) {
        // Store an empty result for readable-but-unsupported images. This keeps
        // the queue progressing; a pipeline-version update will retry it.
        log("warn", `OCR failed for ${file.path}: ${message.error}`);
        try { storeResult({ fileId: file.id, boxes: [] }); } catch {}
      }
      emitProgress();
      schedule(file && isSourceDriveUnavailable(file.path) ? SOURCE_RETRY_DELAY_MS : INTER_FILE_DELAY_MS);
    }
  });
  child.on("exit", (code) => {
    child = null;
    pending = null;
    if (!stopped) {
      modelReady = false;
      initError = `OCR inference process exited (${code ?? "unknown"})`;
      emitProgress();
      setTimeout(() => !stopped && startChild(modelDirectory), 5_000);
    }
  });
  child.send({ type: "init", modelDirectory });
}

parentPort.on("message", (message) => {
  if (message.type === "start") {
    try {
      db = new Database(message.dbPath);
      ensureSchema();
      modelDirectory = message.modelDirectory;
      startChild(message.modelDirectory);
      emitProgress();
    } catch (error) {
      initError = error.message;
      emitProgress();
      throw error;
    }
  } else if (message.type === "pause") {
    paused = true;
    emitProgress();
  } else if (message.type === "resume") {
    paused = false;
    emitProgress();
    schedule(50);
  } else if (message.type === "stop") {
    stopped = true;
    clearTimeout(loopTimer);
    try { child?.send({ type: "stop" }); } catch {}
    try { db?.close(); } catch {}
  }
});
