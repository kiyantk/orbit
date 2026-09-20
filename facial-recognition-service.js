/** Main-process bridge for the local InsightFace background indexer. */
const path = require("path");
const { Worker } = require("worker_threads");

const WORKER_RESTART_DELAY = 5_000;

class FacialRecognitionService {
  constructor(db, getMainWindow, modelDirectory) {
    this._dbPath = db.name;
    this._getMainWindow = getMainWindow;
    this._modelDirectory = modelDirectory;
    this._worker = null;
    this._stopped = false;
    this._modelReady = false;
    this._initError = null;
    this._total = 0;
    this._done = 0;
    this._faces = 0;
    this._people = 0;
    this._paused = false;
    this._pausePending = false;
  }

  start() {
    if (!this._worker && !this._stopped) this._spawnWorker();
  }

  setInitialPaused(paused) {
    this._paused = paused;
    this._pausePending = false;
  }

  pause() {
    this._paused = true;
    this._pausePending = true;
    this._worker?.postMessage({ type: "pause" });
  }

  resume() {
    this._paused = false;
    this._pausePending = true;
    this._worker?.postMessage({ type: "resume" });
  }

  rebuild() {
    this._total = 0;
    this._done = 0;
    this._faces = 0;
    this._people = 0;
    this.start();
    this._worker?.postMessage({ type: "rebuild" });
  }

  stop() {
    this._stopped = true;
    this._worker?.postMessage({ type: "stop" });
    setTimeout(() => this._worker?.terminate().catch(() => {}), 2_000);
    this._worker = null;
  }

  getStatus() {
    return {
      modelReady: this._modelReady,
      initError: this._initError,
      total: this._total,
      done: this._done,
      faces: this._faces,
      people: this._people,
      paused: this._paused,
      pausePending: this._pausePending,
      stopped: this._stopped,
      percentage: this._total > 0 ? Math.round((this._done / this._total) * 100) : 0,
    };
  }

  _spawnWorker() {
    this._worker = new Worker(path.join(__dirname, "facial-recognition-worker.js"));
    this._worker.on("message", (message) => this._handleMessage(message));
    this._worker.on("error", (error) => console.error("[FacialRecognitionService] worker error:", error));
    this._worker.on("exit", (code) => {
      if (this._stopped) return;
      console.warn(`[FacialRecognitionService] worker exited (code=${code}), restarting…`);
      this._worker = null;
      this._modelReady = false;
      setTimeout(() => !this._stopped && this._spawnWorker(), WORKER_RESTART_DELAY);
    });
    this._worker.postMessage({ type: "start", dbPath: this._dbPath, modelDirectory: this._modelDirectory });
    if (this._paused) this._worker.postMessage({ type: "pause" });
  }

  _handleMessage(message) {
    if (message.type === "progress") {
      this._modelReady = !!message.modelReady;
      this._initError = message.initError ?? null;
      this._total = message.total ?? 0;
      this._done = message.done ?? 0;
      this._faces = message.faces ?? 0;
      this._people = message.people ?? 0;
      if (!this._pausePending || message.paused === this._paused) {
        this._paused = !!message.paused;
        this._pausePending = false;
      }
      const win = this._getMainWindow();
      if (win && !win.isDestroyed()) {
        win.webContents.send("facial-recognition-progress", this.getStatus());
      }
    } else if (message.type === "log") {
      (console[message.level] ?? console.log)(`[facial-recognition-worker] ${message.message}`);
    }
  }
}

module.exports = FacialRecognitionService;
