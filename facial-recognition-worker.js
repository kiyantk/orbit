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
  MANUAL_PERSON_TABLE,
  MANUAL_PERSON_FACE_TABLE,
  PERSON_EXCLUSION_TABLE,
  FACE_SUGGESTION_TABLE,
  IGNORED_FACE_TABLE,
  HIDDEN_MANUAL_PERSON_TABLE,
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
const SUGGESTION_MATCH_THRESHOLD = 0.58;

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
    CREATE TABLE IF NOT EXISTS ${MANUAL_PERSON_TABLE} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      avatar_face_id INTEGER,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
    );
    CREATE TABLE IF NOT EXISTS ${MANUAL_PERSON_FACE_TABLE} (
      manual_person_id INTEGER NOT NULL,
      face_id INTEGER NOT NULL UNIQUE,
      PRIMARY KEY (manual_person_id, face_id)
    );
    CREATE TABLE IF NOT EXISTS ${PERSON_EXCLUSION_TABLE} (
      left_manual_person_id INTEGER NOT NULL,
      right_manual_person_id INTEGER NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
      PRIMARY KEY (left_manual_person_id, right_manual_person_id),
      CHECK (left_manual_person_id < right_manual_person_id)
    );
    CREATE TABLE IF NOT EXISTS ${FACE_SUGGESTION_TABLE} (
      face_id INTEGER PRIMARY KEY,
      candidate_face_id INTEGER NOT NULL,
      score REAL NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
    );
    CREATE TABLE IF NOT EXISTS ${IGNORED_FACE_TABLE} (
      face_id INTEGER PRIMARY KEY,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
    );
    CREATE TABLE IF NOT EXISTS ${HIDDEN_MANUAL_PERSON_TABLE} (
      manual_person_id INTEGER PRIMARY KEY,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
    );
    CREATE INDEX IF NOT EXISTS idx_face_scans_version ON ${FACE_SCAN_TABLE}(pipeline_version, status);
    CREATE INDEX IF NOT EXISTS idx_faces_file ON ${FACE_TABLE}(file_id);
    CREATE INDEX IF NOT EXISTS idx_faces_embedding_version ON ${FACE_TABLE}(embedding_version);
    CREATE INDEX IF NOT EXISTS idx_face_assignments_person ON ${FACE_ASSIGNMENT_TABLE}(person_id);
    CREATE INDEX IF NOT EXISTS idx_person_representatives_person ON ${PERSON_REPRESENTATIVE_TABLE}(person_id);
    CREATE INDEX IF NOT EXISTS idx_manual_person_faces_person ON ${MANUAL_PERSON_FACE_TABLE}(manual_person_id);
    CREATE INDEX IF NOT EXISTS idx_face_suggestions_candidate ON ${FACE_SUGGESTION_TABLE}(candidate_face_id);
  `);

  const manualPersonColumns = db.prepare(`PRAGMA table_info(${MANUAL_PERSON_TABLE})`).all();
  if (!manualPersonColumns.some((column) => column.name === "name")) {
    db.exec(`ALTER TABLE ${MANUAL_PERSON_TABLE} ADD COLUMN name TEXT`);
  }
  if (!manualPersonColumns.some((column) => column.name === "avatar_face_id")) {
    db.exec(`ALTER TABLE ${MANUAL_PERSON_TABLE} ADD COLUMN avatar_face_id INTEGER`);
  }

  const current = db.prepare(`SELECT value FROM ${FACE_METADATA_TABLE} WHERE key = 'pipeline_version'`).get()?.value;
  if (current !== FACE_PIPELINE_VERSION) {
    db.transaction(() => {
      db.exec(`DELETE FROM ${FACE_ASSIGNMENT_TABLE}; DELETE FROM ${PERSON_REPRESENTATIVE_TABLE}; DELETE FROM ${FACE_SUGGESTION_TABLE}; DELETE FROM ${IGNORED_FACE_TABLE}; DELETE FROM ${HIDDEN_MANUAL_PERSON_TABLE}; DELETE FROM ${MANUAL_PERSON_FACE_TABLE}; DELETE FROM ${PERSON_EXCLUSION_TABLE}; DELETE FROM ${MANUAL_PERSON_TABLE}; DELETE FROM ${FACE_TABLE}; DELETE FROM ${FACE_SCAN_TABLE}; DELETE FROM ${PEOPLE_TABLE};`);
      db.prepare(`
        INSERT INTO ${FACE_METADATA_TABLE}(key, value) VALUES ('pipeline_version', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(FACE_PIPELINE_VERSION);
    })();
  }
  restoreCustomAvatarCovers();
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

