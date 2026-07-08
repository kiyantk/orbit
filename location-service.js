/**
 * location-service.js  (proxy / coordinator — main-process safe)
 *
 * Mirrors the EmbeddingService pattern exactly.  All heavy work (SQLite reads/writes,
 * geo.db lookups) runs inside location-worker.js (a Worker thread) so the main
 * process event loop is never blocked.
 *
 * Public API:
 *   service.start()
 *   service.pause() / service.resume() / service.stop()
 *   service.getStatus()   → synchronous snapshot
 */

const path   = require("path");
const { Worker } = require("worker_threads");

const WORKER_RESTART_DELAY = 5_000;

class LocationService {
  constructor(db, dataDir, geoDbPath, getMainWindow) {
    this._dbPath        = db.name;          // better-sqlite3 exposes .name = file path
    this._dataDir       = dataDir;
    this._geoDbPath     = geoDbPath;
    this._getMainWindow = getMainWindow;

    this._worker  = null;
    this._stopped = false;

    // Mirrors of worker state — updated on every "progress" message
    this._total  = 0;
    this._done   = 0;
    this._paused = false;
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  start() {
    if (this._worker || this._stopped) return;
    this._spawnWorker();
  }

  pause() {
    this._paused = true;
    this._worker?.postMessage({ type: "pause" });
  }

  resume() {
    this._paused = false;
    this._worker?.postMessage({ type: "resume" });
  }

  stop() {
    this._stopped = true;
    if (this._worker) {
      this._worker.postMessage({ type: "stop" });
      setTimeout(() => {
        try { this._worker?.terminate(); } catch {}
        this._worker = null;
      }, 2000);
    }
  }

  // ── Status ──────────────────────────────────────────────────────────────────

  getStatus() {
    return {
      total:      this._total,
      done:       this._done,
      paused:     this._paused,
      stopped:    this._stopped,
      percentage: this._total > 0
        ? Math.round((this._done / this._total) * 100)
        : 0,
    };
  }

  // ── Worker management ───────────────────────────────────────────────────────

  _spawnWorker() {
    const workerPath = path.join(__dirname, "location-worker.js");

    this._worker = new Worker(workerPath);

    this._worker.on("message",  (msg) => this._handleWorkerMessage(msg));
    this._worker.on("error",    (err) => console.error("[LocationService] worker error:", err));
    this._worker.on("exit", (code) => {
      if (this._stopped) return;
      console.warn(`[LocationService] worker exited (code=${code}), restarting…`);
      this._worker = null;

      setTimeout(() => {
        if (!this._stopped) this._spawnWorker();
      }, WORKER_RESTART_DELAY);
    });

    this._worker.postMessage({
      type:       "start",
      dbPath:     this._dbPath,
      geoDbPath:  this._geoDbPath,
      dataDir:    this._dataDir,
    });
  }

  _handleWorkerMessage(msg) {
    switch (msg.type) {

      case "progress": {
        this._total  = msg.total;
        this._done   = msg.done;
        this._paused = msg.paused;

        const win = this._getMainWindow();
        if (win && !win.isDestroyed()) {
          win.webContents.send("location-progress", {
            total:      msg.total,
            done:       msg.done,
            paused:     msg.paused,
            percentage: msg.percentage,
          });
        }
        break;
      }

      case "log": {
        const fn = console[msg.level] ?? console.log;
        fn(`[location-worker] ${msg.message}`);
        break;
      }
    }
  }
}

module.exports = LocationService;