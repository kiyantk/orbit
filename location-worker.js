/**
 * Resolves GPS coordinates against the bundled locality polygons in places.db.
 * It runs in a Worker thread so SQLite lookup and index writes never block the
 * Electron main process.
 */

const { parentPort } = require("worker_threads");
const Database = require("better-sqlite3");
const { OfflineGeocoder } = require("./geocoder");
const {
  LOCATION_METADATA_TABLE,
  getLocationGeocoderVersion,
  normalizeLocationSelectionMode,
} = require("./location-schema");

const BATCH_SIZE = 50;
const PROGRESS_BATCH_INTERVAL = 5;
const RECHECK_INTERVAL_MS = 60_000;

let db = null; // User's orbit-index.db.
let placesDB = null; // Read-only OfflineGeocoder backed by places.db.
let getNextFilesStmt = null;
let insertLocationStmt = null;
let countTotalStmt = null;
let countDoneStmt = null;
let writeBatch = null;

let paused = false;
let stopped = false;
let running = false;
let loopTimer = null;
let batchesSinceProgress = 0;

let total = 0;
let done = 0;
let geocodingMode = "smart";

function log(level, message) {
  parentPort.postMessage({ type: "log", level, message });
}

function tableExists(tableName) {
  return !!db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
    )
    .get(tableName);
}

