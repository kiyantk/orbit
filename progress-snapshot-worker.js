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
    workerData.type === "embedding"
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
  const resultTable = workerData.type === "embedding" ? "embeddings" : "locations";
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
      : tableExists(resultTable)
        ? (db.prepare(`SELECT COUNT(*) AS c FROM ${resultTable}`).get()?.c ?? 0)
        : 0;

  parentPort.postMessage({ success: true, total, done });
} catch (error) {
  parentPort.postMessage({ success: false, error: error.message });
} finally {
  try {
    db?.close();
  } catch {}
}
