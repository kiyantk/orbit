/**
 * location-worker.js
 *
 * Runs inside a Worker thread — resolves GPS coordinates for every file that
 * has latitude/longitude but no entry in the `locations` table yet.
 *
 * For each qualifying file it performs a fast nearest-neighbour lookup against
 * the bundled geo.db (cities table) and writes the result to the user's own
 * orbit-index.db under a `locations` table.
 *
 * Message protocol (main → worker):
 *   { type: "start",   dbPath, geoDbPath, dataDir }
 *   { type: "pause"  }
 *   { type: "resume" }
 *   { type: "stop"   }
 *
 * Message protocol (worker → main):
 *   { type: "progress", total, done, paused, percentage }
 *   { type: "log",      level, message }
 */

const { parentPort } = require("worker_threads");
const path = require("path");
const Database = require("better-sqlite3");

// ── Constants ─────────────────────────────────────────────────────────────────
// Delay between files so we never pin the CPU.
const INTER_FILE_DELAY_MS = 50;
// How long to wait before re-scanning for newly-indexed files.
const RECHECK_INTERVAL_MS = 60_000;
// Maximum straight-line distance (km) to accept a city match.
// Points in the ocean / very remote areas will stay city-less.
const MAX_CITY_DISTANCE_KM = 50;

// ── State ─────────────────────────────────────────────────────────────────────
let db = null; // user's orbit-index.db
let geoDB = null; // read-only geo.db

let paused = false;
let stopped = false;
let running = false;
let loopTimer = null;

let total = 0;
let done = 0;

// ── Helpers ───────────────────────────────────────────────────────────────────
function log(level, message) {
  parentPort.postMessage({ type: "log", level, message });
}

// Haversine distance in kilometres between two lat/lng pairs.
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toR = (d) => (d * Math.PI) / 180;
  const dLat = toR(lat2 - lat1);
  const dLon = toR(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toR(lat1)) * Math.cos(toR(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── DB helpers ────────────────────────────────────────────────────────────────
function ensureTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS locations (
      file_id      INTEGER PRIMARY KEY,
      country      TEXT,
      subdivision  TEXT,
      city         TEXT,
      city_simple  TEXT,
      population   INTEGER,
      timezone     INTEGER,
      feature_code TEXT,
      geonameid    INTEGER
    )
  `);
  // Migrate existing DBs
  try {
    db.exec(`ALTER TABLE locations ADD COLUMN feature_code TEXT`);
  } catch {}
  try {
    db.exec(`ALTER TABLE locations ADD COLUMN feature_code TEXT`);
  } catch {}
  try {
    db.exec(`ALTER TABLE locations ADD COLUMN geonameid INTEGER`);
  } catch {}
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_locations_file_id ON locations(file_id)
  `);
}

function refreshCounts() {
  try {
    // Total = all files that have GPS data (these are the ones we can resolve).
    total =
      db
        .prepare(
          `
      SELECT COUNT(*) AS c FROM files
      WHERE latitude IS NOT NULL AND longitude IS NOT NULL
    `,
        )
        .get()?.c ?? 0;

    // Done = rows already in the locations table.
    done =
      db
        .prepare(
          `
      SELECT COUNT(*) AS c FROM locations
    `,
        )
        .get()?.c ?? 0;
  } catch {}
}

/**
 * Returns the next file that has GPS data but no locations row yet.
 * We use LEFT JOIN rather than NOT IN to stay fast at scale.
 */
function getNextFile() {
  return (
    db
      .prepare(
        `
    SELECT f.id, f.latitude, f.longitude
    FROM   files f
    LEFT   JOIN locations l ON l.file_id = f.id
    WHERE  f.latitude  IS NOT NULL
      AND  f.longitude IS NOT NULL
      AND  l.file_id   IS NULL
    LIMIT  1
  `,
      )
      .get() ?? null
  );
}

// ── Geo lookup ────────────────────────────────────────────────────────────────
/**
 * Bounding-box pre-filter:
 *   1 degree of latitude  ≈ 111 km  →  ±0.5° covers ±55 km (a bit more than MAX)
 *   1 degree of longitude ≈ 111 km × cos(lat)  →  use ±1° to be safe near poles
 *
 * After the pre-filter we do an exact haversine check on the handful of
 * candidates that remain, then pick the closest one.
 */
let _nearestStmt = null;

