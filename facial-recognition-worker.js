/**
 * SQLite queue and conservative People clustering for local InsightFace
 * indexing. ONNX/Sharp inference is intentionally delegated to a child
 * process so native model failures cannot terminate Electron.
 */
const { parentPort } = require("worker_threads");
const { fork } = require("child_process");
const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");
const {
  FACE_PIPELINE_VERSION,
  FACE_EMBEDDING_VERSION,
  FACE_METADATA_TABLE,
  FACE_SCAN_TABLE,
  FACE_TABLE,
  PEOPLE_TABLE,
  FACE_ASSIGNMENT_TABLE,
  PERSON_REPRESENTATIVE_TABLE,
} = require("./facial-recognition-schema");

const RECHECK_INTERVAL_MS = 60_000;
const INTER_FILE_DELAY_MS = 350;
const SOURCE_RETRY_DELAY_MS = 5_000;
const MAX_REPRESENTATIVES_PER_PERSON = 6;
// These deliberately conservative values are a starting point for the local
// gallery. They are stored separately from embeddings so they can be retuned
// and regrouped without another neural-network scan.
const STRONG_MATCH_THRESHOLD = 0.70;
const CONSISTENT_MATCH_THRESHOLD = 0.64;
const SECONDARY_MATCH_THRESHOLD = 0.54;

let db = null;
let child = null;
let modelDirectory = null;
let paused = false;
let stopped = false;
let modelReady = false;
let initError = null;
let pending = null;
let loopTimer = null;
let total = 0;
let done = 0;
let faceCount = 0;
let peopleCount = 0;
const unavailableRoots = new Set();
const personRepresentatives = new Map();

function log(level, message) {
  parentPort.postMessage({ type: "log", level, message });
}

function tableExists(name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

function ensureSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${FACE_METADATA_TABLE} (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ${FACE_SCAN_TABLE} (
      file_id INTEGER PRIMARY KEY,
      pipeline_version TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'completed',
      face_count INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      scanned_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
    );
    CREATE TABLE IF NOT EXISTS ${FACE_TABLE} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id INTEGER NOT NULL,
      box_left REAL NOT NULL,
      box_top REAL NOT NULL,
      box_width REAL NOT NULL,
      box_height REAL NOT NULL,
      landmarks BLOB NOT NULL,
      detector_confidence REAL NOT NULL,
      recognition_quality REAL NOT NULL DEFAULT 0,
      embedding BLOB,
      embedding_version TEXT,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
    );
    CREATE TABLE IF NOT EXISTS ${PEOPLE_TABLE} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      cover_face_id INTEGER,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
      hidden INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS ${FACE_ASSIGNMENT_TABLE} (
      face_id INTEGER PRIMARY KEY,
      person_id INTEGER NOT NULL,
      score REAL,
      assigned_by TEXT NOT NULL DEFAULT 'auto',
      assigned_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
    );
    CREATE TABLE IF NOT EXISTS ${PERSON_REPRESENTATIVE_TABLE} (
      person_id INTEGER NOT NULL,
      face_id INTEGER NOT NULL UNIQUE,
      quality REAL NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
      PRIMARY KEY (person_id, face_id)
    );
    CREATE INDEX IF NOT EXISTS idx_face_scans_version ON ${FACE_SCAN_TABLE}(pipeline_version, status);
    CREATE INDEX IF NOT EXISTS idx_faces_file ON ${FACE_TABLE}(file_id);
    CREATE INDEX IF NOT EXISTS idx_faces_embedding_version ON ${FACE_TABLE}(embedding_version);
    CREATE INDEX IF NOT EXISTS idx_face_assignments_person ON ${FACE_ASSIGNMENT_TABLE}(person_id);
    CREATE INDEX IF NOT EXISTS idx_person_representatives_person ON ${PERSON_REPRESENTATIVE_TABLE}(person_id);
  `);

  const current = db.prepare(`SELECT value FROM ${FACE_METADATA_TABLE} WHERE key = 'pipeline_version'`).get()?.value;
  if (current !== FACE_PIPELINE_VERSION) {
    db.transaction(() => {
      db.exec(`DELETE FROM ${FACE_ASSIGNMENT_TABLE}; DELETE FROM ${PERSON_REPRESENTATIVE_TABLE}; DELETE FROM ${FACE_TABLE}; DELETE FROM ${FACE_SCAN_TABLE}; DELETE FROM ${PEOPLE_TABLE};`);
      db.prepare(`
        INSERT INTO ${FACE_METADATA_TABLE}(key, value) VALUES ('pipeline_version', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(FACE_PIPELINE_VERSION);
    })();
  }
}