function findPersonMatches(embedding) {
  let acceptedMatch = null;
  let closestMatch = null;
  for (const [personId, representatives] of personRepresentatives) {
    const scores = representatives
      .map((representative) => ({ representative, score: cosineSimilarity(embedding, representative.embedding) }))
      .sort((a, b) => b.score - a.score);
    const best = scores[0]?.score ?? -1;
    const second = scores[1]?.score ?? -1;
    const representative = scores[0]?.representative;
    if (!closestMatch || best > closestMatch.score) {
      closestMatch = { personId, faceId: representative?.faceId ?? null, score: best };
    }
    // A single exceptionally strong match can join a group. Otherwise demand
    // corroboration from a second representative to resist transitive merges.
    const accepted = best >= STRONG_MATCH_THRESHOLD ||
      (scores.length >= 2 && best >= CONSISTENT_MATCH_THRESHOLD && second >= SECONDARY_MATCH_THRESHOLD);
    if (accepted && (!acceptedMatch || best > acceptedMatch.score)) {
      acceptedMatch = { personId, faceId: representative?.faceId ?? null, score: best };
    }
  }
  return { acceptedMatch, closestMatch };
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

function assignFaceToPerson(faceId, personId, quality, embedding, assignedBy = "auto", score = null, preserveCover = false) {
  db.prepare(`
    INSERT INTO ${FACE_ASSIGNMENT_TABLE}(face_id, person_id, score, assigned_by)
    VALUES (?, ?, ?, ?)
  `).run(faceId, personId, score, assignedBy);

  const cover = db.prepare(`
    SELECT f.recognition_quality AS quality
    FROM ${PEOPLE_TABLE} p JOIN ${FACE_TABLE} f ON f.id = p.cover_face_id
    WHERE p.id = ?
  `).get(personId);
  // A user-selected avatar is stored with the manual person record. Restore it
  // explicitly in case an older automatic assignment had replaced the cover.
  const customAvatarFaceId = getCustomAvatarFaceId(personId);
  if (customAvatarFaceId) {
    db.prepare(`UPDATE ${PEOPLE_TABLE} SET cover_face_id = ?, updated_at = strftime('%s', 'now') WHERE id = ?`).run(customAvatarFaceId, personId);
  } else if (!preserveCover && (!cover || quality > (cover.quality ?? -1))) {
    db.prepare(`UPDATE ${PEOPLE_TABLE} SET cover_face_id = ?, updated_at = strftime('%s', 'now') WHERE id = ?`).run(faceId, personId);
  }
  addRepresentative(personId, faceId, quality, embedding);
}

function assignFace(faceId, quality, embedding, recordSuggestion = true) {
  const { acceptedMatch, closestMatch } = findPersonMatches(embedding);
  let personId = acceptedMatch?.personId;
  if (!personId) {
    const result = db.prepare(`INSERT INTO ${PEOPLE_TABLE}(cover_face_id) VALUES (?)`).run(faceId);
    personId = result.lastInsertRowid;
    if (recordSuggestion && closestMatch?.faceId && closestMatch.score >= SUGGESTION_MATCH_THRESHOLD) {
      db.prepare(`
        INSERT INTO ${FACE_SUGGESTION_TABLE}(face_id, candidate_face_id, score)
        VALUES (?, ?, ?)
        ON CONFLICT(face_id) DO UPDATE SET candidate_face_id = excluded.candidate_face_id, score = excluded.score
      `).run(faceId, closestMatch.faceId, closestMatch.score);
    }
  }
  assignFaceToPerson(faceId, personId, quality, embedding, "auto", acceptedMatch?.score ?? null);
}

function deleteFacesForFile(fileId) {
  const ids = db.prepare(`SELECT id FROM ${FACE_TABLE} WHERE file_id = ?`).all(fileId).map((row) => row.id);
  if (!ids.length) return;
  const placeholders = ids.map(() => "?").join(",");
  db.prepare(`DELETE FROM ${FACE_ASSIGNMENT_TABLE} WHERE face_id IN (${placeholders})`).run(...ids);
  db.prepare(`DELETE FROM ${PERSON_REPRESENTATIVE_TABLE} WHERE face_id IN (${placeholders})`).run(...ids);
  db.prepare(`DELETE FROM ${FACE_SUGGESTION_TABLE} WHERE face_id IN (${placeholders}) OR candidate_face_id IN (${placeholders})`).run(...ids, ...ids);
  db.prepare(`DELETE FROM ${IGNORED_FACE_TABLE} WHERE face_id IN (${placeholders})`).run(...ids);
  db.prepare(`UPDATE ${MANUAL_PERSON_TABLE} SET avatar_face_id = NULL WHERE avatar_face_id IN (${placeholders})`).run(...ids);
  db.prepare(`DELETE FROM ${MANUAL_PERSON_FACE_TABLE} WHERE face_id IN (${placeholders})`).run(...ids);
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
      SELECT 1
      FROM ${FACE_ASSIGNMENT_TABLE} assignment
      WHERE assignment.person_id = ${PEOPLE_TABLE}.id
        AND assignment.face_id = ${PEOPLE_TABLE}.cover_face_id
    )
  `).run();
  db.prepare(`
    DELETE FROM ${PEOPLE_TABLE}
    WHERE NOT EXISTS (
      SELECT 1 FROM ${FACE_ASSIGNMENT_TABLE} a WHERE a.person_id = ${PEOPLE_TABLE}.id
    )
  `).run();
  db.prepare(`
    DELETE FROM ${PERSON_EXCLUSION_TABLE}
    WHERE NOT EXISTS (SELECT 1 FROM ${MANUAL_PERSON_FACE_TABLE} f WHERE f.manual_person_id = left_manual_person_id)
       OR NOT EXISTS (SELECT 1 FROM ${MANUAL_PERSON_FACE_TABLE} f WHERE f.manual_person_id = right_manual_person_id)
  `).run();
  db.prepare(`
    DELETE FROM ${MANUAL_PERSON_TABLE}
    WHERE NOT EXISTS (SELECT 1 FROM ${MANUAL_PERSON_FACE_TABLE} f WHERE f.manual_person_id = ${MANUAL_PERSON_TABLE}.id)
  `).run();
  db.prepare(`
    DELETE FROM ${HIDDEN_MANUAL_PERSON_TABLE}
    WHERE NOT EXISTS (SELECT 1 FROM ${MANUAL_PERSON_TABLE} manual WHERE manual.id = manual_person_id)
  `).run();
}

function mergeManualPeople(leftId, rightId) {
  if (leftId === rightId) return leftId;
  const primaryId = Math.min(leftId, rightId);
  const secondaryId = Math.max(leftId, rightId);
  const exclusions = db.prepare(`
    SELECT left_manual_person_id, right_manual_person_id
    FROM ${PERSON_EXCLUSION_TABLE}
    WHERE left_manual_person_id = ? OR right_manual_person_id = ?
  `).all(secondaryId, secondaryId);
  const primaryName = db.prepare(`SELECT name FROM ${MANUAL_PERSON_TABLE} WHERE id = ?`).get(primaryId)?.name;
  const secondaryName = db.prepare(`SELECT name FROM ${MANUAL_PERSON_TABLE} WHERE id = ?`).get(secondaryId)?.name;
  const primaryAvatarFaceId = db.prepare(`SELECT avatar_face_id FROM ${MANUAL_PERSON_TABLE} WHERE id = ?`).get(primaryId)?.avatar_face_id;
  const secondaryAvatarFaceId = db.prepare(`SELECT avatar_face_id FROM ${MANUAL_PERSON_TABLE} WHERE id = ?`).get(secondaryId)?.avatar_face_id;
  if (!primaryName && secondaryName) {
    db.prepare(`UPDATE ${MANUAL_PERSON_TABLE} SET name = ? WHERE id = ?`).run(secondaryName, primaryId);
  }
  if (!primaryAvatarFaceId && secondaryAvatarFaceId) {
    db.prepare(`UPDATE ${MANUAL_PERSON_TABLE} SET avatar_face_id = ? WHERE id = ?`).run(secondaryAvatarFaceId, primaryId);
  }
  db.prepare(`UPDATE ${MANUAL_PERSON_FACE_TABLE} SET manual_person_id = ? WHERE manual_person_id = ?`).run(primaryId, secondaryId);
  db.prepare(`DELETE FROM ${PERSON_EXCLUSION_TABLE} WHERE left_manual_person_id = ? OR right_manual_person_id = ?`).run(secondaryId, secondaryId);
  for (const exclusion of exclusions) {
    const otherId = exclusion.left_manual_person_id === secondaryId
      ? exclusion.right_manual_person_id
      : exclusion.left_manual_person_id;
    if (otherId === primaryId) continue;
    const [left, right] = [primaryId, otherId].sort((a, b) => a - b);
    db.prepare(`INSERT OR IGNORE INTO ${PERSON_EXCLUSION_TABLE}(left_manual_person_id, right_manual_person_id) VALUES (?, ?)`).run(left, right);
  }
  db.prepare(`DELETE FROM ${MANUAL_PERSON_TABLE} WHERE id = ?`).run(secondaryId);
  return primaryId;
}

function ensureManualPerson(personId) {
  const existing = db.prepare(`
    SELECT DISTINCT manual.manual_person_id
    FROM ${MANUAL_PERSON_FACE_TABLE} manual
    JOIN ${FACE_ASSIGNMENT_TABLE} assignment ON assignment.face_id = manual.face_id
    WHERE assignment.person_id = ?
  `).all(personId).map((row) => row.manual_person_id);
  let manualPersonId = existing[0];
  if (!manualPersonId) {
    manualPersonId = Number(db.prepare(`INSERT INTO ${MANUAL_PERSON_TABLE} DEFAULT VALUES`).run().lastInsertRowid);
  }
  for (const groupId of existing.slice(1)) manualPersonId = mergeManualPeople(manualPersonId, groupId);
  db.prepare(`
    INSERT OR IGNORE INTO ${MANUAL_PERSON_FACE_TABLE}(manual_person_id, face_id)
    SELECT ?, face_id FROM ${FACE_ASSIGNMENT_TABLE} WHERE person_id = ?
  `).run(manualPersonId, personId);
  return manualPersonId;
}

function getCustomAvatarFaceId(personId) {
  return db.prepare(`
    SELECT manual.avatar_face_id AS faceId
    FROM ${MANUAL_PERSON_TABLE} manual
    JOIN ${MANUAL_PERSON_FACE_TABLE} manualFace
      ON manualFace.manual_person_id = manual.id
      AND manualFace.face_id = manual.avatar_face_id
    JOIN ${FACE_ASSIGNMENT_TABLE} assignment ON assignment.face_id = manualFace.face_id
    WHERE assignment.person_id = ? AND manual.avatar_face_id IS NOT NULL
    LIMIT 1
  `).get(personId)?.faceId ?? null;
}

function restoreCustomAvatarCovers() {
  db.prepare(`
    UPDATE ${PEOPLE_TABLE} AS person
    SET cover_face_id = (
      SELECT manual.avatar_face_id
      FROM ${MANUAL_PERSON_TABLE} manual
      JOIN ${MANUAL_PERSON_FACE_TABLE} manualFace
        ON manualFace.manual_person_id = manual.id
        AND manualFace.face_id = manual.avatar_face_id
      JOIN ${FACE_ASSIGNMENT_TABLE} assignment ON assignment.face_id = manualFace.face_id
      WHERE assignment.person_id = person.id AND manual.avatar_face_id IS NOT NULL
      LIMIT 1
    ), updated_at = strftime('%s', 'now')
    WHERE EXISTS (
      SELECT 1
      FROM ${MANUAL_PERSON_TABLE} manual
      JOIN ${MANUAL_PERSON_FACE_TABLE} manualFace
        ON manualFace.manual_person_id = manual.id
        AND manualFace.face_id = manual.avatar_face_id
      JOIN ${FACE_ASSIGNMENT_TABLE} assignment ON assignment.face_id = manualFace.face_id
      WHERE assignment.person_id = person.id AND manual.avatar_face_id IS NOT NULL
    )
  `).run();
}

function rebuildPersonRepresentatives(personId) {
  db.prepare(`DELETE FROM ${PERSON_REPRESENTATIVE_TABLE} WHERE person_id = ?`).run(personId);
  personRepresentatives.delete(personId);
  const faces = db.prepare(`
    SELECT face.id, face.recognition_quality AS quality, face.embedding
    FROM ${FACE_ASSIGNMENT_TABLE} assignment
    JOIN ${FACE_TABLE} face ON face.id = assignment.face_id
    WHERE assignment.person_id = ? AND face.embedding IS NOT NULL AND face.embedding_version = ?
    ORDER BY face.recognition_quality DESC, face.id ASC
    LIMIT ?
  `).all(personId, FACE_EMBEDDING_VERSION, MAX_REPRESENTATIVES_PER_PERSON);
  for (const face of faces) {
    const embedding = float32FromBlob(face.embedding);
    if (embedding.length === 512) addRepresentative(personId, face.id, face.quality ?? 0, embedding);
  }
  const customAvatarFaceId = getCustomAvatarFaceId(personId);
  if (customAvatarFaceId) {
    db.prepare(`UPDATE ${PEOPLE_TABLE} SET cover_face_id = ?, updated_at = strftime('%s', 'now') WHERE id = ?`).run(customAvatarFaceId, personId);
  } else if (faces[0]) {
    db.prepare(`UPDATE ${PEOPLE_TABLE} SET cover_face_id = ?, updated_at = strftime('%s', 'now') WHERE id = ?`).run(faces[0].id, personId);
  }
}

function hidePeople(personIds) {
  const ids = Array.from(new Set(personIds.map(Number).filter(Number.isInteger)));
  if (!ids.length) throw new Error("Choose at least one person to hide.");
  for (const personId of ids) {
    const manualPersonId = ensureManualPerson(personId);
    db.prepare(`INSERT OR IGNORE INTO ${HIDDEN_MANUAL_PERSON_TABLE}(manual_person_id) VALUES (?)`).run(manualPersonId);
  }
  const placeholders = ids.map(() => "?").join(",");
  db.prepare(`UPDATE ${PEOPLE_TABLE} SET hidden = 1, updated_at = strftime('%s', 'now') WHERE id IN (${placeholders})`).run(...ids);
  return { hidden: ids.length };
}

function unhidePerson(personId) {
  const manualPersonId = ensureManualPerson(personId);
  db.prepare(`DELETE FROM ${HIDDEN_MANUAL_PERSON_TABLE} WHERE manual_person_id = ?`).run(manualPersonId);
  db.prepare(`UPDATE ${PEOPLE_TABLE} SET hidden = 0, updated_at = strftime('%s', 'now') WHERE id = ?`).run(personId);
  return { hidden: false, manualPersonId };
}

function renamePerson(personId, name) {
  const trimmedName = String(name ?? "").trim();
  if (!trimmedName) throw new Error("Enter a name for this person.");
  if (trimmedName.length > 128) throw new Error("Person names can be at most 128 characters.");
  const manualPersonId = ensureManualPerson(personId);
  db.prepare(`UPDATE ${MANUAL_PERSON_TABLE} SET name = ? WHERE id = ?`).run(trimmedName, manualPersonId);
  db.prepare(`UPDATE ${PEOPLE_TABLE} SET name = ?, updated_at = strftime('%s', 'now') WHERE id = ?`).run(trimmedName, personId);
  return { name: trimmedName, manualPersonId };
}

function splitPerson(personId) {
  const person = db.prepare(`SELECT hidden FROM ${PEOPLE_TABLE} WHERE id = ?`).get(personId);
  const faces = db.prepare(`
    SELECT face_id
    FROM ${FACE_ASSIGNMENT_TABLE}
    WHERE person_id = ?
    ORDER BY face_id ASC
  `).all(personId);
  if (faces.length < 2) throw new Error("This person needs at least two faces to split.");

  const faceIds = faces.map((face) => face.face_id);
  const placeholders = faceIds.map(() => "?").join(",");
  db.prepare(`DELETE FROM ${MANUAL_PERSON_FACE_TABLE} WHERE face_id IN (${placeholders})`).run(...faceIds);
  const insertManualPerson = db.prepare(`INSERT INTO ${MANUAL_PERSON_TABLE} DEFAULT VALUES`);
  const assignManualFace = db.prepare(`INSERT INTO ${MANUAL_PERSON_FACE_TABLE}(manual_person_id, face_id) VALUES (?, ?)`);
  const hideManualPerson = db.prepare(`INSERT OR IGNORE INTO ${HIDDEN_MANUAL_PERSON_TABLE}(manual_person_id) VALUES (?)`);
  for (const face of faces) {
    const manualPersonId = Number(insertManualPerson.run().lastInsertRowid);
    assignManualFace.run(manualPersonId, face.face_id);
    if (person.hidden) hideManualPerson.run(manualPersonId);
  }
  deleteOrphanedPeople();

  return { split: faces.length };
}

function applyPeopleAction(action, personId, value = null) {
  if (!Number.isInteger(personId)) throw new Error("Choose a person.");
  const person = db.prepare(`SELECT id FROM ${PEOPLE_TABLE} WHERE id = ?`).get(personId);
  if (!person) throw new Error("This person is no longer available.");

  const result = db.transaction(() => {
    if (action === "rename") return renamePerson(personId, value);
    if (action === "hide") return hidePeople([personId]);
    if (action === "unhide") return unhidePerson(personId);
    if (action === "split") return splitPerson(personId);
    throw new Error("Unknown people action.");
  })();

  if (action === "split") {
    const regrouped = reclusterPeople();
    return { ...result, ...regrouped };
  }
  loadPersonRepresentatives();
  emitProgress();
  return result;
}

function setManualFace(faceId, manualPersonId) {
  db.prepare(`UPDATE ${MANUAL_PERSON_TABLE} SET avatar_face_id = NULL WHERE avatar_face_id = ?`).run(faceId);
  db.prepare(`DELETE FROM ${MANUAL_PERSON_FACE_TABLE} WHERE face_id = ?`).run(faceId);
  db.prepare(`INSERT INTO ${MANUAL_PERSON_FACE_TABLE}(manual_person_id, face_id) VALUES (?, ?)`).run(manualPersonId, faceId);
}

function applyFaceAction(action, faceId, targetPersonId = null) {
  if (!Number.isInteger(faceId)) throw new Error("Choose a face.");
  const face = db.prepare(`
    SELECT face.id, assignment.person_id AS personId
    FROM ${FACE_TABLE} face
    JOIN ${FACE_ASSIGNMENT_TABLE} assignment ON assignment.face_id = face.id
    WHERE face.id = ?
  `).get(faceId);
  if (!face) throw new Error("This face is no longer available.");

  const result = db.transaction(() => {
    if (action === "add-to-person") {
      const targetId = Number(targetPersonId);
      if (!Number.isInteger(targetId)) throw new Error("Choose a person.");
      if (targetId === face.personId) throw new Error("This face is already part of that person.");
      const target = db.prepare(`SELECT id FROM ${PEOPLE_TABLE} WHERE id = ?`).get(targetId);
      if (!target) throw new Error("The selected person is no longer available.");
      setManualFace(faceId, ensureManualPerson(targetId));
      db.prepare(`UPDATE ${FACE_ASSIGNMENT_TABLE} SET person_id = ?, assigned_by = 'manual', assigned_at = strftime('%s', 'now') WHERE face_id = ?`).run(targetId, faceId);
      rebuildPersonRepresentatives(face.personId);
      rebuildPersonRepresentatives(targetId);
      deleteOrphanedPeople();
      return { action, targetPersonId: targetId, previousPersonId: face.personId };
    }

    if (action === "separate" || action === "hide-not-face") {
      if (action === "hide-not-face") {
        const targetId = Number(targetPersonId);
        if (!Number.isInteger(targetId) || targetId !== face.personId) {
          throw new Error("Choose a face from the person currently being viewed.");
        }
      }
      const manualPersonId = Number(db.prepare(`INSERT INTO ${MANUAL_PERSON_TABLE} DEFAULT VALUES`).run().lastInsertRowid);
      setManualFace(faceId, manualPersonId);
      const newPersonId = Number(db.prepare(`INSERT INTO ${PEOPLE_TABLE}(cover_face_id, hidden) VALUES (?, ?)`).run(faceId, action === "hide-not-face" ? 1 : 0).lastInsertRowid);
      db.prepare(`UPDATE ${FACE_ASSIGNMENT_TABLE} SET person_id = ?, assigned_by = 'manual', assigned_at = strftime('%s', 'now') WHERE face_id = ?`).run(newPersonId, faceId);
      if (action === "hide-not-face") {
        db.prepare(`INSERT INTO ${HIDDEN_MANUAL_PERSON_TABLE}(manual_person_id) VALUES (?)`).run(manualPersonId);
      }
      rebuildPersonRepresentatives(face.personId);
      rebuildPersonRepresentatives(newPersonId);
      deleteOrphanedPeople();
      return { action, manualPersonId, personId: newPersonId, previousPersonId: face.personId };
    }

    if (action === "set-avatar") {
      const targetId = Number(targetPersonId);
      if (!Number.isInteger(targetId) || targetId !== face.personId) {
        throw new Error("Choose a face from the person currently being viewed.");
      }
      const manualPersonId = ensureManualPerson(targetId);
      db.prepare(`UPDATE ${MANUAL_PERSON_TABLE} SET avatar_face_id = ? WHERE id = ?`).run(faceId, manualPersonId);
      db.prepare(`UPDATE ${PEOPLE_TABLE} SET cover_face_id = ?, updated_at = strftime('%s', 'now') WHERE id = ?`).run(faceId, targetId);
      return { action, personId: targetId };
    }

    throw new Error("Unknown face action.");
  })();

  loadPersonRepresentatives();
  emitProgress();
  return result;
}

function mergePeopleIntoTarget(targetPersonId, sourcePersonIds) {
  const sourceIds = Array.from(new Set(sourcePersonIds.map(Number).filter((personId) => (
    Number.isInteger(personId) && personId !== targetPersonId
  ))));
  if (!sourceIds.length) throw new Error("Choose at least one person to merge.");

  let targetManualId = ensureManualPerson(targetPersonId);
  const targetCustomAvatarFaceId = getCustomAvatarFaceId(targetPersonId);
  for (const sourcePersonId of sourceIds) {
    targetManualId = mergeManualPeople(targetManualId, ensureManualPerson(sourcePersonId));
  }
  if (targetCustomAvatarFaceId) {
    db.prepare(`UPDATE ${MANUAL_PERSON_TABLE} SET avatar_face_id = ? WHERE id = ?`).run(targetCustomAvatarFaceId, targetManualId);
  }

  const placeholders = sourceIds.map(() => "?").join(",");
  db.prepare(`
    UPDATE ${FACE_ASSIGNMENT_TABLE}
    SET person_id = ?, assigned_by = 'manual'
    WHERE person_id IN (${placeholders})
  `).run(targetPersonId, ...sourceIds);
  rebuildPersonRepresentatives(targetPersonId);
  db.prepare(`DELETE FROM ${PERSON_REPRESENTATIVE_TABLE} WHERE person_id IN (${placeholders})`).run(...sourceIds);
  for (const sourcePersonId of sourceIds) personRepresentatives.delete(sourcePersonId);
  deleteOrphanedPeople();
  return { kind: "merge", personId: targetPersonId, merged: sourceIds.length, manualPersonId: targetManualId };
}

function applyPeopleBulkDecision(kind, personIds, targetPersonId = null) {
  const ids = Array.from(new Set((Array.isArray(personIds) ? personIds : []).map(Number).filter(Number.isInteger)));
  if (!ids.length) throw new Error("Choose at least one person.");
  const people = db.prepare(`SELECT id FROM ${PEOPLE_TABLE} WHERE id IN (${ids.map(() => "?").join(",")})`).all(...ids);
  if (people.length !== ids.length) throw new Error("One of these people is no longer available.");

  const result = db.transaction(() => {
    if (kind === "hide") return hidePeople(ids);
    if (kind === "merge") {
      if (!Number.isInteger(targetPersonId)) throw new Error("Choose the person to merge into.");
      const target = db.prepare(`SELECT id FROM ${PEOPLE_TABLE} WHERE id = ?`).get(targetPersonId);
      if (!target) throw new Error("The merge destination is no longer available.");
      return mergePeopleIntoTarget(targetPersonId, ids);
    }
    throw new Error("Unknown bulk people decision.");
  })();
  loadPersonRepresentatives();
  emitProgress();
  return result;
}

function applyPeopleDecision(kind, firstPersonId, secondPersonId) {
  if (!Number.isInteger(firstPersonId) || !Number.isInteger(secondPersonId) || firstPersonId === secondPersonId) {
    throw new Error("Choose two different people.");
  }
  const people = db.prepare(`SELECT id FROM ${PEOPLE_TABLE} WHERE id IN (?, ?)`).all(firstPersonId, secondPersonId);
  if (people.length !== 2) throw new Error("One of these people is no longer available.");

  const result = db.transaction(() => {
    if (kind === "hide-first") return hidePeople([firstPersonId]);
    if (kind === "hide-second") return hidePeople([secondPersonId]);
    if (kind === "hide-both") return hidePeople([firstPersonId, secondPersonId]);
    if (kind === "merge") {
      return mergePeopleIntoTarget(firstPersonId, [secondPersonId]);
    }
    const firstManualId = ensureManualPerson(firstPersonId);
    const secondManualId = ensureManualPerson(secondPersonId);
    if (kind === "exclude") {
      if (firstManualId === secondManualId) throw new Error("These people are already merged.");
      const [left, right] = [firstManualId, secondManualId].sort((a, b) => a - b);
      db.prepare(`INSERT OR IGNORE INTO ${PERSON_EXCLUSION_TABLE}(left_manual_person_id, right_manual_person_id) VALUES (?, ?)`).run(left, right);
      return { kind };
    }
    throw new Error("Unknown people decision.");
  })();
  loadPersonRepresentatives();
  emitProgress();
  return result;
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
    db.exec(`DELETE FROM ${FACE_ASSIGNMENT_TABLE}; DELETE FROM ${PERSON_REPRESENTATIVE_TABLE}; DELETE FROM ${FACE_SUGGESTION_TABLE}; DELETE FROM ${IGNORED_FACE_TABLE}; DELETE FROM ${HIDDEN_MANUAL_PERSON_TABLE}; DELETE FROM ${MANUAL_PERSON_FACE_TABLE}; DELETE FROM ${PERSON_EXCLUSION_TABLE}; DELETE FROM ${MANUAL_PERSON_TABLE}; DELETE FROM ${FACE_TABLE}; DELETE FROM ${FACE_SCAN_TABLE}; DELETE FROM ${PEOPLE_TABLE};`);
  })();
  loadPersonRepresentatives();
  emitProgress();
  // Let an already-running inference finish before scheduling the next job;
  // the child process intentionally handles one photo at a time.
  if (!paused && modelReady && !pending) schedule(100);
}

function reclusterPeople() {
  clearTimeout(loopTimer);
  personRepresentatives.clear();

  const faces = db.prepare(`
    SELECT face.id, face.recognition_quality AS quality, face.embedding
    FROM ${FACE_TABLE} face
    LEFT JOIN ${IGNORED_FACE_TABLE} ignored ON ignored.face_id = face.id
    WHERE face.embedding IS NOT NULL AND face.embedding_version = ? AND ignored.face_id IS NULL
    ORDER BY face.recognition_quality DESC, face.id ASC
  `).all(FACE_EMBEDDING_VERSION);
  const manualFaces = new Map(db.prepare(`
    SELECT manual.manual_person_id, manual.face_id, person.name, person.avatar_face_id AS avatarFaceId
    FROM ${MANUAL_PERSON_FACE_TABLE} manual
    JOIN ${MANUAL_PERSON_TABLE} person ON person.id = manual.manual_person_id
  `).all().map((row) => [row.face_id, { id: row.manual_person_id, name: row.name, avatarFaceId: row.avatarFaceId }]));
  const manualPeople = new Map();
  const hiddenManualPeople = new Set(db.prepare(`SELECT manual_person_id FROM ${HIDDEN_MANUAL_PERSON_TABLE}`).all().map((row) => row.manual_person_id));

  db.transaction(() => {
    // Keep user-confirmed identity groups intact, but rebuild every automatic
    // assignment from the stored embeddings without re-running inference.
    db.exec(`DELETE FROM ${FACE_ASSIGNMENT_TABLE}; DELETE FROM ${PERSON_REPRESENTATIVE_TABLE}; DELETE FROM ${FACE_SUGGESTION_TABLE}; DELETE FROM ${PEOPLE_TABLE};`);
    for (const face of faces) {
      const manualPerson = manualFaces.get(face.id);
      if (!manualPerson) continue;
      const manualPersonId = manualPerson.id;
      const embedding = float32FromBlob(face.embedding);
      if (embedding.length !== 512) continue;
      let personId = manualPeople.get(manualPersonId);
      if (!personId) {
        personId = Number(db.prepare(`INSERT INTO ${PEOPLE_TABLE}(name, cover_face_id, hidden) VALUES (?, ?, ?)`).run(manualPerson.name, manualPerson.avatarFaceId ?? face.id, hiddenManualPeople.has(manualPersonId) ? 1 : 0).lastInsertRowid);
        manualPeople.set(manualPersonId, personId);
      }
      assignFaceToPerson(face.id, personId, face.quality ?? 0, embedding, "manual", null, manualPerson.avatarFaceId != null);
    }
    for (const face of faces) {
      if (manualFaces.has(face.id)) continue;
      const embedding = float32FromBlob(face.embedding);
      if (embedding.length === 512) assignFace(face.id, face.quality ?? 0, embedding);
    }
    deleteOrphanedPeople();
  })();

  loadPersonRepresentatives();
  emitProgress();
  if (!paused && modelReady && !pending) schedule(100);
  return { faces: faces.length, people: peopleCount };
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
  } else if (message.type === "recluster") {
    try {
      const result = reclusterPeople();
      parentPort.postMessage({ type: "reclustered", requestId: message.requestId, ...result });
    } catch (error) {
      parentPort.postMessage({ type: "recluster-error", requestId: message.requestId, error: error.message });
    }
  } else if (message.type === "people-decision") {
    try {
      const result = applyPeopleDecision(message.kind, Number(message.firstPersonId), Number(message.secondPersonId));
      parentPort.postMessage({ type: "people-decision-complete", requestId: message.requestId, result });
    } catch (error) {
      parentPort.postMessage({ type: "people-decision-error", requestId: message.requestId, error: error.message });
    }
  } else if (message.type === "people-bulk-decision") {
    try {
      const result = applyPeopleBulkDecision(message.kind, message.personIds, Number(message.targetPersonId));
      parentPort.postMessage({ type: "people-bulk-decision-complete", requestId: message.requestId, result });
    } catch (error) {
      parentPort.postMessage({ type: "people-bulk-decision-error", requestId: message.requestId, error: error.message });
    }
  } else if (message.type === "people-action") {
    try {
      const result = applyPeopleAction(message.action, Number(message.personId), message.value);
      parentPort.postMessage({ type: "people-action-complete", requestId: message.requestId, result });
    } catch (error) {
      parentPort.postMessage({ type: "people-action-error", requestId: message.requestId, error: error.message });
    }
  } else if (message.type === "people-face-action") {
    try {
      const result = applyFaceAction(message.action, Number(message.faceId), Number(message.targetPersonId));
      parentPort.postMessage({ type: "people-face-action-complete", requestId: message.requestId, result });
    } catch (error) {
      parentPort.postMessage({ type: "people-face-action-error", requestId: message.requestId, error: error.message });
    }
  } else if (message.type === "stop") {
    stopped = true;
    clearTimeout(loopTimer);
    try { child?.send({ type: "stop" }); } catch {}
    try { db?.close(); } catch {}
  }
});