function getNearestCity(lat, lng) {
  if (!_nearestStmt) {
    // Prepared once; reused for every lookup.
    _nearestStmt = geoDB.prepare(`
      SELECT
        name,
        asciiname,
        country_code,
        admin1_code,
        population,
        timezone_id,
        feature_code,
        geonameid,
        latitude,
        longitude
      FROM cities
      WHERE latitude BETWEEN ? AND ?
        AND longitude BETWEEN ? AND ?
        AND feature_code IN ('PPL', 'PPLA', 'PPLA2', 'PPLA3', 'PPLA4', 'PPLC')
        AND name NOT GLOB '*[0-9]*'
    `);
  }

  const latDelta = 0.55; // ~61 km
  const lngDelta = 1.0; // generous — corrected by haversine below

  const candidates = _nearestStmt.all(
    lat - latDelta,
    lat + latDelta,
    lng - lngDelta,
    lng + lngDelta,
  );

  if (!candidates.length) return null;

  let best = null;
  let bestDist = Infinity;

  for (const c of candidates) {
    const dist = haversineKm(lat, lng, c.latitude, c.longitude);
    if (dist < bestDist) {
      bestDist = dist;
      best = c;
    }
  }

  if (bestDist > MAX_CITY_DISTANCE_KM) return null;

  return best; // { name, country, subdivision, lat, lng }
}

// ── Progress emission ─────────────────────────────────────────────────────────
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

// ── Insert helper ─────────────────────────────────────────────────────────────
let _insertStmt = null;

function insertLocation(
  fileId,
  country,
  subdivision,
  city,
  citySimple,
  population,
  timezone,
  featureCode,
  geonameid,
) {
  if (!_insertStmt) {
    _insertStmt = db.prepare(`
      INSERT OR REPLACE INTO locations
        (file_id, country, subdivision, city, city_simple, population, timezone, feature_code, geonameid)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
  }
  _insertStmt.run(
    fileId,
    country ?? null,
    subdivision ?? null,
    city ?? null,
    citySimple ?? null,
    population ?? null,
    timezone ?? null,
    featureCode ?? null,
    geonameid ?? null,
  );
}

// ── Processing loop ───────────────────────────────────────────────────────────
function scheduleLoop(delayMs = INTER_FILE_DELAY_MS) {
  clearTimeout(loopTimer);
  if (stopped) return;
  running = true;
  loopTimer = setTimeout(() => loop(), delayMs);
}

function loop() {
  if (stopped || paused) {
    running = false;
    return;
  }

  const file = getNextFile();

  if (!file) {
    // Nothing left — re-check periodically for newly-indexed files.
    refreshCounts();
    emitProgress();
    running = false;
    loopTimer = setTimeout(() => {
      running = true;
      loop();
    }, RECHECK_INTERVAL_MS);
    return;
  }

  try {
    const city = getNearestCity(file.latitude, file.longitude);

    // Always write a row — even when no city was found — so we don't keep
    // re-processing the same file.  A null city means "GPS present, but no
    // city within MAX_CITY_DISTANCE_KM."
    insertLocation(
      file.id,
      city?.country_code ?? null,
      city?.admin1_code ?? null,
      city?.name ?? null,
      city?.asciiname !== city?.name ? (city?.asciiname ?? null) : null,
      city?.population ?? null,
      city?.timezone_id ?? null,
      city?.feature_code ?? null,
      city?.geonameid ?? null,
    );

    done++;
  } catch (err) {
    // Log and skip; the file won't be retried (LEFT JOIN will still find it
    // because we only write on success — but to avoid infinite retries on
    // truly broken rows we insert a null-city record anyway).
    log("warn", `location lookup failed for file ${file.id}: ${err.message}`);
    try {
      insertLocation(file.id, null, null, null, null, null, null, null, null);
    } catch {}
  }

  // Emit progress every 50 files to keep the UI responsive without flooding IPC.
  if (done % 50 === 0) emitProgress();

  scheduleLoop(INTER_FILE_DELAY_MS);
}

// ── Main-thread message handler ───────────────────────────────────────────────
parentPort.on("message", (msg) => {
  switch (msg.type) {
    case "start": {
      const Database = require("better-sqlite3");

      db = new Database(msg.dbPath);
      geoDB = new Database(msg.geoDbPath, {
        readonly: true,
        fileMustExist: true,
      });

      ensureTable();
      refreshCounts();
      emitProgress();

      log(
        "info",
        `location-worker started — ${total - done} file(s) to resolve`,
      );

      // Kick off the loop immediately (small delay to let the main window settle).
      scheduleLoop(2_000);
      break;
    }

    case "pause":
      paused = true;
      log("info", "paused");
      break;

    case "resume":
      if (paused) {
        paused = false;
        log("info", "resumed");
        scheduleLoop(100);
      }
      break;

    case "stop":
      stopped = true;
      paused = false;
      clearTimeout(loopTimer);
      running = false;
      log("info", "stopped");
      break;
  }
});