function refreshCounts() {
  total = db.prepare("SELECT COUNT(*) AS count FROM files WHERE file_type = 'image'").get()?.count ?? 0;
  done = db.prepare(`
    SELECT COUNT(*) AS count FROM ${FACE_SCAN_TABLE}
    WHERE pipeline_version = ? AND status = 'completed'
  `).get(FACE_PIPELINE_VERSION)?.count ?? 0;
  faceCount = db.prepare(`SELECT COUNT(*) AS count FROM ${FACE_TABLE}`).get()?.count ?? 0;
  peopleCount = db.prepare(`SELECT COUNT(*) AS count FROM ${PEOPLE_TABLE} WHERE hidden = 0`).get()?.count ?? 0;
}

function emitProgress() {
  if (db) refreshCounts();
  parentPort.postMessage({
    type: "progress",
    modelReady,
    initError,
    total,
    done,
    faces: faceCount,
    people: peopleCount,
    paused,
    percentage: total > 0 ? Math.round((done / total) * 100) : 0,
  });
}

function loadPersonRepresentatives() {
  personRepresentatives.clear();
  const rows = db.prepare(`
    SELECT r.person_id, r.face_id, f.embedding, r.quality
    FROM ${PERSON_REPRESENTATIVE_TABLE} r
    JOIN ${FACE_TABLE} f ON f.id = r.face_id
    WHERE f.embedding IS NOT NULL AND f.embedding_version = ?
  `).all(FACE_EMBEDDING_VERSION);
  for (const row of rows) {
    const embedding = float32FromBlob(row.embedding);
    if (embedding.length !== 512) continue;
    const entries = personRepresentatives.get(row.person_id) ?? [];
    entries.push({ faceId: row.face_id, quality: row.quality, embedding });
    personRepresentatives.set(row.person_id, entries);
  }
}

function float32FromBlob(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value ?? []);
  return new Float32Array(buffer.buffer, buffer.byteOffset, Math.floor(buffer.byteLength / 4));
}

function blobFromEmbedding(embedding) {
  const data = Float32Array.from(embedding);
  return Buffer.from(data.buffer);
}

function cosineSimilarity(left, right) {
  let total = 0;
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) total += left[index] * right[index];
  return total;
}

function bestPersonMatch(embedding) {
  let selected = null;
  for (const [personId, representatives] of personRepresentatives) {
    const scores = representatives
      .map((representative) => cosineSimilarity(embedding, representative.embedding))
      .sort((a, b) => b - a);
    const best = scores[0] ?? -1;
    const second = scores[1] ?? -1;
    // A single exceptionally strong match can join a group. Otherwise demand
    // corroboration from a second representative to resist transitive merges.
    const accepted = best >= STRONG_MATCH_THRESHOLD ||
      (scores.length >= 2 && best >= CONSISTENT_MATCH_THRESHOLD && second >= SECONDARY_MATCH_THRESHOLD);
    if (accepted && (!selected || best > selected.score)) {
      selected = { personId, score: best };
    }
  }
  return selected;
}

function addRepresentative(personId, faceId, quality, embedding) {
  const representatives = personRepresentatives.get(personId) ?? [];
  if (representatives.length >= MAX_REPRESENTATIVES_PER_PERSON) return;
  db.prepare(`
    INSERT OR IGNORE INTO ${PERSON_REPRESENTATIVE_TABLE}(person_id, face_id, quality)
    VALUES (?, ?, ?)
  `).run(personId, faceId, quality);
  representatives.push({ faceId, quality, embedding: Float32Array.from(embedding) });
  personRepresentatives.set(personId, representatives);
}

