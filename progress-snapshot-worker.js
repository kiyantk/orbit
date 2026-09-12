/**
 * Reads the progress counters needed while an indexing service is paused.
 * This is deliberately separate from the main process: COUNT queries can be
 * expensive on large libraries and the renderer polls these values regularly.
 */
const { parentPort, workerData } = require("worker_threads");
const Database = require("better-sqlite3");

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
          .prepare(
            "SELECT COUNT(*) AS c FROM files WHERE latitude IS NOT NULL AND longitude IS NOT NULL",
          )
          .get()?.c ?? 0);
  const resultTable = workerData.type === "embedding" ? "embeddings" : "locations";
  const done = tableExists(resultTable)
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
