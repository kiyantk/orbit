/**
 * Reads the progress counters needed while an indexing service is paused.
 * This is deliberately separate from the main process: COUNT queries can be
 * expensive on large libraries and the renderer polls these values regularly.
 */
const { parentPort, workerData } = require("worker_threads");
const Database = require("better-sqlite3");
const {
  LOCATION_METADATA_TABLE,
  getLocationGeocoderVersion,
} = require("./location-schema");
const { OCR_INDEX_TABLE, OCR_PIPELINE_VERSION } = require("./ocr-schema");
const {
  FACE_PIPELINE_VERSION,
  FACE_SCAN_TABLE,
  FACE_TABLE,
  PEOPLE_TABLE,
} = require("./facial-recognition-schema");

let db;

function tableExists(tableName) {
  return !!db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
    )
    .get(tableName);
}

try {
  db = new Database(workerData.dbPath, { readonly: true, fileMustExist: true });

  const total =
    workerData.type === "embedding" || workerData.type === "ocr" || workerData.type === "facial-recognition"
      ? (db
          .prepare("SELECT COUNT(*) AS c FROM files WHERE file_type = 'image'")
          .get()?.c ?? 0)
      : (db
          .prepare(`
            SELECT COUNT(*) AS c
            FROM files
            WHERE latitude IS NOT NULL
              AND longitude IS NOT NULL
              AND latitude BETWEEN -90 AND 90
              AND longitude BETWEEN -180 AND 180
          `)
          .get()?.c ?? 0);
  const resultTable = workerData.type === "embedding"
    ? "embeddings"
    : workerData.type === "ocr"
      ? OCR_INDEX_TABLE
      : workerData.type === "facial-recognition"
        ? FACE_SCAN_TABLE
      : "locations";
  const expectedLocationVersion =
    workerData.locationGeocoderVersion ?? getLocationGeocoderVersion("smart");
  const locationVersion =
    workerData.type === "location" && tableExists(LOCATION_METADATA_TABLE)
      ? db
          .prepare(
            `SELECT value FROM ${LOCATION_METADATA_TABLE} WHERE key = 'geocoder_version'`,
          )
          .get()?.value
      : null;
  const done =
    workerData.type === "location"
      ? locationVersion === expectedLocationVersion && tableExists(resultTable)
        ? (db
            .prepare(`
              SELECT COUNT(*) AS c
              FROM files f
              JOIN locations l ON l.file_id = f.id
              WHERE f.latitude IS NOT NULL
                AND f.longitude IS NOT NULL
                AND f.latitude BETWEEN -90 AND 90
                AND f.longitude BETWEEN -180 AND 180
            `)
            .get()?.c ?? 0)
        : 0
      : workerData.type === "ocr" && tableExists(resultTable)
        ? (db.prepare(`
            SELECT COUNT(*) AS c FROM files f
            JOIN ${OCR_INDEX_TABLE} i ON i.file_id = f.id
            WHERE f.file_type = 'image' AND i.model_version = ?
          `).get(OCR_PIPELINE_VERSION)?.c ?? 0)
        : workerData.type === "facial-recognition" && tableExists(resultTable)
          ? (db.prepare(`
              SELECT COUNT(*) AS c FROM ${FACE_SCAN_TABLE}
              WHERE pipeline_version = ? AND status = 'completed'
            `).get(FACE_PIPELINE_VERSION)?.c ?? 0)
        : tableExists(resultTable)
        ? (db.prepare(`SELECT COUNT(*) AS c FROM ${resultTable}`).get()?.c ?? 0)
        : 0;

  const faces = workerData.type === "facial-recognition" && tableExists(FACE_TABLE)
    ? (db.prepare(`SELECT COUNT(*) AS c FROM ${FACE_TABLE}`).get()?.c ?? 0)
    : 0;
  const people = workerData.type === "facial-recognition" && tableExists(PEOPLE_TABLE)
    ? (db.prepare(`SELECT COUNT(*) AS c FROM ${PEOPLE_TABLE} WHERE hidden = 0`).get()?.c ?? 0)
    : 0;

  parentPort.postMessage({ success: true, total, done, faces, people });
} catch (error) {
  parentPort.postMessage({ success: false, error: error.message });
} finally {
  try {
    db?.close();
  } catch {}
}