function assignFace(faceId, quality, embedding) {
  const match = bestPersonMatch(embedding);
  let personId = match?.personId;
  if (!personId) {
    const result = db.prepare(`INSERT INTO ${PEOPLE_TABLE}(cover_face_id) VALUES (?)`).run(faceId);
    personId = result.lastInsertRowid;
  }
  db.prepare(`
    INSERT INTO ${FACE_ASSIGNMENT_TABLE}(face_id, person_id, score, assigned_by)
    VALUES (?, ?, ?, 'auto')
  `).run(faceId, personId, match?.score ?? null);

  const cover = db.prepare(`
    SELECT f.recognition_quality AS quality
    FROM ${PEOPLE_TABLE} p JOIN ${FACE_TABLE} f ON f.id = p.cover_face_id
    WHERE p.id = ?
  `).get(personId);
  if (!cover || quality > (cover.quality ?? -1)) {
    db.prepare(`UPDATE ${PEOPLE_TABLE} SET cover_face_id = ?, updated_at = strftime('%s', 'now') WHERE id = ?`).run(faceId, personId);
  }
  addRepresentative(personId, faceId, quality, embedding);
}

function deleteFacesForFile(fileId) {
  const ids = db.prepare(`SELECT id FROM ${FACE_TABLE} WHERE file_id = ?`).all(fileId).map((row) => row.id);
  if (!ids.length) return;
  const placeholders = ids.map(() => "?").join(",");
  db.prepare(`DELETE FROM ${FACE_ASSIGNMENT_TABLE} WHERE face_id IN (${placeholders})`).run(...ids);
  db.prepare(`DELETE FROM ${PERSON_REPRESENTATIVE_TABLE} WHERE face_id IN (${placeholders})`).run(...ids);
  db.prepare(`DELETE FROM ${FACE_TABLE} WHERE id IN (${placeholders})`).run(...ids);
}

function deleteOrphanedPeople() {
  db.prepare(`
    UPDATE ${PEOPLE_TABLE}
    SET cover_face_id = (
      SELECT a.face_id
      FROM ${FACE_ASSIGNMENT_TABLE} a
      JOIN ${FACE_TABLE} f ON f.id = a.face_id
      WHERE a.person_id = ${PEOPLE_TABLE}.id
      ORDER BY f.recognition_quality DESC, f.id ASC
      LIMIT 1
    )
    WHERE cover_face_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM ${FACE_TABLE} f WHERE f.id = ${PEOPLE_TABLE}.cover_face_id
    )
  `).run();
  db.prepare(`
    DELETE FROM ${PEOPLE_TABLE}
    WHERE NOT EXISTS (
      SELECT 1 FROM ${FACE_ASSIGNMENT_TABLE} a WHERE a.person_id = ${PEOPLE_TABLE}.id
    )
  `).run();
}

