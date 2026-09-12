/**
 * embedding-service.js  (proxy / coordinator — main-process safe)
 *
 * All heavy work (sharp, heic-decode, SQLite writes, child-process management)
 * now runs inside embedding-worker.js (a Worker thread).  This file is the
 * thin bridge between Electron's main process and that worker.
 *
 * Public API is unchanged so nothing else in main.js needs to change:
 *   service.start()
 *   service.pause() / service.resume() / service.stop()
 *   service.getStatus()           → synchronous snapshot (best-effort)
 *   service.embedText(text)       → Promise<Float32Array>
 *   service._pipelineReady        → boolean (read by main.js search handler)
 */

const path             = require("path");
const { Worker }       = require("worker_threads");

// Timeout for embedText requests (ms). If the worker doesn't reply within
// this window the promise rejects — prevents the search handler from hanging.
const TEXT_EMBED_TIMEOUT_MS  = 15_000;
const WORKER_RESTART_DELAY   = 5_000;

class EmbeddingService {
  constructor(db, dataDir, getMainWindow) {
    // We keep references so we can (re)start the worker if it ever crashes.
    this._dbPath        = db.name;          // better-sqlite3 exposes .name = file path
    this._dataDir       = dataDir;
    this._getMainWindow = getMainWindow;

    this._worker        = null;
    this._stopped       = false;

    // Mirrors of worker state — updated whenever the worker posts "progress"
    this._pipelineReady = false;
    this._initError     = null;
    this._total         = 0;
    this._done          = 0;
    this._paused        = false;
    this._pausePending  = false;

    // Pending text-embed requests keyed by requestId
    this._textCallbacks = new Map();   // requestId → { resolve, reject, timer }
    this._nextRequestId = 1;
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

  pause()  {
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

  stop() {
    this._stopped = true;
    if (this._worker) {
      this._worker.postMessage({ type: "stop" });
      // Give the worker a moment to clean up its child process, then terminate
      setTimeout(() => {
        try { this._worker?.terminate(); } catch {}
        this._worker = null;
      }, 2000);
    }
    // Reject all pending text requests
    for (const [id, cb] of this._textCallbacks) {
      clearTimeout(cb.timer);
      cb.reject(new Error("EmbeddingService stopped"));
    }
    this._textCallbacks.clear();
  }

  // ── Status (synchronous best-effort snapshot) ───────────────────────────────

  getStatus() {
    return {
      modelReady: this._pipelineReady,
      initError:  this._initError,
      total:      this._total,
      done:       this._done,
      paused:     this._paused,
      pausePending: this._pausePending,
      stopped:    this._stopped,
      percentage: this._total > 0
        ? Math.round((this._done / this._total) * 100)
        : 0,
    };
  }

  // ── Text embedding ──────────────────────────────────────────────────────────

  embedText(text) {
    return new Promise((resolve, reject) => {
      if (!this._worker || !this._pipelineReady) {
        return reject(new Error("pipeline not ready"));
      }

      const requestId = this._nextRequestId++;

      // Auto-timeout so the search handler never hangs
      const timer = setTimeout(() => {
        if (this._textCallbacks.has(requestId)) {
          this._textCallbacks.delete(requestId);
          reject(new Error("embedText timeout"));
        }
      }, TEXT_EMBED_TIMEOUT_MS);

      this._textCallbacks.set(requestId, { resolve, reject, timer });
      this._worker.postMessage({ type: "embedText", text, requestId });
    });
  }

  // ── Worker management ───────────────────────────────────────────────────────

  _spawnWorker() {
    const workerPath = path.join(__dirname, "embedding-worker.js");

    this._worker = new Worker(workerPath);

    this._worker.on("message",  (msg) => this._handleWorkerMessage(msg));
    this._worker.on("error",    (err) => console.error("[EmbeddingService] worker error:", err));
    this._worker.on("exit", (code) => {
      if (this._stopped) return;
      console.warn(`[EmbeddingService] worker exited (code=${code}), restarting…`);
      this._pipelineReady = false;
      this._worker        = null;

      // Reject all pending text requests — they belong to the dead worker
      for (const [, cb] of this._textCallbacks) {
        clearTimeout(cb.timer);
        cb.reject(new Error("worker restarted"));
      }
      this._textCallbacks.clear();

      setTimeout(() => {
        if (!this._stopped) this._spawnWorker();
      }, WORKER_RESTART_DELAY);
    });

    // Determine model cache dir the same way main.js does
    const { app } = require("electron");
    const modelCacheDir = app.isPackaged
      ? path.join(process.resourcesPath, "models")
      : path.join(__dirname, "models");

    this._worker.postMessage({
      type:         "start",
      dbPath:       this._dbPath,
      dataDir:      this._dataDir,
      modelCacheDir,
    });

    // A replacement worker starts unpaused. Reapply a user pause so a worker
    // restart cannot silently resume background embedding.
    if (this._paused) this._worker.postMessage({ type: "pause" });
  }

  _handleWorkerMessage(msg) {
    switch (msg.type) {

      // ── Background progress update ────────────────────────────────────────
      case "progress": {
        this._pipelineReady = msg.modelReady;
        this._initError     = msg.initError  ?? null;
        this._total         = msg.total;
        this._done          = msg.done;
        if (!this._pausePending || msg.paused === this._paused) {
          this._paused = msg.paused;
          this._pausePending = false;
        }

        // Forward to renderer (same event name as before)
        const win = this._getMainWindow();
        if (win && !win.isDestroyed()) {
          win.webContents.send("embedding-progress", {
            modelReady: msg.modelReady,
            initError:  msg.initError,
            total:      msg.total,
            done:       msg.done,
            paused:     this._paused,
            pausePending: this._pausePending,
            percentage: msg.percentage,
          });
        }
        break;
      }

      // ── Text embedding response ───────────────────────────────────────────
      case "textResult": {
        const cb = this._textCallbacks.get(msg.requestId);
        if (cb) {
          clearTimeout(cb.timer);
          this._textCallbacks.delete(msg.requestId);
          cb.resolve(msg.embedding);
        }
        break;
      }

      case "textError": {
        const cb = this._textCallbacks.get(msg.requestId);
        if (cb) {
          clearTimeout(cb.timer);
          this._textCallbacks.delete(msg.requestId);
          // Don't reject on "superseded" — that's an expected race, not an error
          if (msg.error === "superseded") {
            cb.reject(new Error("superseded"));
          } else {
            cb.reject(new Error(msg.error));
          }
        }
        break;
      }

      // ── Log forwarding ────────────────────────────────────────────────────
      case "log": {
        const fn = console[msg.level] ?? console.log;
        fn(`[embed-worker] ${msg.message}`);
        break;
      }
    }
  }
}

module.exports = EmbeddingService;
