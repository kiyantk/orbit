/**
 * location-service.js  (proxy / coordinator — main-process safe)
 *
 * Mirrors the EmbeddingService pattern exactly.  All heavy work (SQLite reads/writes,
 * places.db lookups) runs inside location-worker.js (a Worker thread) so the main
 * process event loop is never blocked.
 *
 * Public API:
 *   service.start()
 *   service.pause() / service.resume() / service.stop()
 *   service.getStatus()   → synchronous snapshot
 */

const path   = require("path");
const { Worker } = require("worker_threads");
const { normalizeLocationSelectionMode } = require("./location-schema");

const WORKER_RESTART_DELAY = 5_000;

class LocationService {
  constructor(db, dataDir, placesDbPath, getMainWindow, selectionMode = "smart") {
    this._dbPath        = db.name;          // better-sqlite3 exposes .name = file path
    this._dataDir       = dataDir;
    this._placesDbPath  = placesDbPath;
    this._getMainWindow = getMainWindow;

    this._worker  = null;
    this._stopped = false;

    // Mirrors of worker state — updated on every "progress" message
    this._total  = 0;
    this._done   = 0;
    this._paused = false;
    this._pausePending = false;
    this._selectionMode = normalizeLocationSelectionMode(selectionMode);
    this._forceReindex = false;
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  start() {
    if (this._worker || this._stopped) return;
    this._spawnWorker();
  }

  setInitialPaused(paused) {
    this._paused = paused;
    this._pausePending = false;
  }

  pause() {
    if (this._paused && this._pausePending) return;
    this._paused = true;
    this._pausePending = true;
    this._worker?.postMessage({ type: "pause" });
  }

  resume() {
    if (!this._paused && this._pausePending) return;
    this._paused = false;
    this._pausePending = true;
    this._worker?.postMessage({ type: "resume" });
  }

  regenerate(selectionMode) {
    this._selectionMode = normalizeLocationSelectionMode(selectionMode);
    this._total = 0;
    this._done = 0;

    if (!this._worker) {
      // A paused service has no worker. Its next start will compare the
      // persisted mode-specific index version and rebuild before processing.
      this._forceReindex = true;
      return;
    }

    this._worker.postMessage({
      type: "regenerate",
      selectionMode: this._selectionMode,
    });
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
      pausePending: this._pausePending,
      stopped:    this._stopped,
      selectionMode: this._selectionMode,
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
      placesDbPath: this._placesDbPath,
      dataDir:    this._dataDir,
      selectionMode: this._selectionMode,
      forceReindex: this._forceReindex,
    });
    this._forceReindex = false;

    // A replacement worker starts unpaused. Preserve an explicit user pause.
    if (this._paused) this._worker.postMessage({ type: "pause" });
  }

  _handleWorkerMessage(msg) {
    switch (msg.type) {

      case "progress": {
        this._total  = msg.total;
        this._done   = msg.done;
        if (!this._pausePending || msg.paused === this._paused) {
          this._paused = msg.paused;
          this._pausePending = false;
        }

        const win = this._getMainWindow();
        if (win && !win.isDestroyed()) {
          win.webContents.send("location-progress", {
            total:      msg.total,
            done:       msg.done,
            paused:     this._paused,
            pausePending: this._pausePending,
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