function storeResult(result, error = null) {
  const faces = Array.isArray(result.faces) ? result.faces : [];
  db.transaction(() => {
    deleteFacesForFile(result.fileId);
    const insertFace = db.prepare(`
      INSERT INTO ${FACE_TABLE}(
        file_id, box_left, box_top, box_width, box_height, landmarks,
        detector_confidence, recognition_quality, embedding, embedding_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const face of faces) {
      const landmarks = Array.isArray(face.landmarks) ? face.landmarks.flat() : [];
      const inserted = insertFace.run(
        result.fileId,
        face.box.left,
        face.box.top,
        face.box.width,
        face.box.height,
        Buffer.from(new Float32Array(landmarks).buffer),
        face.detectorConfidence,
        face.quality ?? 0,
        Array.isArray(face.embedding) ? blobFromEmbedding(face.embedding) : null,
        Array.isArray(face.embedding) ? FACE_EMBEDDING_VERSION : null,
      );
      if (Array.isArray(face.embedding) && face.embedding.length === 512) {
        assignFace(Number(inserted.lastInsertRowid), face.quality ?? 0, face.embedding);
      }
    }
    db.prepare(`
      INSERT INTO ${FACE_SCAN_TABLE}(file_id, pipeline_version, status, face_count, error, scanned_at)
      VALUES (?, ?, 'completed', ?, ?, strftime('%s', 'now'))
      ON CONFLICT(file_id) DO UPDATE SET
        pipeline_version = excluded.pipeline_version, status = excluded.status,
        face_count = excluded.face_count, error = excluded.error, scanned_at = excluded.scanned_at
    `).run(result.fileId, FACE_PIPELINE_VERSION, faces.length, error);
    deleteOrphanedPeople();
  })();
  loadPersonRepresentatives();
}

function nextFile() {
  return db.prepare(`
    SELECT f.id, f.path FROM files f
    LEFT JOIN ${FACE_SCAN_TABLE} s
      ON s.file_id = f.id AND s.pipeline_version = ? AND s.status = 'completed'
    WHERE f.file_type = 'image' AND s.file_id IS NULL
    ORDER BY f.id LIMIT 1
  `).get(FACE_PIPELINE_VERSION) ?? null;
}

function isSourceDriveUnavailable(filePath) {
  const root = path.parse(filePath).root;
  if (!root || fs.existsSync(root)) {
    unavailableRoots.delete(root);
    return false;
  }
  if (!unavailableRoots.has(root)) {
    unavailableRoots.add(root);
    log("warn", `Facial recognition deferred; source drive is unavailable: ${root}`);
  }
  return true;
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
    if (isSourceDriveUnavailable(file.path)) {
      schedule(SOURCE_RETRY_DELAY_MS);
      return;
    }
    log("warn", `Facial recognition skipped missing file: ${file.path}`);
    storeResult({ fileId: file.id, faces: [] }, "File no longer exists");
    emitProgress();
    schedule();
    return;
  }
  pending = file;
  child.send({ type: "detect", fileId: file.id, filePath: file.path });
}

function startChild() {
  child = fork(path.join(__dirname, "facial-recognition-process.js"), [], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  child.stdout?.on("data", (data) => log("info", `[face-child] ${data.toString().trim()}`));
  child.stderr?.on("data", (data) => log("error", `[face-child] ${data.toString().trim()}`));
  child.on("message", (message) => {
    if (message.type === "ready") {
      modelReady = true;
      initError = null;
      emitProgress();
      schedule(250);
    } else if (message.type === "initError") {
      modelReady = false;
      initError = message.error || "Unable to load facial-recognition models";
      emitProgress();
    } else if (message.type === "result") {
      const active = pending;
      pending = null;
      try {
        storeResult(message);
      } catch (error) {
        log("error", `Facial recognition database write failed: ${error.message}`);
      }
      emitProgress();
      schedule(active && isSourceDriveUnavailable(active.path) ? SOURCE_RETRY_DELAY_MS : INTER_FILE_DELAY_MS);
    } else if (message.type === "detectError") {
      const active = pending;
      pending = null;
      if (active && !isSourceDriveUnavailable(active.path)) {
        log("warn", `Facial recognition failed for ${active.path}: ${message.error}`);
        try { storeResult({ fileId: active.id, faces: [] }, message.error); } catch (error) {
          log("error", `Unable to store facial-recognition failure: ${error.message}`);
        }
      }
      emitProgress();
      schedule(active && isSourceDriveUnavailable(active.path) ? SOURCE_RETRY_DELAY_MS : INTER_FILE_DELAY_MS);
    }
  });
  child.on("exit", (code) => {
    child = null;
    pending = null;
    if (!stopped) {
      modelReady = false;
      initError = `Facial-recognition inference process exited (${code ?? "unknown"})`;
      emitProgress();
      setTimeout(() => !stopped && startChild(), 5_000);
    }
  });
  child.send({ type: "init", modelDirectory });
}

function rebuild() {
  clearTimeout(loopTimer);
  db.transaction(() => {
    db.exec(`DELETE FROM ${FACE_ASSIGNMENT_TABLE}; DELETE FROM ${PERSON_REPRESENTATIVE_TABLE}; DELETE FROM ${FACE_TABLE}; DELETE FROM ${FACE_SCAN_TABLE}; DELETE FROM ${PEOPLE_TABLE};`);
  })();
  loadPersonRepresentatives();
  emitProgress();
  // Let an already-running inference finish before scheduling the next job;
  // the child process intentionally handles one photo at a time.
  if (!paused && modelReady && !pending) schedule(100);
}

parentPort.on("message", (message) => {
  if (message.type === "start") {
    try {
      db = new Database(message.dbPath);
      modelDirectory = message.modelDirectory;
      ensureSchema();
      loadPersonRepresentatives();
      startChild();
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
  } else if (message.type === "rebuild") {
    rebuild();
  } else if (message.type === "stop") {
    stopped = true;
    clearTimeout(loopTimer);
    try { child?.send({ type: "stop" }); } catch {}
    try { db?.close(); } catch {}
  }
});