function ensureLocationSchema({ forceReindex = false } = {}) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${LOCATION_METADATA_TABLE} (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  const existingColumns = tableExists("locations")
    ? db.prepare("PRAGMA table_info(locations)").all().map((column) => column.name)
    : [];
  const expectedColumns = [
    "file_id",
    "locality_id",
    "country",
    "subdivision",
    "city",
    "local_name",
    "english_name",
    "subtype",
    "admin_level",
    "area",
  ];
  const needsSchemaMigration =
    existingColumns.length !== expectedColumns.length ||
    expectedColumns.some((column) => !existingColumns.includes(column));
  const currentVersion = db
    .prepare(
      `SELECT value FROM ${LOCATION_METADATA_TABLE} WHERE key = 'geocoder_version'`,
    )
    .get()?.value;
  const geocoderVersion = getLocationGeocoderVersion(geocodingMode);
  const needsReindex =
    forceReindex || needsSchemaMigration || currentVersion !== geocoderVersion;

  db.transaction(() => {
    if (needsSchemaMigration && tableExists("locations")) {
      // Location rows are exclusively derived data. Legacy non-polygon rows
      // are invalid for polygon containment, so rebuild only this table.
      db.exec("DROP TABLE locations");
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS locations (
        file_id      INTEGER PRIMARY KEY,
        locality_id  INTEGER,
        country      TEXT,
        subdivision  TEXT,
        city         TEXT,
        local_name   TEXT,
        english_name TEXT,
        subtype      TEXT,
        admin_level  INTEGER,
        area         REAL
      )
    `);

    if (needsReindex) {
      db.exec("DELETE FROM locations");
    }

    db.prepare(`
      INSERT INTO ${LOCATION_METADATA_TABLE} (key, value)
      VALUES ('geocoder_version', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(geocoderVersion);
  })();
}

function prepareStatements() {
  // Invalid coordinates are intentionally selected too: they receive a null
  // row so corrupt EXIF cannot cause an endless retry. Only valid coordinates
  // are included in progress totals.
  getNextFilesStmt = db.prepare(`
    SELECT f.id, f.latitude, f.longitude
    FROM files f
    LEFT JOIN locations l ON l.file_id = f.id
    WHERE f.latitude IS NOT NULL
      AND f.longitude IS NOT NULL
      AND l.file_id IS NULL
    ORDER BY f.id
    LIMIT ?
  `);

  insertLocationStmt = db.prepare(`
    INSERT OR REPLACE INTO locations
      (
        file_id,
        locality_id,
        country,
        subdivision,
        city,
        local_name,
        english_name,
        subtype,
        admin_level,
        area
      )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const validCoordinates = `
    latitude IS NOT NULL
    AND longitude IS NOT NULL
    AND latitude BETWEEN -90 AND 90
    AND longitude BETWEEN -180 AND 180
  `;
  countTotalStmt = db.prepare(`
    SELECT COUNT(*) AS c
    FROM files
    WHERE ${validCoordinates}
  `);
  countDoneStmt = db.prepare(`
    SELECT COUNT(*) AS c
    FROM files f
    JOIN locations l ON l.file_id = f.id
    WHERE f.latitude IS NOT NULL
      AND f.longitude IS NOT NULL
      AND f.latitude BETWEEN -90 AND 90
      AND f.longitude BETWEEN -180 AND 180
  `);

  writeBatch = db.transaction((files) => {
    for (const file of files) {
      resolveAndStore(file);
    }
  });
}

function isValidCoordinate(latitude, longitude) {
  return (
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180
  );
}

function resolveAndStore(file) {
  let locality = null;

  try {
    if (isValidCoordinate(file.latitude, file.longitude)) {
      locality = placesDB.reverseGeocodeOne(file.latitude, file.longitude, {
        mode: geocodingMode,
      });
    }
  } catch (error) {
    // Still write the null row below so a malformed record never blocks the
    // queue. The failure is visible in worker logs for diagnosis.
    log("warn", `location lookup failed for file ${file.id}: ${error.message}`);
  }

  insertLocationStmt.run(
    file.id,
    locality?.id ?? null,
    locality?.country ?? null,
    locality?.region ?? null,
    locality?.localName ?? null,
    locality?.localName ?? null,
    locality?.englishName ?? null,
    locality?.subtype ?? null,
    locality?.adminLevel ?? null,
    locality?.area ?? null,
  );
}

function refreshCounts() {
  total = countTotalStmt.get()?.c ?? 0;
  done = countDoneStmt.get()?.c ?? 0;
}

function emitProgress() {
  refreshCounts();
  parentPort.postMessage({
    type: "progress",
    total,
    done,
    paused,
    percentage: total > 0 ? Math.round((done / total) * 100) : 0,
  });
}

function scheduleLoop(delayMs = 0) {
  clearTimeout(loopTimer);
  if (stopped) return;

  running = true;
  loopTimer = setTimeout(processBatch, delayMs);
}

function processBatch() {
  if (stopped || paused) {
    running = false;
    return;
  }

  const files = getNextFilesStmt.all(BATCH_SIZE);
  if (!files.length) {
    refreshCounts();
    emitProgress();
    running = false;
    loopTimer = setTimeout(() => {
      if (!stopped && !paused) scheduleLoop();
    }, RECHECK_INTERVAL_MS);
    return;
  }

  try {
    writeBatch(files);
  } catch (error) {
    // A transaction-level SQLite problem should not spin at full speed. Leave
    // the files eligible so they can be retried after the database recovers.
    log("warn", `location batch failed: ${error.message}`);
    scheduleLoop(1_000);
    return;
  }

  batchesSinceProgress++;
  if (batchesSinceProgress >= PROGRESS_BATCH_INTERVAL) {
    batchesSinceProgress = 0;
    emitProgress();
  }

  // Yield between bounded batches so pause/stop messages are handled promptly
  // without the old 50 ms artificial delay per file.
  scheduleLoop();
}

function regenerateLocationData(mode) {
  geocodingMode = normalizeLocationSelectionMode(mode);
  clearTimeout(loopTimer);
  running = false;
  batchesSinceProgress = 0;

  // The rows are derived solely from the current polygon-selection mode.
  // Clearing them in one transaction before queuing new work prevents a view
  // from ever mixing Smart and Smallest results.
  ensureLocationSchema({ forceReindex: true });
  prepareStatements();
  emitProgress();
  log("info", "regenerating locations using " + geocodingMode + " selection");

  if (!paused) {
    scheduleLoop();
  }
}

function closeDatabases() {
  try {
    placesDB?.close();
  } catch {}
  try {
    db?.close();
  } catch {}
  placesDB = null;
  db = null;
}

parentPort.on("message", (msg) => {
  switch (msg.type) {
    case "start": {
      stopped = false;
      paused = false;
      batchesSinceProgress = 0;
      geocodingMode = normalizeLocationSelectionMode(msg.selectionMode);

      try {
        db = new Database(msg.dbPath);
        placesDB = new OfflineGeocoder(msg.placesDbPath);
        ensureLocationSchema({ forceReindex: !!msg.forceReindex });
        prepareStatements();
        emitProgress();

        log("info", `location-worker started — ${total - done} file(s) to resolve`);
        // Preserve the original short startup grace period for the main window.
        scheduleLoop(2_000);
      } catch (error) {
        log("error", `location-worker failed to start: ${error.message}`);
        closeDatabases();
        throw error;
      }
      break;
    }

    case "regenerate":
      if (!stopped && db) {
        regenerateLocationData(msg.selectionMode);
      }
      break;

    case "pause":
      paused = true;
      log("info", "paused");
      emitProgress();
      break;

    case "resume":
      if (paused) {
        paused = false;
        log("info", "resumed");
        emitProgress();
        scheduleLoop();
      }
      break;

    case "stop":
      stopped = true;
      paused = false;
      clearTimeout(loopTimer);
      running = false;
      closeDatabases();
      log("info", "stopped");
      break;
  }
});
