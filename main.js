const {
  app,
  BrowserWindow,
  ipcMain,
  globalShortcut,
  shell,
  dialog,
} = require("electron");
const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");
const { exiftool } = require("exiftool-vendored");
const sharp = require("sharp");
const { protocol } = require("electron");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");
const lookup = require("coordinate_to_country");
const fsPromises = fs.promises;
const heicDecode = require("heic-decode");
const { Worker } = require("worker_threads");
const EmbeddingService = require("./embedding-service");
const LocationService  = require("./location-service");
const OcrService = require("./ocr-service");
const { ResourceManager } = require("./resource-manager");
const {
  getLocationGeocoderVersion,
  normalizeLocationSelectionMode,
} = require("./location-schema");
const { OCR_FTS_TABLE, OCR_INDEX_TABLE } = require("./ocr-schema");
const crypto = require("crypto");
const { parse } = require("csv-parse/sync");
const AdmZip = require("adm-zip");
let embeddingService = null;
let _textPipeline = null;
let locationService  = null;
let ocrService = null;
let resourceManager = null;

if (ffmpegPath) ffmpeg.setFfmpegPath(ffmpegPath);

let mainWindow;
let splash;

const normalizeCountries = (country) =>
  (country || "")
    .split(",")
    .map((c) => c.trim().toUpperCase())
    .filter(Boolean);

function locationDisplayNameExpression(nameDisplay, tableAlias = "") {
  const prefix = tableAlias ? tableAlias + "." : "";
  const localName = "NULLIF(" + prefix + "local_name, '')";
  const englishName = "NULLIF(" + prefix + "english_name, '')";
  const legacyCity = prefix + "city";

  return nameDisplay === "local"
    ? "COALESCE(" + localName + ", " + englishName + ", " + legacyCity + ")"
    : "COALESCE(" + englishName + ", " + localName + ", " + legacyCity + ")";
}

const countriesCsvPath = path.join(__dirname, 'public/countries.csv');
const countriesCsv = fs.readFileSync(countriesCsvPath, "utf-8");

const countryPopulationMap = {};

for (const row of parse(countriesCsv, {
  columns: true,
  skip_empty_lines: true,
  delimiter: ";",
})) {
  const code = (row.iso2 || row.id || "").toUpperCase();

  if (!code) continue;

  countryPopulationMap[code] = Number(row.population) || 0;
}

const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.whenReady().then(async () => {
    await dialog.showMessageBox({
      type: "info",
      title: "Orbit",
      message: "Orbit is already running.",
      detail:
        "Another instance of Orbit is already open.",
    });

    app.quit();
  });

  return;
}

// On startup:
app.whenReady().then(() => {
  initPaths();
  // Splash screen
  splash = new BrowserWindow({
    width: 400,
    height: 400,
    icon: path.join(__dirname, "./public/logo512.png"),
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    focusable: false,
  });
  splash.loadFile(path.join(__dirname, "public/splash.html"));
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 788,
    minHeight: 708,
    icon: path.join(__dirname, "./public/logo512.png"),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      enableRemoteModule: false,
      nodeIntegration: false,
    },
    titleBarStyle: "hidden",
    backgroundColor: "#15131a",
  });

  mainWindow.webContents.once("did-finish-load", () => {
    if (splash && !splash.isDestroyed()) {
      splash.close();
    }
  
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
    }
  
    setTimeout(startEmbeddingService, 3000);
    setTimeout(startLocationService,  5000);
    setTimeout(startOcrService,       7000);
  });

  // mainWindow.once("ready-to-show", () => {
  //   splash.close();
  //   mainWindow.show();
  //   setTimeout(startEmbeddingService, 3000);
  // });

  app.on("browser-window-focus", () => {
    globalShortcut.register("CommandOrControl+Shift+I", () => {
      if (mainWindow) mainWindow.webContents.toggleDevTools();
    });
  });

  app.on("browser-window-blur", () => globalShortcut.unregisterAll());

  mainWindow.removeMenu();
  mainWindow.maximize();
  mainWindow.on("closed", () => (mainWindow = null));

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url);
    return { action: "deny" };
  });

  mainWindow.on("close", (event) => {
    event.preventDefault();
    mainWindow.webContents.send("check-unsaved-changes");
  });

  process.chdir(path.dirname(app.getPath("exe")));

  // Serve thumbnails via a custom scheme: orbit://thumbs/<filename>
  protocol.handle("orbit", async (request) => {
    try {
      const url = new URL(request.url);
      // orbit://thumbs/<filename>
      const pathname = url.pathname.replace(/^\/+/, ""); // strip leading slashes
      const filePath = path.join(dataDir, "thumbnails", pathname);

      return new Response(fs.readFileSync(filePath), {
        headers: {
          "Content-Type": "image/jpeg", // you can use mime.getType(filePath) if you want
        },
      });
    } catch (err) {
      console.error("orbit protocol error:", err);
      return new Response("Not Found", { status: 404 });
    }
  });

  const express = require("express");
  const appServer = express();
  const serverPort = 54055;

  appServer.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "http://localhost:3000");
    next();
  });

  const heicCache = new Map();
  const HEIC_CACHE_MAX = 15;
  let activeWorkers = 0;
  const MAX_WORKERS = 2; // only 2 decodes at a time
  const prefetchQueue = [];
  const activeWorkerMap = new Map();

  function decodeHeic(filePath) {
    if (heicCache.has(filePath)) return heicCache.get(filePath);

    if (heicCache.size >= HEIC_CACHE_MAX) {
      heicCache.delete(heicCache.keys().next().value);
    }

    const promise = new Promise((resolve, reject) => {
      const run = () => {
        activeWorkers++;
        const worker = new Worker(path.join(__dirname, "heic-worker.js"), {
          workerData: { filePath },
        });
        activeWorkerMap.set(filePath, worker);

        worker.on("message", (msg) => {
          activeWorkers--;
          activeWorkerMap.delete(filePath);
          if (prefetchQueue.length > 0) prefetchQueue.shift()();
          if (msg.success) resolve(Buffer.from(msg.buffer));
          else reject(new Error(msg.error));
        });
        worker.on("error", (err) => {
          activeWorkers--;
          activeWorkerMap.delete(filePath);
          if (prefetchQueue.length > 0) prefetchQueue.shift()();
          reject(err);
        });
      };

      if (activeWorkers < MAX_WORKERS) {
        run();
      } else {
        run.filePath = filePath;
        prefetchQueue.push(run);
      }
    });

    promise.catch(() => heicCache.delete(filePath));
    heicCache.set(filePath, promise);
    return promise;
  }

  function getSettings() {
    try {
      return JSON.parse(fs.readFileSync(configPath, "utf8"));
    } catch {
      return defaultConfig;
    }
  }

  appServer.get("/cancel-heic/*", (req, res) => {
    const filePath = applyDriveLetterMap(
      decodeURIComponent(req.path.replace("/cancel-heic/", "")),
      getDriveLetterMap(),
    );

    const worker = activeWorkerMap.get(filePath);
    if (worker) {
      worker.terminate();
      activeWorkerMap.delete(filePath);
      activeWorkers--;
      heicCache.delete(filePath); // remove incomplete cache entry
      if (prefetchQueue.length > 0) prefetchQueue.shift()(); // let next in queue run
    } else {
      // Still in queue, just remove it
      const idx = prefetchQueue.findIndex((fn) => fn.filePath === filePath);
      if (idx !== -1) prefetchQueue.splice(idx, 1);
    }

    res.sendStatus(204);
  });

  appServer.get("/prefetch-heic/*", (req, res) => {
    const filePath = applyDriveLetterMap(
      decodeURIComponent(req.path.replace("/prefetch-heic/", "")),
      getDriveLetterMap(),
    );
    if (fs.existsSync(filePath)) decodeHeic(filePath); // fire and forget, starts caching
    res.sendStatus(204);
  });

  async function decodeHeicSimple(filePath) {
    const inputBuffer = fs.readFileSync(filePath);
    const heicImage = await heicDecode({ buffer: inputBuffer });
    return sharp(heicImage.data, {
      raw: { width: heicImage.width, height: heicImage.height, channels: 4 },
    })
      .jpeg({ quality: 80 })
      .toBuffer();
  }

  // Serve files from any path on disk
  appServer.get("/files/*", async (req, res) => {
    const rawPath = decodeURIComponent(req.path.replace("/files/", ""));
    const filePath = applyDriveLetterMap(rawPath, getDriveLetterMap());

    if (!fs.existsSync(filePath)) {
      return res.status(404).send("Not found");
    }

    const ext = path.extname(filePath).toLowerCase();

    const rawExtensions = [
      ".dng",
      ".cr2",
      ".nef",
      ".arw",
      ".orf",
      ".rw2",
      ".raw",
      ".raf",
      ".pef",
      ".srw",
      ".x3f",
      ".kdc",
      ".dcr",
      ".mrw",
      ".erf",
      ".3fr",
      ".mef",
      ".rwl",
      ".iiq",
    ];

    try {
      if (ext === ".heic") {
        const settings = getSettings();
        if (settings.preloadHeic) {
          const outputBuffer = await decodeHeic(filePath); // worker + cache path
          return res.type("jpeg").send(outputBuffer);
        } else {
          const outputBuffer = await decodeHeicSimple(filePath); // old simple path
          return res.type("jpeg").send(outputBuffer);
        }
      } else if (ext === ".tif" || ext === ".tiff") {
        const outputBuffer = await sharp(filePath)
          .jpeg({ quality: 80 })
          .toBuffer();
        res.type("jpeg").send(outputBuffer);
      } else if (rawExtensions.includes(ext)) {
        try {
          const hash = crypto.createHash("md5").update(filePath).digest("hex");
          const tmpRaw = path.join(os.tmpdir(), `orbit_raw_${hash}.jpg`);

          if (!fs.existsSync(tmpRaw)) {
            const dcraw = require("dcraw");
            const rawBuffer = fs.readFileSync(filePath);
            // dcraw with -e flag extracts the embedded thumbnail/preview
            const jpegBuffer = dcraw(rawBuffer, { extractThumbnail: true });
            fs.writeFileSync(tmpRaw, jpegBuffer);
          }

          return res.type("jpeg").sendFile(tmpRaw);
        } catch (err) {
          console.error("RAW preview extraction failed:", err.message);
          return res.status(500).send("RAW not supported on this system");
        }
      } else if (ext === ".avi" || ext === ".wmv" || ext === ".3gp") {
        const hash = crypto.createHash("md5").update(filePath).digest("hex");
        const tmpPath = path.join(os.tmpdir(), `orbit_${hash}.mp4`);

        // Serve cached transcode if it exists
        if (fs.existsSync(tmpPath)) {
          return res.sendFile(tmpPath);
        }

        // Otherwise transcode to temp file first, then serve
        await new Promise((resolve, reject) => {
          ffmpeg(filePath)
            .outputFormat("mp4")
            .videoCodec("libx264")
            .audioCodec("aac")
            .outputOptions([
              "-preset ultrafast",
              "-crf 28",
              "-movflags +faststart",
            ])
            .on("error", reject)
            .on("end", resolve)
            .save(tmpPath);
        });

        res.sendFile(tmpPath);
      } else {
        // Default: just serve file
        res.sendFile(filePath);
      }
    } catch (err) {
      console.error(`Failed to convert ${ext} file:`, err);
      res.status(500).send("Conversion failed");
    }
  });

  const server = appServer.listen(serverPort);

  server.once("listening", () => {
    console.log(`Local file server running on http://localhost:${serverPort}`);
  
    // Dev:
    mainWindow.loadURL("http://localhost:3000");
    // Prod:
    // mainWindow.loadFile(path.join(__dirname, 'index.html'));
  });
  
  server.once("error", async (err) => {
    if (err.code === "EADDRINUSE") {
      if (splash && !splash.isDestroyed()) {
        splash.close();
      }
  
      await dialog.showMessageBox({
        type: "error",
        title: "Orbit",
        message: "Orbit couldn't start.",
        detail:
          "The required local server port (54055) is already in use.\n\nPlease close the application using that port and try again.",
      });
  
      app.quit();
      return;
    }
  
    throw err;
  });
});

let dataDir;
let configPath;
let dbPath;
const defaultConfig = {
  welcomePopupSeen: false,
  username: null,
  indexedFolders: [],
  birthDate: null,
  adjustHeicColors: true,
  defaultSort: "media_id",
  openMemoriesIn: "explorer", // "explorer", "shuffle" or "map"
  itemText: "filename", // "filename", "datetime" or "none"
  noGutters: false,
  preloadHeic: false,
  showThumbnailWhileFullImageLoads: false,
  unavailableBehaviour: "overlay", // "overlay" or "thumbnail"
  memoriesLayout: "list",
  placesSortBy: "count",
  placesChronological: false,
  placesThumbnails: "random",
  placesSubtitles: "count",
  placesMinCount: 1,
  placesExcludeFlights: false,
  placesSelectionMode: "smart",
  placesNameDisplay: "english",
  placesRegionNames: "english",
  placesCountryNames: "name",
  explorerDateScroll: true,
  mapStyle: "default",
  tableStyle: "comfortable",
  mediaFilter: "none",
  hideScreenshotsAndScreenRecordings: false,
  excludeScreenCapturesFromMilestones: false,
  smartSearchPaused: false,
  locationIndexingPaused: false,
  ocrIndexingPaused: false,
  driveLetterMap: {},
  hiddenFolders: [],
};

// Database
let db;

function initPaths() {
  dataDir = path.join(app.getPath("userData"), "data");
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  configPath = path.join(dataDir, "config.json");
  dbPath = path.join(dataDir, "orbit-index.db");
  resourceManager = new ResourceManager({
    userDataDir: app.getPath("userData"),
    onStatusChange: publishResourceStatus,
  });
}

function publishResourceStatus(status) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("resource-status", status);
  }
}

function getResourceStatus(id) {
  return resourceManager?.getStatus(id) ?? {
    id,
    state: "download-required",
    installed: false,
    downloadSizeLabel: null,
  };
}

function readConfig() {
  try {
    return {
      ...defaultConfig,
      ...JSON.parse(fs.readFileSync(configPath, "utf8")),
    };
  } catch {
    return { ...defaultConfig };
  }
}

function saveConfigPatch(patch) {
  const config = { ...readConfig(), ...patch };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
  return config;
}

// A paused service has no indexing worker to report progress. Keep that UI
// responsive by calculating its snapshot in a short-lived worker, then cache
// it. Running COUNT queries directly in this process caused visible stalls on
// large libraries every time the status panel polled for an update.
const progressSnapshots = new Map();
const progressSnapshotLoads = new Map();

function invalidateProgressSnapshots() {
  progressSnapshots.clear();
}

function getProgressSnapshot(type, locationGeocoderVersion = null) {
  const cached = progressSnapshots.get(type);
  if (cached) return Promise.resolve(cached);

  const inFlight = progressSnapshotLoads.get(type);
  if (inFlight) return inFlight;

  const load = new Promise((resolve) => {
    const worker = new Worker(path.join(__dirname, "progress-snapshot-worker.js"), {
      workerData: { dbPath, type, locationGeocoderVersion },
    });
    let settled = false;

    const finish = (snapshot) => {
      if (settled) return;
      settled = true;
      progressSnapshotLoads.delete(type);
      if (snapshot) progressSnapshots.set(type, snapshot);
      resolve(snapshot ?? { total: 0, done: 0 });
    };

    worker.once("message", (message) => {
      if (!message?.success) {
        console.warn("Unable to read paused indexing progress:", message?.error);
        finish();
        return;
      }
      finish({ total: message.total ?? 0, done: message.done ?? 0 });
    });
    worker.once("error", (error) => {
      console.warn("Unable to read paused indexing progress:", error.message);
      finish();
    });
    worker.once("exit", (code) => {
      if (code !== 0) {
        console.warn(`Paused indexing progress worker exited with code ${code}`);
      }
      finish();
    });
  });

  progressSnapshotLoads.set(type, load);
  return load;
}

function initDatabase() {
  if (!db) {
    db = new Database(dbPath);

    db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      media_id INTEGER UNIQUE,
      filename TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      size INTEGER,
      created INTEGER,
      modified INTEGER,
      extension TEXT,
      folder_path TEXT NOT NULL,
      indexed_at INTEGER DEFAULT (strftime('%s', 'now')),
      file_type TEXT,
      capture_type TEXT,
      device_model TEXT,
      camera_make TEXT,
      camera_model TEXT,
      width INTEGER,
      height INTEGER,
      orientation INTEGER,
      latitude REAL,
      longitude REAL,
      altitude REAL,
      create_date INTEGER,
      create_date_local TEXT,
      thumbnail_path TEXT,
      lens_model TEXT,
      iso INTEGER,
      software TEXT,
      offset_time_original TEXT,
      megapixels REAL,
      exposure_time TEXT,
      color_space TEXT,
      flash TEXT,
      aperture REAL,
      focal_length REAL,
      focal_length_35mm REAL,
      country TEXT
    )
  `);

    db.exec(`
    CREATE TABLE IF NOT EXISTS folders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT NOT NULL UNIQUE,
      indexed_at INTEGER DEFAULT (strftime('%s', 'now'))
    )
  `);

    db.exec(`
    CREATE TABLE IF NOT EXISTS tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      color TEXT,
      media_ids TEXT DEFAULT '[]',
      last_used INTEGER
    )
  `);

    db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT,
      color TEXT,
      media_ids TEXT DEFAULT '[]',
      created INTEGER,
      sort_order INTEGER DEFAULT 0
    )
  `);

    db.exec(`
    CREATE TABLE IF NOT EXISTS removed_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT NOT NULL UNIQUE,
      folder_path TEXT NOT NULL,
      removed_at INTEGER DEFAULT (strftime('%s', 'now'))
    )
  `);

    // SQLite's CREATE TABLE IF NOT EXISTS does not add columns to databases
    // created by earlier versions, so migrate this schema addition explicitly.
    const fileColumns = db.prepare("PRAGMA table_info(files)").all();
    if (!fileColumns.some((column) => column.name === "capture_type")) {
      db.exec("ALTER TABLE files ADD COLUMN capture_type TEXT");
    }

    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_files_create_date_local ON files(create_date_local);
    CREATE INDEX IF NOT EXISTS idx_files_create_date ON files(create_date);
    CREATE INDEX IF NOT EXISTS idx_files_filename ON files(filename);
    CREATE INDEX IF NOT EXISTS idx_files_size ON files(size);
    CREATE INDEX IF NOT EXISTS idx_files_created ON files(created);
  `);
  }
}

function startEmbeddingService() {
  if (embeddingService) return;
  if (!resourceManager?.isInstalled("smart-search")) return;
  initDatabase();
  embeddingService = new EmbeddingService(
    db,
    dataDir,
    () => mainWindow,
    resourceManager.getInstallDirectory("smart-search"),
  );
  if (readConfig().smartSearchPaused) {
    embeddingService.setInitialPaused(true);
    return;
  }
  embeddingService.start();
}

function startLocationService() {
  if (locationService) return;
  if (!resourceManager?.isInstalled("places")) return;
  initDatabase();

  const config = readConfig();
  locationService = new LocationService(
    db,
    dataDir,
    resourceManager.getExpectedFilePath("places", "places.db"),
    () => mainWindow,
    normalizeLocationSelectionMode(config.placesSelectionMode),
  );
  if (config.locationIndexingPaused) {
    locationService.setInitialPaused(true);
    return;
  }
  locationService.start();
}

function startOcrService() {
  if (ocrService) return;
  if (!resourceManager?.isInstalled("ocr")) return;
  initDatabase();
  ocrService = new OcrService(
    db,
    () => mainWindow,
    resourceManager.getInstallDirectory("ocr"),
  );
  if (readConfig().ocrIndexingPaused) {
    ocrService.setInitialPaused(true);
    return;
  }
  ocrService.start();
}

ipcMain.handle("read-file", async (_event, relativePath) => {
  // Resolve relative to the app's resources / public directory.
  // Adjust __dirname / app.getAppPath() to match your project layout.
  const fullPath = path.join(__dirname, relativePath);
  return fs.readFileSync(fullPath, "utf-8");
});


ipcMain.handle("fix-media-ids", async () => {
  try {
    initDatabase();

    db.transaction(() => {
      // Step 1: move existing media_id out of the way
      db.prepare(
        `
        UPDATE files
        SET media_id = -id
      `,
      ).run();

      // Step 2: reassign correctly ordered media_ids
      const rows = db
        .prepare(
          `
        SELECT id
        FROM files
        ORDER BY
          COALESCE(create_date, MIN(created, modified)) ASC,
          id ASC
      `,
        )
        .all();

      let counter = 1;
      for (const row of rows) {
        db.prepare("UPDATE files SET media_id = ? WHERE id = ?").run(
          counter,
          row.id,
        );
        counter++;
      }
    })();

    return { success: true, message: "media_id column fixed successfully." };
  } catch (err) {
    console.error("Error fixing media_id:", err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle("tags:get-all", async () => {
  try {
    initDatabase();

    const rows = db.prepare("SELECT * FROM tags ORDER BY last_used DESC").all();

    return rows.map((row) => ({
      ...row,
      media_ids: JSON.parse(row.media_ids || "[]"),
    }));
  } catch (err) {
    console.error("tags:get-all error:", err);
    return [];
  }
});

ipcMain.handle("tags:save", async (event, tag) => {
  initDatabase();

  if (tag.id) {
    db.prepare(
      `
      UPDATE tags SET name = ?, description = ?, color = ?, media_ids = ?
      WHERE id = ?
    `,
    ).run(
      tag.name,
      tag.description,
      tag.color,
      JSON.stringify(tag.media_ids || []),
      tag.id,
    );

    return { success: true, updated: true };
  } else {
    const info = db
      .prepare(
        `
      INSERT INTO tags (name, description, color, media_ids)
      VALUES (?, ?, ?, ?)
    `,
      )
      .run(
        tag.name,
        tag.description,
        tag.color,
        JSON.stringify(tag.media_ids || []),
      );
    return { success: true, id: info.lastInsertRowid };
  }
});

ipcMain.handle("tags:delete", async (event, id) => {
  initDatabase();
  db.prepare("DELETE FROM tags WHERE id = ?").run(id);
  return { success: true };
});

// Config handlers
ipcMain.handle("get-settings", async () => {
  if (!fs.existsSync(configPath))
    fs.writeFileSync(
      configPath,
      JSON.stringify(defaultConfig, null, 2),
      "utf8",
    );

  return readConfig();
});

ipcMain.handle("save-settings", async (event, settings) => {
  try {
    const currentConfig = readConfig();
    const previousSelectionMode = normalizeLocationSelectionMode(
      currentConfig.placesSelectionMode,
    );
    const nextSelectionMode = normalizeLocationSelectionMode(
      settings?.placesSelectionMode ?? previousSelectionMode,
    );
    const nextNameDisplay =
      settings?.placesNameDisplay === "local" ? "local" : "english";
    const nextRegionNames =
      settings?.placesRegionNames === "local"
        ? "local"
        : settings?.placesRegionNames === "code"
          ? "code"
          : "english";
    const nextCountryNames =
      settings?.placesCountryNames === "code" ? "code" : "name";
    fs.writeFileSync(
      configPath,
      JSON.stringify(
        {
          ...settings,
          placesSelectionMode: nextSelectionMode,
          placesNameDisplay: nextNameDisplay,
          placesRegionNames: nextRegionNames,
          placesCountryNames: nextCountryNames,
          smartSearchPaused: currentConfig.smartSearchPaused,
          locationIndexingPaused: currentConfig.locationIndexingPaused,
        },
        null,
        2,
      ),
      "utf8",
    );
    if (previousSelectionMode !== nextSelectionMode) {
      invalidateProgressSnapshots();
      if (!locationService) startLocationService();
      locationService?.regenerate(nextSelectionMode);
    }
    return {
      success: true,
      locationsRegenerating: previousSelectionMode !== nextSelectionMode,
    };
  } catch (err) {
    console.error(err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle("open-orbit-location", () => {
  let appPath = app.getAppPath();

  // In production, go two levels up to reach the app root
  if (app.isPackaged) {
    appPath = path.join(appPath, "..", "..");
  }

  shell.openPath(appPath);
});

ipcMain.handle("open-data-location", () => {
  shell.openPath(dataDir);
});

ipcMain.handle("open-resources-location", () => {
  const resourcesDirectory =
    resourceManager?.resourcesDirectory ??
    path.join(app.getPath("userData"), "resources");
  fs.mkdirSync(resourcesDirectory, { recursive: true });
  shell.openPath(resourcesDirectory);
});

ipcMain.handle("open-in-default-viewer", async (event, rawPath) => {
  try {
    const filePath = applyDriveLetterMap(rawPath, getDriveLetterMap());
    await shell.openPath(filePath);
    return { success: true };
  } catch (err) {
    console.error("Failed to open file:", err);
    return { success: false, error: err.message };
  }
});

// Folder selection
ipcMain.handle("select-folders", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory", "multiSelections"],
    title: "Select folders to index",
  });
  return result.canceled ? [] : result.filePaths;
});

function applyIdsFilter(db, ids) {
  db.prepare(`DROP TABLE IF EXISTS temp_ids`).run();
  db.prepare(
    `CREATE TEMP TABLE temp_ids (id INTEGER PRIMARY KEY, rank INTEGER)`,
  ).run();

  const insert = db.prepare(`INSERT INTO temp_ids (id, rank) VALUES (?, ?)`);
  const insertMany = db.transaction((ids) => {
    ids.forEach((id, i) => insert.run(id, i));
  });

  insertMany(ids);

  return "id IN (SELECT id FROM temp_ids)";
}

function buildWhereClause(rawFilters = {}, options = {}) {
  const filters = rawFilters ?? {};
  const clauses = [];
  const params = [];

  const localDateExpr =
    options.localDateExpr ??
    `
    CASE
      WHEN create_date_local IS NOT NULL
        THEN date(create_date_local)
      WHEN create_date IS NOT NULL
        THEN date(datetime(create_date, 'unixepoch', 'localtime'))
      ELSE
        date(datetime(MIN(created, modified), 'unixepoch', 'localtime'))
    END
  `;

  const add = (sql, value) => {
    clauses.push(sql);
    if (value !== undefined) params.push(value);
  };

  // shared filters
  if (Array.isArray(filters.ids) && filters.ids.length) {
    clauses.push(applyIdsFilter(db, filters.ids));
  }

  if (filters.dateFrom) {
    add(`${localDateExpr} >= date(?)`, filters.dateFrom);
  }
  if (filters.dateTo) {
    add(`${localDateExpr} <= date(?)`, filters.dateTo);
  }
  if (filters.dateExact) {
    add(`${localDateExpr} = date(?)`, filters.dateExact);
  }

  if (filters.device) add("device_model = ?", filters.device);
  if (filters.folder) add("folder_path = ?", filters.folder);
  if (filters.filetype) add("extension = ?", filters.filetype);
  if (filters.mediaType) add("file_type = ?", filters.mediaType);
  if (filters.captureType) add("capture_type = ?", filters.captureType);
  if (filters.lens) add("lens_model = ?", filters.lens);
  if (filters.country) {
    add(
      "',' || REPLACE(country, ' ', '') || ',' LIKE ?",
      `%,${
        filters.country
      },%`
    );
  }

  if (filters.tagId) {
    clauses.push(`
      id IN (
        SELECT value
        FROM tags, json_each(tags.media_ids)
        WHERE tags.id = ?
      )
    `);
    params.push(Number(filters.tagId));
  }

  if (filters.searchBy && filters.searchTerm) {
    if (filters.searchBy === "media_id") {
      add("media_id = ?", filters.searchTerm);
    } else if (filters.searchBy === "name") {
      add("filename LIKE ?", `%${filters.searchTerm}%`);
    } else if (filters.searchBy === "location") {
      const term = `%${filters.searchTerm}%`;
    
      clauses.push(`
        id IN (
          SELECT file_id
          FROM locations
          WHERE country     LIKE ?
             OR subdivision LIKE ?
             OR city        LIKE ?
             OR local_name  LIKE ?
             OR english_name LIKE ?
        )
      `);
    
      params.push(term, term, term, term, term);
    }
  }

  if (options.excludeScreenCaptures) {
    clauses.push(
      "COALESCE(capture_type, '') NOT IN ('screenshot', 'screen_recording')",
    );
  }

  const hiddenFolders = Array.isArray(options.hiddenFolders)
    ? options.hiddenFolders.filter(Boolean)
    : [];
  if (hiddenFolders.length) {
    clauses.push(
      `folder_path NOT IN (${hiddenFolders.map(() => "?").join(", ")})`,
    );
    params.push(...hiddenFolders);
  }

  // global safety filter
  if (options.allowUndated !== true) {
    clauses.push(`(
      create_date_local IS NOT NULL
      OR create_date IS NOT NULL
      OR created IS NOT NULL
      OR modified IS NOT NULL
    )`);
  }

  return {
    sql: clauses.length ? "WHERE " + clauses.join(" AND ") : "",
    params,
  };
}

// Fetch paginated files for the UI
// Args: { offset: number, limit: number }
// Returns: array of rows [{ id, filename, thumbnail_path, path, width, height, file_type }]
ipcMain.handle(
  "fetch-files",
  async (
    event,
    { offset = 0, limit = 200, filters = {}, settings = {}, idsOnly = false },
  ) => {
    try {
      initDatabase();
      settings = settings ?? {};

      const { sql: whereSQL, params } = buildWhereClause(filters, {
        excludeScreenCaptures: !!settings.hideScreenshotsAndScreenRecordings,
        hiddenFolders: settings.hiddenFolders,
      });

      // --- sorting ---
      let orderSQL = "";
      if (filters.sortBy === "random") {
        orderSQL = "ORDER BY RANDOM()";
      } else if (
        Array.isArray(filters.ids) &&
        filters.ids.length > 0 &&
        (filters._smartSearch || filters._textSearch)
      ) {
        // Relevance search: preserve rank order supplied by the caller.
        // temp_ids.rank was populated in the same order as filters.ids.
        orderSQL = `ORDER BY (SELECT rank FROM temp_ids WHERE temp_ids.id = files.id) ASC`;
      } else {
        const validSorts = [
          "media_id",
          "filename",
          "create_date_local",
          "created",
          "size",
        ];
        const safeSortBy = validSorts.includes(filters.sortBy)
          ? filters.sortBy
          : settings && settings.defaultSort
            ? settings.defaultSort
            : "media_id";
        const safeSortOrder = filters.sortOrder
          ? filters.sortOrder.toUpperCase()
          : "DESC";
        if (filters.sortBy === "create_date_local") {
          orderSQL = `ORDER BY
          CASE
            WHEN create_date_local IS NOT NULL THEN create_date_local
            ELSE datetime(create_date, 'unixepoch', 'localtime')
          END ${safeSortOrder}`;
        } else {
          orderSQL = `ORDER BY ${safeSortBy} ${safeSortOrder}`;
        }
      }

      if (idsOnly) {
        const stmt = db.prepare(`SELECT id FROM files ${whereSQL} ${orderSQL}`);
        const rows = stmt.all(...params);
        return { success: true, rows, totalCount: rows.length };
      }

      const countStmt = db.prepare(
        `SELECT COUNT(*) as count FROM files ${whereSQL}`,
      );
      const totalCount = countStmt.get(...params).count;

      const stmt = db.prepare(`
      SELECT *
      FROM files
      ${whereSQL}
      ${orderSQL}
      LIMIT ? OFFSET ?
    `);

      const rows = stmt.all(...params, limit, offset);

      const map = getDriveLetterMap();
      const mappedRows = rows.map((r) => ({
        ...r,
        path: applyDriveLetterMap(r.path, map),
        folder_path: applyDriveLetterMap(r.folder_path, map),
      }));

      return { success: true, rows: mappedRows, totalCount };
    } catch (err) {
      console.error("fetch-files error:", err);
      return { success: false, error: err.message, rows: [], totalCount: 0 };
    }
  },
);

ipcMain.handle("fetch-file-overview", async (event, { filters = {}, settings = {} }) => {
  initDatabase();
  settings = settings ?? {};

  const { sql: whereSQL, params } = buildWhereClause(filters, {
    excludeScreenCaptures: !!settings.hideScreenshotsAndScreenRecordings,
    hiddenFolders: settings.hiddenFolders,
  });

  const stmt = db.prepare(`
    SELECT id, thumbnail_path
    FROM files
    ${whereSQL}
    ORDER BY media_id DESC
  `);

  const rows = stmt.all(...params);

  return { success: true, rows };
});

ipcMain.handle(
  "fetch-map-data",
  async (event, { filters = {}, settings = {} } = {}) => {
    try {
      initDatabase();

      const { sql, params } = buildWhereClause(filters, {
        allowUndated: true,
        hiddenFolders: settings.hiddenFolders,
      });

      const whereSQL = [
        "latitude IS NOT NULL",
        "longitude IS NOT NULL",
        sql.replace(/^WHERE\s*/, ""),
      ]
        .filter(Boolean)
        .join(" AND ");
      
      const finalWhere = whereSQL ? `WHERE ${whereSQL}` : "";

      const rows = db
        .prepare(
          `
      SELECT latitude, longitude, altitude, country, create_date, filename, device_model, media_id, id, thumbnail_path
      FROM files
      ${finalWhere}
    `,
        )
        .all(...params);

      const points = [];
      const heat = [];
      const countryCounts = {};
      const countryBounds = {};
      let lineSegments = [];
      let currentSegment = [];
      let lastPoint = null;

      const haversineDistance = (a, b) => {
        const R = 6371;
        const toRad = (x) => (x * Math.PI) / 180;
        const dLat = toRad(b[0] - a[0]);
        const dLon = toRad(b[1] - a[1]);
        const lat1 = toRad(a[0]);
        const lat2 = toRad(b[0]);
        const h =
          Math.sin(dLat / 2) ** 2 +
          Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
        return 2 * R * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
      };

      for (const item of rows) {
        const latlng = [item.latitude, item.longitude];
        points.push({
          lat: item.latitude,
          lng: item.longitude,
          popup: {
            filename: item.filename,
            date: item.create_date,
            device: item.device_model,
            country: item.country,
            altitude: item.altitude,
            item_id: item.id,
            id: item.media_id,
            thumbnail_path: item.thumbnail_path,
          },
        });
        heat.push([item.latitude, item.longitude, 1]);
        if (item.country) {
          for (const c of normalizeCountries(item.country)) {
            countryCounts[c] = (countryCounts[c] || 0) + 1;
            (countryBounds[c] ||= []).push(latlng);
          }
          if((item.altitude || item.altitude === 0) && item.altitude <= 1500) {
            if (lastPoint) {
              const dist = haversineDistance(lastPoint, latlng);
              if (dist > 200) {
                if (currentSegment.length > 1) lineSegments.push(currentSegment);
                currentSegment = [];
              }
            }
            currentSegment.push(latlng);
            lastPoint = latlng;
          }
        }
      }

      if (currentSegment.length > 1) lineSegments.push(currentSegment);

      return {
        success: true,
        points,
        heat,
        lines: lineSegments,
        countryCounts,
        countryBounds,
      };
    } catch (err) {
      console.error("fetch-map-data error:", err);
      return { success: false, error: err.message };
    }
  },
);

// Load the mapped JSON once on startup
const countriesPath = path.join(__dirname, "countries_mapped.json");
const countriesMap = JSON.parse(fs.readFileSync(countriesPath, "utf8"));

ipcMain.handle("get-country-name", async (event, isoCode) => {
  if (!isoCode) return null;

  // Normalize code to uppercase
  const code = isoCode.toUpperCase();

  // Lookup in the mapped JSON
  return countriesMap[code] || null;
});

ipcMain.handle("get-filtered-files-count", async (event, args = {}) => {
  try {
    initDatabase();

    const filters = args.filters ?? {};
    const settings = args.settings ?? {};

    const { sql, params } = buildWhereClause(filters, {
      excludeScreenCaptures: !!settings.hideScreenshotsAndScreenRecordings,
      hiddenFolders: settings.hiddenFolders,
    });

    const result = db
      .prepare(`SELECT COUNT(*) as count FROM files ${sql}`)
      .get(...params);

    return result?.count || 0;
  } catch (err) {
    console.error("get-filtered-files-count error", err);
    return 0;
  }
});

ipcMain.handle("tag:add-item", async (event, { tagId, mediaId }) => {
  try {
    initDatabase();

    const tagRow = db
      .prepare("SELECT media_ids FROM tags WHERE id = ?")
      .get(tagId);
    if (!tagRow) throw new Error(`Tag ${tagId} not found`);

    const ids = JSON.parse(tagRow.media_ids || "[]");
    if (!ids.includes(mediaId)) ids.push(mediaId);

    const now = Date.now();
    db.prepare("UPDATE tags SET media_ids = ?, last_used = ? WHERE id = ?").run(
      JSON.stringify(ids),
      now,
      tagId,
    );

    return { success: true, ids };
  } catch (err) {
    console.error("tag:add-item error:", err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle("tag:remove-item", async (event, { tagId, mediaId }) => {
  try {
    initDatabase();

    const tagRow = db
      .prepare("SELECT media_ids FROM tags WHERE id = ?")
      .get(tagId);
    if (!tagRow) throw new Error(`Tag ${tagId} not found`);

    const ids = JSON.parse(tagRow.media_ids || "[]").filter(
      (id) => id !== mediaId,
    );

    const now = Date.now();
    db.prepare("UPDATE tags SET media_ids = ?, last_used = ? WHERE id = ?").run(
      JSON.stringify(ids),
      now,
      tagId,
    );

    return { success: true, ids };
  } catch (err) {
    console.error("tag:remove-item error:", err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle("index-files", async (event, folders) => {
  try {
    initDatabase();

    for (const folder of folders) {
      // Load existing files for this folder
      const existingPaths = loadIndexedPaths();

      db.prepare("INSERT OR IGNORE INTO folders (path) VALUES (?)").run(folder);

      // Count total files once for progress tracking
      const totalFiles = countTotalFiles(folder, existingPaths);
      let processedFiles = 0;

      // Send initial progress
      if (mainWindow) {
        mainWindow.webContents.send("indexing-progress", {
          filename: "",
          processed: 0,
          total: totalFiles,
          percentage: 0,
        });
      }

      // New async call style
      await indexFilesRecursively(folder, existingPaths, (processed) => {
        processedFiles = processed;
        const percentage =
          totalFiles > 0 ? Math.round((processedFiles / totalFiles) * 100) : 0;

        if (mainWindow) {
          mainWindow.webContents.send("indexing-progress", {
            filename: "",
            processed: processedFiles,
            total: totalFiles,
            percentage,
          });
        }
      });
    }

    invalidateProgressSnapshots();
    return { success: true, message: "Files indexed successfully" };
  } catch (err) {
    console.error(err);
    return { success: false, error: err.message };
  }
});

async function generateThumbnail(filePath, id) {
  const ext = path.extname(filePath).toLowerCase();
  const imageExtensions = [
    ".jpg",
    ".jpeg",
    ".png",
    ".gif",
    ".bmp",
    ".tiff",
    ".tif",
    ".webp",
  ];
  const videoExtensions = [
    ".mp4",
    ".mov",
    ".avi",
    ".mkv",
    ".webm",
    ".wmv",
    ".3gp",
    ".flv",
  ];
  const rawExtensions = [
    ".dng",
    ".cr2",
    ".nef",
    ".arw",
    ".orf",
    ".rw2",
    ".raw",
    ".raf",
    ".pef",
    ".srw",
    ".x3f",
    ".kdc",
    ".dcr",
    ".mrw",
    ".erf",
    ".3fr",
    ".mef",
    ".rwl",
    ".iiq",
  ];

  const thumbnailsDir = path.join(dataDir, "thumbnails");
  if (!fs.existsSync(thumbnailsDir))
    fs.mkdirSync(thumbnailsDir, { recursive: true });

  const thumbnailFilename = `${id}_thumb.jpg`;
  const thumbnailPath = path.join(thumbnailsDir, thumbnailFilename);

  try {
    if (imageExtensions.includes(ext)) {
      // --- Image thumbnails ---
      await sharp(filePath, { failOnError: false })
        .rotate()
        .resize(200, 200, { fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 80 })
        .toFile(thumbnailPath);

      return thumbnailPath;
    } else if (rawExtensions.includes(ext)) {
      try {
        const dcraw = require("dcraw");
        const rawBuffer = fs.readFileSync(filePath);
        const jpegBuffer = dcraw(rawBuffer, { extractThumbnail: true });
        // Pipe through sharp to resize to thumbnail dimensions
        await sharp(jpegBuffer, { failOnError: false })
          .rotate()
          .resize(200, 200, { fit: "inside", withoutEnlargement: true })
          .jpeg({ quality: 80 })
          .toFile(thumbnailPath);
        return thumbnailPath;
      } catch (err) {
        console.warn(`RAW thumbnail failed for ${filePath}:`, err.message);
        return null;
      }
    } else if (videoExtensions.includes(ext)) {
      // --- Video thumbnails ---
      await new Promise((resolve, reject) => {
        ffmpeg(filePath)
          .on("end", resolve)
          .on("error", reject)
          .screenshots({
            timestamps: ["10%"], // capture a frame ~10% into the video
            filename: thumbnailFilename,
            folder: thumbnailsDir,
            size: "200x?",
          });
      });

      return thumbnailPath;
    } else {
      return null; // unsupported file type
    }
  } catch (err) {
    console.warn(
      `Thumbnail skipped for ${filePath}: ${summarizeThumbnailError(err)}`,
    );
    return null;
  }
}

function summarizeThumbnailError(error) {
  const message = String(error?.message || error || "Unknown error");
  const usefulLine = message
    .split(/\r?\n/)
    .find(
      (line) =>
        /moov atom not found|invalid data found|permission denied|no such file/i.test(
          line,
        ),
    );

  return (usefulLine || message.split(/\r?\n/)[0]).trim();
}

ipcMain.handle("minimize-app", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  win.minimize();
});

ipcMain.handle("fetch-heic-missing-thumbnails", async () => {
  initDatabase();
  const rows = db
    .prepare(
      `
    SELECT id, path FROM files WHERE extension = '.heic' AND thumbnail_path IS NULL
  `,
    )
    .all();
  return { success: true, files: rows };
});

ipcMain.handle("cleanup-heic-temp", async () => {
  try {
    const thumbsPath = path.join(dataDir, "thumbs");
    const jsonPath = path.join(dataDir, "heic_missing.json");
    const scriptPath = path.join(dataDir, "generate_heic_thumbs.py");

    if (fs.existsSync(thumbsPath)) {
      fs.rmSync(thumbsPath, { recursive: true, force: true });
    }
    if (fs.existsSync(jsonPath)) {
      fs.unlinkSync(jsonPath);
    }
    if (fs.existsSync(scriptPath)) {
      fs.unlinkSync(scriptPath);
    }

    return { success: true };
  } catch (err) {
    console.error("Failed cleanup:", err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle("generate-heic-script", async (event, files) => {
  const thumbsPath = path.join(dataDir, "thumbs");
  const tempJsonPath = path.join(dataDir, "heic_missing.json");
  const tempScriptPath = path.join(dataDir, "generate_heic_thumbs.py");

  // 🧹 cleanup old files first
  [thumbsPath, tempJsonPath, tempScriptPath].forEach((p) => {
    if (fs.existsSync(p)) {
      fs.rmSync(p, { recursive: true, force: true });
    }
  });
  const jsonPath = path.join(dataDir, "heic_missing.json");
  fs.writeFileSync(jsonPath, JSON.stringify(files, null, 2));

  const pythonScriptPath = path.join(dataDir, "generate_heic_thumbs.py");
  fs.writeFileSync(
    pythonScriptPath,
    `
import json
import os
from PIL import Image
import pillow_heif
from concurrent.futures import ProcessPoolExecutor, as_completed

# Register HEIC plugin
pillow_heif.register_heif_opener()

def generate_thumbnail(entry, thumbs_dir):
    file_id = entry["id"]
    file_path = entry["path"]
    try:
        img = Image.open(file_path)  # Pillow handles HEIC directly
        img.thumbnail((200, 200))
        out_path = os.path.join(thumbs_dir, f"{file_id}_thumb.jpg")
        img.save(out_path, "JPEG", quality=80)
        return f"Generated thumbnail for {file_path}"
    except Exception as e:
        return f"Failed: {file_path} -> {e}"

def main():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    json_file = os.path.join(script_dir, "heic_missing.json")
    with open(json_file, "r") as f:
        data = json.load(f)

    thumbs_dir = os.path.join(os.getcwd(), "thumbs")
    os.makedirs(thumbs_dir, exist_ok=True)

    # Use half the available cores by default (but at least 1)
    cpu_count = os.cpu_count() or 4
    max_workers = max(1, cpu_count // 2)
    print(f"Using {max_workers} parallel workers...")

    with ProcessPoolExecutor(max_workers=max_workers) as executor:
        futures = [executor.submit(generate_thumbnail, entry, thumbs_dir) for entry in data]
        for future in as_completed(futures):
            print(future.result())

    print("Done!")

if __name__ == "__main__":
    main()
`,
  );

  shell.showItemInFolder(pythonScriptPath); // highlight file in Explorer
  shell.showItemInFolder(jsonPath);

  return { success: true, message: "Python script and JSON ready!" };
});

// Metadata extraction using exiftool
async function extractMetadata(filePath) {
  const metadata = {
    file_type: null,
    device_model: null,
    camera_make: null,
    camera_model: null,
    width: null,
    height: null,
    orientation: null,
    latitude: null,
    longitude: null,
    altitude: null,
    create_date: null,
    create_date_local: null,
    lens_model: null,
    iso: null,
    software: null,
    offset_time_original: null,
    megapixels: null,
    exposure_time: null,
    color_space: null,
    flash: null,
    aperture: null,
    focal_length: null,
    focal_length_35mm: null,
    country: null,
  };

  const ext = path.extname(filePath).toLowerCase();
  const imageExtensions = [
    // Common images
    ".jpg",
    ".jpeg",
    ".png",
    ".gif",
    ".bmp",
    ".webp",

    // High quality / professional
    ".tiff",
    ".tif",
    ".heic",
    ".heif",

    // RAW camera formats
    ".dng",
    ".cr2", // Canon
    ".nef", // Nikon
    ".arw", // Sony
    ".orf", // Olympus
    ".rw2", // Panasonic

    // Vector / other
    ".svg",
    ".ico",
  ];

  const videoExtensions = [
    // Common formats
    ".mp4",
    ".mov",
    ".avi",
    ".mkv",
    ".webm",
    ".wmv",

    // Mobile / older
    ".3gp",
    ".3g2",

    // Flash / legacy
    ".flv",
    ".f4v",

    // Professional / streaming
    ".m4v",
    ".mpeg",
    ".mpg",
    ".ts",
    ".mts",
    ".m2ts",

    // Open / less common
    ".ogv",
  ];

  if (imageExtensions.includes(ext)) metadata.file_type = "image";
  else if (videoExtensions.includes(ext)) metadata.file_type = "video";
  else metadata.file_type = "other";

  try {
    const exifData = await exiftool.read(filePath);
    if (!exifData) {
      metadata.capture_type = classifyMediaCapture(filePath, metadata);
      return metadata;
    }

    metadata.camera_make = exifData.Make || null;
    metadata.camera_model = exifData.Model || null;
    metadata.device_model = exifData.Model || null;

    metadata.width = exifData.ImageWidth || exifData.ExifImageWidth || null;
    metadata.height = exifData.ImageHeight || exifData.ExifImageHeight || null;
    metadata.orientation = exifData.Orientation || null;

    if (exifData.GPSLatitude && exifData.GPSLongitude) {
      metadata.latitude = exifData.GPSLatitude;
      metadata.longitude = exifData.GPSLongitude;
      metadata.country = lookup(
        exifData.GPSLatitude,
        exifData.GPSLongitude,
        true,
      );
    }

    // Altitude
    if (exifData.GPSAltitude) metadata.altitude = exifData.GPSAltitude;

    // Create date priority:
    // 1. DateTimeOriginal — camera shutter time, already local, most accurate
    // 2. CreationDate    — MOV/MP4 field, includes timezone offset (e.g. "2024:01:01 00:09:28+01:00")
    // 3. CreateDate      — UTC-only fallback, least reliable for local time
    const rawDate = exifData.DateTimeOriginal ?? exifData.CreationDate ?? null;
    if (rawDate) {
      const dateStr =
        typeof rawDate === "object" ? rawDate.toString() : rawDate;
      const normalised = dateStr
        .replace(/^(\d{4}):(\d{2}):(\d{2})/, "$1-$2-$3")
        .replace("T", " ");
      metadata.create_date_local = normalised.substring(0, 19);
      metadata.create_date = Math.floor(new Date(normalised).getTime() / 1000);
    } else {
      // Fallback 3: filename-encoded local time (e.g. Android MP4: 20230101_000507.mp4)
      const fromFilename = parseFilenameDateTime(filePath);
      if (fromFilename) {
        metadata.create_date_local = fromFilename;
        metadata.create_date = Math.floor(
          new Date(fromFilename).getTime() / 1000,
        );
      } else {
        // Fallback 4: CreateDate (UTC) — store as-is, create_date_local will be wrong by UTC offset
        const utcRaw = exifData.CreateDate;
        if (utcRaw) {
          const dateStr =
            typeof utcRaw === "object" ? utcRaw.toString() : utcRaw;
          const normalised = dateStr.replace(
            /^(\d{4}):(\d{2}):(\d{2})/,
            "$1-$2-$3",
          );
          metadata.create_date_local = null; // explicitly null — UTC is not local time
          metadata.create_date = Math.floor(
            new Date(normalised).getTime() / 1000,
          );
        }
      }
    }

    metadata.lens_model = exifData.LensModel || exifData.Lens || null;
    metadata.iso = exifData.ISO || null;
    metadata.software = exifData.Software || null;
    metadata.offset_time_original = exifData.OffsetTimeOriginal || null;
    metadata.megapixels =
      exifData.ExifImageWidth && exifData.ExifImageHeight
        ? (exifData.ExifImageWidth * exifData.ExifImageHeight) / 1_000_000
        : null;
    metadata.exposure_time = exifData.ExposureTime || null;
    metadata.color_space = exifData.ColorSpace || null;
    metadata.flash = exifData.Flash || null;
    metadata.aperture = exifData.FNumber || null;
    metadata.focal_length = exifData.FocalLength || null;
    metadata.focal_length_35mm = exifData.FocalLengthIn35mmFormat || null;
  } catch (err) {
    console.log(`No EXIF data for ${filePath}: ${err.message}`);
  }

  metadata.capture_type = classifyMediaCapture(filePath, metadata);
  return metadata;
}

function getCapturePathSignals(filePath, fileType) {
  const sourceText = `${filePath || ""} ${path.basename(filePath || "")}`
    .toLowerCase()
    .replace(/[\\/_&-]+/g, " ");
  const extension = path.extname(filePath || "").toLowerCase();
  const isMixedCameraScreenshotsFolder = /\bcamera\s+(?:and\s+)?screenshots?\b/.test(
    sourceText,
  );
  const hasCameraSource =
    /\bdcim\b/.test(sourceText) || /\bcamera\b/.test(sourceText);
  const hasScreenRecordingSource = [
    "screen recording",
    "screenrecording",
    "screen recorder",
    "screenrecorder",
    "screen capture",
    "screencast",
  ].some((term) => sourceText.includes(term));
  const hasScreenshotSource =
    hasScreenRecordingSource ||
    (fileType === "image" && sourceText.includes("screenshot"));
  const isScreenshotFormat = fileType === "image" && extension === ".png";
  const isPhotographicFormat =
    fileType === "image" &&
    [".heic", ".heif", ".jpg", ".jpeg", ".dng", ".raw"].includes(
      extension,
    );

  // "Camera & Screenshots" is a mixed source. Its screenshot term is only a
  // weak hint, while a PNG remains strong evidence for a screenshot.
  const screenshotPathScore = hasScreenshotSource
    ? isMixedCameraScreenshotsFolder
      ? 1
      : 5
    : 0;

  return {
    cameraScore: (hasCameraSource ? 2 : 0) + (isPhotographicFormat ? 2 : 0),
    screenScore: screenshotPathScore + (isScreenshotFormat ? 5 : 0),
  };
}

function classifyMediaCapture(filePath, metadata) {
  const software = String(metadata.software || "").toLowerCase();
  const pathSignals = getCapturePathSignals(filePath, metadata.file_type);

  if (metadata.file_type === "image") {
    const cameraSignals = [
      metadata.camera_make,
      metadata.camera_model,
      metadata.lens_model,
      metadata.focal_length,
      metadata.focal_length_35mm,
      metadata.aperture,
      metadata.exposure_time,
      metadata.iso,
      metadata.flash,
    ].filter((value) => value != null && value !== "").length;

    const screenshotSoftware =
      software.includes("screenshot") || software.includes("snipping tool");

    const cameraScore =
      pathSignals.cameraScore + (cameraSignals >= 2 ? 4 : cameraSignals);
    const screenScore = pathSignals.screenScore + (screenshotSoftware ? 5 : 0);

    if (screenScore > cameraScore) return "screenshot";
    if (cameraScore >= 2) return "camera";

    return "unknown";
  }

  if (metadata.file_type === "video") {
    const cameraSignals = [
      metadata.camera_make,
      metadata.camera_model,
      metadata.device_model,
      metadata.lens_model,
      metadata.focal_length,
      metadata.focal_length_35mm,
      metadata.aperture,
      metadata.latitude,
      metadata.longitude,
      metadata.flash,
    ].filter((value) => value != null && value !== "").length;

    const screenRecordingSoftware =
      software.includes("screen recording") ||
      software.includes("screen recorder") ||
      software.includes("screenrecord");

    const cameraScore =
      pathSignals.cameraScore + (cameraSignals >= 2 ? 4 : cameraSignals);
    const screenScore =
      pathSignals.screenScore + (screenRecordingSoftware ? 5 : 0);

    if (screenScore > cameraScore) return "screen_recording";
    if (cameraScore >= 2) return "camera";

    return "unknown";
  }

  return "unknown";
}

const pLimit = require("p-limit");
const os = require("os");
const cpuCount = os.cpus().length;
const METADATA_CONCURRENCY = Math.max(1, Math.floor(cpuCount / 2)); // 1 task per 2 cores
const THUMBNAIL_CONCURRENCY = Math.max(1, Math.floor(cpuCount / 3)); // 1 task per 3 cores
const BATCH_SIZE = 1000; // insert batch size
const dbWriteLimit = pLimit(1);
const SOURCE_RETRY_DELAY_MS = 5000;

const waitForSourceRetry = () =>
  new Promise((resolve) => setTimeout(resolve, SOURCE_RETRY_DELAY_MS));

function isSourceDriveUnavailable(sourcePath) {
  const root = path.parse(sourcePath).root;
  return !!root && !fs.existsSync(root);
}

// Count total files for progress tracking
function countTotalFiles(folderPath, existingPaths = new Set()) {
  let total = 0;
  let entries;
  try {
    entries = fs.readdirSync(folderPath, { withFileTypes: true });
  } catch (err) {
    console.warn(
      `Unable to count files in ${folderPath}: ${err.code || err.message}`,
    );
    return total;
  }

  for (const entry of entries) {
    const fullPath = path.join(folderPath, entry.name);

    if (entry.isDirectory()) {
      total += countTotalFiles(fullPath, existingPaths);
    } else if (entry.isFile()) {
      if (!existingPaths.has(fullPath)) {
        // Only count files not yet indexed
        total++;
      }
    }
  }

  return total;
}

// Async generator for walking directories
async function* walkDir(dir) {
  let dirHandle;
  while (!dirHandle) {
    try {
      dirHandle = await fsPromises.opendir(dir);
    } catch (err) {
      if (isSourceDriveUnavailable(dir)) {
        console.warn(
          `Indexing paused; source drive is unavailable. Retrying in ${SOURCE_RETRY_DELAY_MS / 1000}s: ${path.parse(dir).root}`,
        );
        await waitForSourceRetry();
        continue;
      }
      console.warn(
        `Indexing skipped unavailable folder ${dir}: ${err.code || err.message}`,
      );
      return;
    }
  }

  try {
    for await (const entry of dirHandle) {
      const res = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        yield* walkDir(res);
      } else if (entry.isFile()) {
        yield res;
      }
    }
  } catch (err) {
    if (isSourceDriveUnavailable(dir)) {
      console.warn(
        `Indexing paused; source drive is unavailable. Retrying in ${SOURCE_RETRY_DELAY_MS / 1000}s: ${path.parse(dir).root}`,
      );
      await waitForSourceRetry();
      yield* walkDir(dir);
      return;
    }
    console.warn(`Indexing stopped reading folder ${dir}: ${err.code || err.message}`);
  }
}

// Preload all existing file paths into a Set
function loadIndexedPaths() {
  const rows = db.prepare("SELECT path FROM files").all();
  const removedRows = db.prepare("SELECT path FROM removed_files").all();
  const set = new Set(rows.map((r) => r.path));
  for (const r of removedRows) set.add(r.path);
  return set;
}

// Main indexing function
async function indexFilesRecursively(
  rootFolder,
  existingPaths,
  progressCallback,
) {
  const insertStmt = db.prepare(`
    INSERT OR REPLACE INTO files 
    (media_id, filename, path, size, created, modified, extension, folder_path,
     file_type, capture_type, device_model, camera_make, camera_model, width, height,
     orientation, latitude, longitude, altitude, create_date, create_date_local, thumbnail_path,
     lens_model, iso, software, offset_time_original, megapixels,
     exposure_time, color_space, flash, aperture, focal_length, focal_length_35mm, country)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const limitMetadata = pLimit(METADATA_CONCURRENCY);
  const limitThumb = pLimit(THUMBNAIL_CONCURRENCY);

  let batchRows = [];
  let processed = 0;
  let lastUpdate = Date.now();
  const reportProgress = () => {
    const now = Date.now();
    if (now - lastUpdate > 100) {
      progressCallback?.(processed);
      lastUpdate = now;
    }
  };

  for await (const filePath of walkDir(rootFolder)) {
    if (existingPaths.has(filePath)) {
      continue; // already indexed
    }

    let stats;
    let metadata;
    try {
      // Files on removable/network sources can disappear after walkDir finds
      // them. Skip that file and keep the rest of the index run alive.
      stats = await fsPromises.stat(filePath);
      metadata = await limitMetadata(() => extractMetadata(filePath));
    } catch (err) {
      console.warn(
        `Indexing skipped unavailable file ${filePath}: ${err.code || err.message}`,
      );
      processed++;
      reportProgress();
      continue;
    }

    batchRows.push({
      fileName: path.basename(filePath),
      fullPath: filePath,
      stats,
      metadata,
    });

    if (batchRows.length >= BATCH_SIZE) {
      await insertBatch(batchRows, insertStmt, rootFolder, limitThumb);
      for (const row of batchRows) existingPaths.add(row.fullPath);
      batchRows = [];
    }

    processed++;
    reportProgress();
  }

  if (batchRows.length > 0) {
    await insertBatch(batchRows, insertStmt, rootFolder, limitThumb);
    for (const row of batchRows) existingPaths.add(row.fullPath);
    // processed += batchRows.length;
    progressCallback?.(processed);
  }
}

ipcMain.handle(
  "fetch-options",
  async (event, { birthDate = null, hiddenFolders = null } = {}) => {
  try {
    initDatabase();

    const devices = db
      .prepare(
        "SELECT DISTINCT device_model FROM files WHERE device_model IS NOT NULL",
      )
      .all()
      .map((r) => r.device_model);
    const driveMap = getDriveLetterMap();
    const hiddenSourceFolders = Array.isArray(hiddenFolders)
      ? hiddenFolders.filter(Boolean)
      : readConfig().hiddenFolders || [];
    const hiddenFolderClause = hiddenSourceFolders.length
      ? ` AND folder_path NOT IN (${hiddenSourceFolders.map(() => "?").join(", ")})`
      : "";
    const folders = db
      .prepare(
        `SELECT DISTINCT folder_path FROM files WHERE folder_path IS NOT NULL${hiddenFolderClause}`,
      )
      .all(...hiddenSourceFolders)
      .map((r) => ({
        value: r.folder_path,
        label: applyDriveLetterMap(r.folder_path, driveMap),
      }));
    const filetypes = db
      .prepare(
        "SELECT DISTINCT extension FROM files WHERE extension IS NOT NULL",
      )
      .all()
      .map((r) => r.extension);
    const mediaTypes = db
      .prepare(
        "SELECT DISTINCT file_type FROM files WHERE file_type IS NOT NULL",
      )
      .all()
      .map((r) => r.file_type);
    const captureTypes = db
      .prepare(
        "SELECT DISTINCT capture_type FROM files WHERE capture_type IS NOT NULL AND TRIM(capture_type) != ''",
      )
      .all()
      .map((r) => r.capture_type);
    const countriesRaw = db
      .prepare("SELECT country FROM files WHERE country IS NOT NULL")
      .all()
      .map(r => r.country);
    
    const countries = [
      ...new Set(
        countriesRaw.flatMap(c => normalizeCountries(c))
      )
    ];
    const tags = db
      .prepare(
        `
      SELECT id, name
      FROM tags
      WHERE media_ids IS NOT NULL AND json_array_length(media_ids) > 0
    `,
      )
      .all();
    const lenses = db
      .prepare(
        "SELECT DISTINCT lens_model FROM files WHERE lens_model IS NOT NULL",
      )
      .all()
      .map((r) => r.lens_model);

    const dateRange = db
      .prepare(
        `
      SELECT
        MIN(CASE WHEN create_date_local IS NOT NULL THEN date(create_date_local) ELSE date(datetime(create_date, 'unixepoch', 'localtime')) END) AS min,
        MAX(CASE WHEN create_date_local IS NOT NULL THEN date(create_date_local) ELSE date(datetime(create_date, 'unixepoch', 'localtime')) END) AS max
      FROM files
      WHERE create_date_local IS NOT NULL OR create_date IS NOT NULL
    `,
      )
      .get();

    let minDate = "";
    let maxDate = "";
    let years = [];

    if (dateRange?.min && dateRange?.max) {
      minDate = dateRange.min; // already "YYYY-MM-DD" from SQLite date()
      maxDate = dateRange.max;

      const startYear = new Date(minDate).getFullYear();
      const endYear = new Date(maxDate).getFullYear();
      years = Array.from(
        { length: endYear - startYear + 1 },
        (_, i) => endYear - i,
      );
    }

    let ages = [];

    if (dateRange?.min && dateRange?.max && birthDate) {
      const minAge = ageOnDate(
        birthDate,
        new Date(dateRange.min).getTime() / 1000,
      );
      const maxAge = ageOnDate(
        birthDate,
        new Date(dateRange.max).getTime() / 1000,
      );

      ages = Array.from({ length: maxAge - minAge + 1 }, (_, i) => minAge + i);
    }

    return {
      devices,
      folders,
      filetypes,
      mediaTypes,
      captureTypes,
      countries,
      minDate,
      maxDate,
      years,
      tags,
      ages,
      lenses,
    };
  } catch (err) {
    console.error("fetch-options error", err);
    return {
      devices: [],
      folders: [],
      filetypes: [],
      mediaTypes: [],
      captureTypes: [],
      countries: [],
      minDate: "",
      maxDate: "",
      years: [],
      tags: [],
      ages: [],
      lenses: [],
    };
  }
});

function ageOnDate(birthDate, epochSeconds) {
  const birth = new Date(birthDate);
  const date = new Date(epochSeconds * 1000);

  let age = date.getFullYear() - birth.getFullYear();
  const m = date.getMonth() - birth.getMonth();
  const d = date.getDate() - birth.getDate();

  if (m < 0 || (m === 0 && d < 0)) age--;
  return age;
}

ipcMain.handle("fix-thumbnails", async () => {
  try {
    const limitThumb = pLimit(THUMBNAIL_CONCURRENCY);

    // Find all rows without thumbnails
    const rows = db
      .prepare(
        "SELECT id, path, folder_path FROM files WHERE thumbnail_path IS NULL",
      )
      .all();

    if (rows.length === 0) {
      return { success: true, message: "No missing thumbnails found." };
    }

    for (const row of rows) {
      try {
        const thumbPath = await limitThumb(() =>
          generateThumbnail(row.path, row.id),
        );

        if (thumbPath) {
          db.prepare("UPDATE files SET thumbnail_path = ? WHERE id = ?").run(
            thumbPath,
            row.id,
          );
        }
      } catch (err) {
        console.error(`Failed to generate thumbnail for ${row.path}:`, err);
      }
    }

    return {
      success: true,
      message: `Thumbnails fixed for ${rows.length} files.`,
    };
  } catch (err) {
    console.error(err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle("detect-screenshots", async () => {
  try {
    initDatabase();

    const rows = db
      .prepare(
        `
          SELECT id, path, file_type, device_model, camera_make, camera_model,
                 lens_model, focal_length, focal_length_35mm, aperture,
                 exposure_time, iso, latitude, longitude, flash, software
          FROM files
          WHERE file_type IN ('image', 'video')
        `,
      )
      .all();

    if (rows.length === 0) {
      return { success: true, message: "No images or videos found to classify." };
    }

    const updateStmt = db.prepare(
      `
        UPDATE files
        SET capture_type = ?
        WHERE id = ?
      `,
    );
    const updateMany = db.transaction((files) => {
      for (const file of files) {
        file.capture_type = classifyMediaCapture(file.path, file);
        updateStmt.run(file.capture_type, file.id);
      }
    });

    await dbWriteLimit(() => updateMany(rows));

    const screenshots = rows.filter(
      (file) => file.capture_type === "screenshot",
    ).length;
    const recordings = rows.filter(
      (file) => file.capture_type === "screen_recording",
    ).length;
    const camera = rows.filter((file) => file.capture_type === "camera").length;
    return {
      success: true,
      message: `Detected capture types for ${rows.length} files (${camera} camera, ${screenshots} screenshots, ${recordings} screen recordings).`,
    };
  } catch (err) {
    console.error("Error detecting capture types:", err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle("generate-derived-thumbnails", async (event, size = 64) => {
  try {
    const pLimit = require("p-limit");
    const limit = pLimit(THUMBNAIL_CONCURRENCY);

    const path = require("path");
    const fs = require("fs");

    const thumbnailsDir = path.join(dataDir, "thumbnails");

    // Get all files that already have a base thumbnail
    const rows = db
      .prepare(
        `
        SELECT id, thumbnail_path
        FROM files
        WHERE thumbnail_path IS NOT NULL
      `,
      )
      .all();

    if (rows.length === 0) {
      return { success: true, message: "No base thumbnails found." };
    }

    let created = 0;
    let skipped = 0;

    const tasks = rows.map((row) =>
  limit(async () => {
    try {
      const baseThumb = path.join(
        thumbnailsDir,
        `${row.id}_thumb.jpg`,
      );

      const derivedPath = path.join(
        thumbnailsDir,
        `${row.id}_thumb_${size}.jpg`,
      );

      // Skip if base doesn't exist
      if (!fs.existsSync(baseThumb)) {
        skipped++;
        return;
      }

      // Skip if already exists
      if (fs.existsSync(derivedPath)) {
        skipped++;
        return;
      }

      await sharp(baseThumb)
        .resize(size, size, {
          fit: "inside",
          withoutEnlargement: true,
        })
        .jpeg({ quality: 70 })
        .toFile(derivedPath);

      created++;
    } catch (err) {
      console.error(`Failed derived thumbnail for id=${row.id}`, err);
    }
  }),
);

    await Promise.all(tasks);

    return {
      success: true,
      message: `Derived ${size}px thumbnails created.`,
      created,
      skipped,
      total: rows.length,
    };
  } catch (err) {
    console.error(err);
    return { success: false, error: err.message };
  }
});

// Helper function for batch insert + thumbnail generation
async function insertBatch(rows, insertStmt, rootFolder, limitThumb) {
  // Transactional insert
  await dbWriteLimit(async () => {
    const insertMany = db.transaction((batch) => {
      let nextMediaId =
        (db.prepare("SELECT MAX(media_id) as max FROM files").get()?.max || 0) +
        1;
      for (const row of batch) {
        try {
          row.metadata.country = Array.isArray(row.metadata.country)
            ? row.metadata.country.join(", ")
            : (row.metadata.country ?? null);

          const info = insertStmt.run(
            nextMediaId++,
            row.fileName,
            row.fullPath,
            row.stats.size,
            Math.floor(row.stats.birthtimeMs / 1000),
            Math.floor(row.stats.mtimeMs / 1000),
            path.extname(row.fileName).toLowerCase(),
            rootFolder,
            row.metadata.file_type,
            row.metadata.capture_type,
            row.metadata.device_model,
            row.metadata.camera_make,
            row.metadata.camera_model,
            row.metadata.width,
            row.metadata.height,
            row.metadata.orientation,
            row.metadata.latitude,
            row.metadata.longitude,
            row.metadata.altitude,
            row.metadata.create_date,
            row.metadata.create_date_local,
            null, // thumbnail path updated later
            row.metadata.lens_model,
            row.metadata.iso,
            row.metadata.software,
            row.metadata.offset_time_original,
            row.metadata.megapixels,
            row.metadata.exposure_time,
            row.metadata.color_space,
            row.metadata.flash,
            row.metadata.aperture,
            row.metadata.focal_length,
            row.metadata.focal_length_35mm,
            row.metadata.country,
          );
          row.id = info.lastInsertRowid;
        } catch (err) {
          console.error("Error inserting row:", {
            row: row,
            error: err.message,
          });
          throw err; // rethrow so transaction fails
        }
      }
    });

    // Inserts are serialized
    insertMany(rows);
  });

  // Generate thumbnails concurrently
  const thumbsToUpdate = [];
  const thumbnailResults = await Promise.allSettled(
    rows
      .filter((r) => ["image", "video"].includes(r.metadata.file_type))
      .map((r) =>
        limitThumb(async () => {
          const thumbPath = await generateThumbnail(r.fullPath, r.id);
          if (thumbPath) {
            thumbsToUpdate.push({ id: r.id, thumbPath });
          }
        }),
      ),
  );

  // Thumbnail generation is optional. A corrupt or unsupported media file must
  // never interrupt the database insert or the rest of the indexing run.
  for (const result of thumbnailResults) {
    if (result.status === "rejected") {
      console.warn(
        `Thumbnail task skipped: ${summarizeThumbnailError(result.reason)}`,
      );
    }
  }

  if (thumbsToUpdate.length > 0) {
    // Prepare once, reuse in a single transaction
    await dbWriteLimit(() => {
      const updateStmt = db.prepare(
        `UPDATE files SET thumbnail_path = ? WHERE id = ?`,
      );
      const updateMany = db.transaction((updates) => {
        for (const u of updates) {
          updateStmt.run(u.thumbPath, u.id);
        }
      });
      updateMany(thumbsToUpdate);
    });
  }
}

ipcMain.handle("check-folders", async (event, folders) => {
  const results = {};
  for (const folder of folders) {
    try {
      results[folder] = fs.existsSync(folder);
    } catch {
      results[folder] = false;
    }
  }
  return results;
});

ipcMain.handle("remove-folder-data", async (event, folderPath) => {
  try {
    initDatabase();

    // Get all files in this folder
    const files = db
      .prepare("SELECT id, thumbnail_path FROM files WHERE folder_path = ?")
      .all(folderPath);

    const fileIds = new Set(files.map((f) => f.id));

    // Delete thumbnails from disk
    for (const { thumbnail_path } of files) {
      if (thumbnail_path && fs.existsSync(thumbnail_path)) {
        try {
          fs.unlinkSync(thumbnail_path);
        } catch (err) {
          console.warn(
            "Failed to delete thumbnail:",
            thumbnail_path,
            err.message,
          );
        }
      }
    }

    db.transaction(() => {
      // OCR is derived data. Keep its FTS triggers in sync before removing
      // the source file rows (older databases may not have the table yet).
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ocr_index'").get()) {
        db.prepare("DELETE FROM ocr_index WHERE file_id IN (SELECT id FROM files WHERE folder_path = ?)").run(folderPath);
      }
      // Delete files from DB
      db.prepare("DELETE FROM files WHERE folder_path = ?").run(folderPath);

      // Delete folder record
      db.prepare("DELETE FROM folders WHERE path = ?").run(folderPath);

      // Delete removed_files entries from this source
      db.prepare("DELETE FROM removed_files WHERE folder_path = ?").run(
        folderPath,
      );

      // Clean up tags
      const allTags = db.prepare("SELECT id, media_ids FROM tags").all();
      const updateTag = db.prepare(
        "UPDATE tags SET media_ids = ? WHERE id = ?",
      );
      for (const tag of allTags) {
        const mediaIds = JSON.parse(tag.media_ids || "[]");
        const filtered = mediaIds.filter((mid) => !fileIds.has(Number(mid)));
        if (filtered.length !== mediaIds.length) {
          updateTag.run(JSON.stringify(filtered), tag.id);
        }
      }

      // Clean up memories
      const allMemories = db
        .prepare("SELECT id, media_ids FROM memories")
        .all();
      const updateMemory = db.prepare(
        "UPDATE memories SET media_ids = ? WHERE id = ?",
      );
      for (const memory of allMemories) {
        const mediaIds = JSON.parse(memory.media_ids || "[]");
        const filtered = mediaIds.filter((mid) => !fileIds.has(Number(mid)));
        if (filtered.length !== mediaIds.length) {
          updateMemory.run(JSON.stringify(filtered), memory.id);
        }
      }
    })();

    invalidateProgressSnapshots();
    return { success: true };
  } catch (err) {
    console.error("Error removing folder data:", err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle("remove-item-from-index", async (event, ids) => {
  try {
    initDatabase();

    // Accept a single id or an array of ids
    const idList = Array.isArray(ids) ? ids : [ids];

    if (!idList.length || idList.some((id) => !id)) {
      throw new Error("No valid ID(s) provided");
    }

    const idSet = new Set(idList.map(Number));
    const removedIdSet = new Set();

    db.transaction(() => {
      for (const id of idSet) {
        // 1. Record path in removed_files before deleting
        const removed = db
          .prepare("SELECT path, folder_path FROM files WHERE id = ?")
          .get(id);
        if (removed?.path) {
          db.prepare(
            "INSERT OR IGNORE INTO removed_files (path, folder_path) VALUES (?, ?)",
          ).run(removed.path, removed.folder_path);
        }

        if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ocr_index'").get()) {
          db.prepare("DELETE FROM ocr_index WHERE file_id = ?").run(id);
        }

        // 2. Remove item from DB
        const result = db.prepare("DELETE FROM files WHERE id = ?").run(id);
        if (result.changes > 0) removedIdSet.add(id);
      }

      // 3. Remove id(s) from all tags' media_ids
      const allTags = db.prepare("SELECT id, media_ids FROM tags").all();
      const updateTag = db.prepare(
        "UPDATE tags SET media_ids = ? WHERE id = ?",
      );
      for (const tag of allTags) {
        const mediaIds = JSON.parse(tag.media_ids || "[]");
        const filtered = mediaIds.filter((mid) => !idSet.has(Number(mid)));
        if (filtered.length !== mediaIds.length) {
          updateTag.run(JSON.stringify(filtered), tag.id);
        }
      }

      // 4. Remove id(s) from all memories' media_ids
      const allMemories = db
        .prepare("SELECT id, media_ids FROM memories")
        .all();
      const updateMemory = db.prepare(
        "UPDATE memories SET media_ids = ? WHERE id = ?",
      );
      for (const memory of allMemories) {
        const mediaIds = JSON.parse(memory.media_ids || "[]");
        const filtered = mediaIds.filter((mid) => !idSet.has(Number(mid)));
        if (filtered.length !== mediaIds.length) {
          updateMemory.run(JSON.stringify(filtered), memory.id);
        }
      }
    })();

    // 5. Remove thumbnails from disk (outside transaction — non-critical)
    for (const id of removedIdSet) {
      const thumbnailPath = path.join(dataDir, "thumbnails", `${id}_thumb.jpg`);
      if (fs.existsSync(thumbnailPath)) {
        try {
          fs.unlinkSync(thumbnailPath);
        } catch (err) {
          console.warn(
            "Failed to delete thumbnail:",
            thumbnailPath,
            err.message,
          );
        }
      }
    }

    if (removedIdSet.size > 0) invalidateProgressSnapshots();
    event.sender.send("item-removed", { ids: [...removedIdSet] });

    return { success: true };
  } catch (err) {
    console.error("Error removing item(s) from index:", err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle("apply-heic-thumbnails", async (event, heicFiles) => {
  try {
    const thumbnailsDir = path.join(dataDir, "thumbnails"); // folder where user will copy thumbnails
    const stmt = db.prepare("UPDATE files SET thumbnail_path = ? WHERE id = ?");
    for (const file of heicFiles) {
      // Construct the expected thumbnail filename
      const thumbnailFileName = `${file.id}_thumb.jpg`;
      const thumbnailFullPath = path.join(thumbnailsDir, thumbnailFileName);

      // Only update DB if the thumbnail exists
      if (!fs.existsSync(thumbnailFullPath)) continue;

      // Update database
      stmt.run(thumbnailFullPath, file.id);
    }

    return { success: true, message: "Database updated with thumbnail paths." };
  } catch (err) {
    console.error("Error updating thumbnail paths:", err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle("get-storage-usage", async () => {
  try {
    initDatabase();

    const dbFilePath = path.join(dataDir, "orbit-index.db");
    const thumbsPath = path.join(dataDir, "thumbnails");
    const resourcesPath =
      resourceManager?.resourcesDirectory ??
      path.join(app.getPath("userData"), "resources");

    let dbSize = 0;
    if (fs.existsSync(dbFilePath)) {
      dbSize = fs.statSync(dbFilePath).size;
    }

    const getDirectorySize = (dirPath) => {
      if (!fs.existsSync(dirPath)) return 0;
      let totalSize = 0;
      for (const file of fs.readdirSync(dirPath)) {
        const filePath = path.join(dirPath, file);
        const stats = fs.statSync(filePath);
        if (stats.isDirectory()) totalSize += getDirectorySize(filePath);
        else totalSize += stats.size;
      }
      return totalSize;
    };

    const thumbSize = getDirectorySize(thumbsPath);
    const resourcesSize = getDirectorySize(resourcesPath);

    // Per-table row counts + byte estimates via dbstat
    const tableNames = [
      "files",
      "memories",
      "tags",
      "locations",
      "embeddings",
      "removed_files",
    ];
    const tables = {};

    for (const t of tableNames) {
      try {
        const row = db.prepare(`SELECT COUNT(*) as count FROM ${t}`).get();
        tables[t] = { rows: row?.count ?? 0, bytes: 0 };
      } catch {
        tables[t] = { rows: 0, bytes: 0 };
      }
    }

    try {
      const statRows = db
        .prepare(
          `
        SELECT name, SUM(payload) as payload_bytes
        FROM dbstat
        WHERE aggregate = TRUE
        GROUP BY name
      `,
        )
        .all();
      for (const r of statRows) {
        if (tables[r.name]) tables[r.name].bytes = r.payload_bytes ?? 0;
      }
    } catch {
      // dbstat not available — bytes stay 0
    }

    return {
      appStorageUsed: dbSize + thumbSize + resourcesSize,
      dbSize,
      thumbSize,
      resourcesSize,
      tables,
    };
  } catch (error) {
    console.error("Error getting storage usage:", error);
    return {
      appStorageUsed: 0,
      dbSize: 0,
      thumbSize: 0,
      resourcesSize: 0,
      tables: {},
    };
  }
});

// Indexed files count
ipcMain.handle("get-indexed-files-count", async () => {
  try {
    initDatabase();
    const result = db.prepare("SELECT COUNT(*) as count FROM files").get();
    return result.count;
  } catch (err) {
    console.error(err);
    return 0;
  }
});

// Thumbnail generation placeholder
ipcMain.handle("generate-thumbnails", async () => {
  try {
    initDatabase();
    return { success: true, message: "Thumbnail generation started" };
  } catch (err) {
    console.error(err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle("get-index-of-item", async (event, { itemId, settings = {} }) => {
  try {
    if (!db) return null;
    settings = settings ?? {};
    const visibilityFilter = settings.hideScreenshotsAndScreenRecordings
      ? "COALESCE(capture_type, '') NOT IN ('screenshot', 'screen_recording')"
      : "1 = 1";

    // Do not calculate an index for an item the Explorer deliberately excludes.
    // Without this check, its position can point at the following visible item.
    const target = db
      .prepare(`SELECT 1 FROM files WHERE media_id = ? AND ${visibilityFilter}`)
      .get(itemId);
    if (!target) return null;

    // Use media_id for a stable, deterministic descending sort (newest first)
    const stmt = db.prepare(`
      SELECT COUNT(*) as idx
      FROM files
      WHERE media_id > ?
        AND ${visibilityFilter}
    `);

    const row = stmt.get(itemId);
    if (!row) return null;

    return row.idx; // 0-based index
  } catch (err) {
    console.error("get-index-of-item error:", err);
    return null;
  }
});

ipcMain.handle("fetch-years", async () => {
  initDatabase();

  const datePart = (fmt) => `
    CASE
      WHEN create_date_local IS NOT NULL
        THEN strftime('${fmt}', create_date_local)
      WHEN create_date IS NOT NULL
        THEN strftime('${fmt}', datetime(create_date, 'unixepoch', 'localtime'))
      ELSE
        strftime('${fmt}', datetime(MIN(created, modified), 'unixepoch', 'localtime'))
    END
  `;

  const rows = db
    .prepare(
      `
    SELECT
      ${datePart("%Y")} AS year,
      COUNT(*) AS total,
      GROUP_CONCAT(id) AS ids
    FROM files
    WHERE create_date_local IS NOT NULL OR create_date IS NOT NULL OR created IS NOT NULL OR modified IS NOT NULL
    GROUP BY year
    ORDER BY year DESC
  `,
    )
    .all();

  const thumbRows = db
    .prepare(
      `
    SELECT id, thumbnail_path,
      ${datePart("%Y")} AS year
    FROM files
    WHERE file_type = 'image'
      AND thumbnail_path IS NOT NULL
      AND (create_date_local IS NOT NULL OR create_date IS NOT NULL)
    ORDER BY
      (
        CASE WHEN camera_make IS NOT NULL THEN 4 ELSE 0 END +
        CASE WHEN camera_model IS NOT NULL THEN 3 ELSE 0 END +
        CASE WHEN lens_model IS NOT NULL THEN 2 ELSE 0 END +
        CASE WHEN focal_length IS NOT NULL THEN 2 ELSE 0 END +
        CASE WHEN iso IS NOT NULL THEN 1 ELSE 0 END +
        CASE WHEN aperture IS NOT NULL THEN 1 ELSE 0 END +
        CASE WHEN latitude IS NOT NULL THEN 2 ELSE 0 END +
        CASE WHEN longitude IS NOT NULL THEN 2 ELSE 0 END
      ) DESC,
          
      ABS((CAST(width AS REAL) / height) - 1.3) ASC,
          
      megapixels DESC,
          
      RANDOM()
  `,
    )
    .all();

  const thumbsByYear = {};
  for (const t of thumbRows) {
    if (!thumbsByYear[t.year]) thumbsByYear[t.year] = [];
    if (thumbsByYear[t.year].length < 20) thumbsByYear[t.year].push(t);
  }

  return rows.map((r) => ({
    year: r.year,
    total: r.total,
    ids: r.ids.split(",").map(Number),
    thumbnails: thumbsByYear[r.year] || [],
  }));
});

ipcMain.handle("fetch-months", async () => {
  initDatabase();

  const datePart = (fmt) => `
    CASE
      WHEN create_date_local IS NOT NULL
        THEN strftime('${fmt}', create_date_local)
      WHEN create_date IS NOT NULL
        THEN strftime('${fmt}', datetime(create_date, 'unixepoch', 'localtime'))
      ELSE
        strftime('${fmt}', datetime(MIN(created, modified), 'unixepoch', 'localtime'))
    END
  `;

  const rows = db
    .prepare(
      `
    SELECT
      ${datePart("%Y")} AS year,
      ${datePart("%m")} AS month,
      COUNT(*) AS total,
      GROUP_CONCAT(id) AS ids
    FROM files
    WHERE create_date_local IS NOT NULL OR create_date IS NOT NULL OR created IS NOT NULL OR modified IS NOT NULL
    GROUP BY year, month
    ORDER BY year DESC, month DESC
  `,
    )
    .all();

  const thumbRows = db
    .prepare(
      `
    SELECT id, thumbnail_path,
      ${datePart("%Y")} AS year,
      ${datePart("%m")} AS month
    FROM files
    WHERE file_type = 'image'
      AND thumbnail_path IS NOT NULL
      AND (create_date_local IS NOT NULL OR create_date IS NOT NULL)
    ORDER BY
      (
        CASE WHEN camera_make IS NOT NULL THEN 4 ELSE 0 END +
        CASE WHEN camera_model IS NOT NULL THEN 3 ELSE 0 END +
        CASE WHEN lens_model IS NOT NULL THEN 2 ELSE 0 END +
        CASE WHEN focal_length IS NOT NULL THEN 2 ELSE 0 END +
        CASE WHEN iso IS NOT NULL THEN 1 ELSE 0 END +
        CASE WHEN aperture IS NOT NULL THEN 1 ELSE 0 END +
        CASE WHEN latitude IS NOT NULL THEN 2 ELSE 0 END +
        CASE WHEN longitude IS NOT NULL THEN 2 ELSE 0 END
      ) DESC,
          
      ABS((CAST(width AS REAL) / height) - 1.3) ASC,
          
      megapixels DESC,
          
      RANDOM()
  `,
    )
    .all();

  const thumbsByMonth = {};
  for (const t of thumbRows) {
    const key = `${t.year}-${t.month}`;
    if (!thumbsByMonth[key]) thumbsByMonth[key] = [];
    if (thumbsByMonth[key].length < 20) thumbsByMonth[key].push(t);
  }

  return rows.map((r) => ({
    year: r.year,
    month: r.month,
    total: r.total,
    ids: r.ids.split(",").map(Number),
    thumbnails: thumbsByMonth[`${r.year}-${r.month}`] || [],
  }));
});

ipcMain.handle("fetch-trips", async (_, options = {}) => {
  initDatabase();

  const home = db
    .prepare(
      `
    SELECT country
    FROM files
    WHERE country IS NOT NULL
    GROUP BY country
    ORDER BY COUNT(*) DESC
    LIMIT 1
  `,
    )
    .get()?.country;

  if (!home) return [];

  const MAX_GAP_DAYS = options.maxGapDays ?? 4;
  const MIN_TRIP_PHOTOS = options.minTripPhotos ?? 500;
  const MIN_COUNTRY_PERCENT = options.minCountryPercent ?? 0.2;
  const MIN_MAIN_COUNTRIES_PERCENT = options.minMainCountriesPercent ?? 0.5;

  const rows = db
    .prepare(
      `
    SELECT
      id,
      country,
      CASE
        WHEN create_date_local IS NOT NULL THEN create_date_local
        WHEN create_date IS NOT NULL THEN datetime(create_date, 'unixepoch', 'localtime')
        ELSE datetime(MIN(created, modified), 'unixepoch', 'localtime')
      END AS date
    FROM files
    WHERE country IS NOT NULL
      AND country != ?
    ORDER BY date ASC
  `,
    )
    .all(home);

  // Group into trips
  const trips = [];
  let current = null;

  const daysBetween = (a, b) =>
    (new Date(b) - new Date(a)) / (1000 * 60 * 60 * 24);

  for (const row of rows) {
    if (!current || daysBetween(current.end, row.date) > MAX_GAP_DAYS) {
      if (current) trips.push(current);
      current = { start: row.date, end: row.date, ids: [], countryCounts: {} };
    }
    current.end = row.date;
    current.ids.push(row.id);
    for (const c of normalizeCountries(row.country)) {
      current.countryCounts[c] =
        (current.countryCounts[c] || 0) + 1;
    }
  }
  if (current) trips.push(current);

  // Filter and build final trip objects
  const filtered = trips
    .filter((t) => t.ids.length >= MIN_TRIP_PHOTOS)
    .map((t) => {
      const totalPhotos = t.ids.length;
      const countryPercent = Object.fromEntries(
        Object.entries(t.countryCounts).map(([code, count]) => [
          code,
          count / totalPhotos,
        ]),
      );

      const mainCountries = Object.entries(countryPercent)
        .filter(([_, pct]) => pct >= MIN_COUNTRY_PERCENT)
        .map(([code]) => code);

      const mainTotalPercent = mainCountries.reduce(
        (sum, c) => sum + countryPercent[c],
        0,
      );
      if (mainTotalPercent < MIN_MAIN_COUNTRIES_PERCENT) return null;

      return {
        id: `${t.start}-${t.end}`,
        start: t.start,
        end: t.end,
        total: totalPhotos,
        ids: t.ids,
        countries: mainCountries,
      };
    })
    .filter(Boolean)
    .sort((a, b) => new Date(b.start) - new Date(a.start));

  if (!filtered.length) return [];

  // Build temp table with (file_id, trip_id) for all surviving trips
  db.exec(`CREATE TEMP TABLE IF NOT EXISTS trip_thumb_lookup (
    file_id INTEGER NOT NULL,
    trip_id TEXT NOT NULL
  )`);
  db.exec(`DELETE FROM trip_thumb_lookup`);

  const insertLookup = db.prepare(
    `INSERT INTO trip_thumb_lookup (file_id, trip_id) VALUES (?, ?)`,
  );
  const insertMany = db.transaction((trips) => {
    for (const trip of trips) {
      for (const id of trip.ids) {
        insertLookup.run(id, trip.id);
      }
    }
  });
  insertMany(filtered);

  // Single join query — no variable limit concerns
  const thumbRows = db
    .prepare(
      `
    SELECT f.id, f.thumbnail_path, t.trip_id
    FROM files f
    INNER JOIN trip_thumb_lookup t ON f.id = t.file_id
    WHERE f.file_type = 'image'
      AND f.thumbnail_path IS NOT NULL
    ORDER BY
      (
        CASE WHEN camera_make IS NOT NULL THEN 4 ELSE 0 END +
        CASE WHEN camera_model IS NOT NULL THEN 3 ELSE 0 END +
        CASE WHEN lens_model IS NOT NULL THEN 2 ELSE 0 END +
        CASE WHEN focal_length IS NOT NULL THEN 2 ELSE 0 END +
        CASE WHEN iso IS NOT NULL THEN 1 ELSE 0 END +
        CASE WHEN aperture IS NOT NULL THEN 1 ELSE 0 END +
        CASE WHEN latitude IS NOT NULL THEN 2 ELSE 0 END +
        CASE WHEN longitude IS NOT NULL THEN 2 ELSE 0 END
      ) DESC,
          
      ABS((CAST(width AS REAL) / height) - 1.3) ASC,
          
      megapixels DESC,
          
      RANDOM()
  `,
    )
    .all();

  // Group thumbnails by trip, cap at 20
  const thumbsByTrip = {};
  for (const row of thumbRows) {
    if (!thumbsByTrip[row.trip_id]) thumbsByTrip[row.trip_id] = [];
    if (thumbsByTrip[row.trip_id].length < 20)
      thumbsByTrip[row.trip_id].push(row);
  }

  return filtered.map((t) => ({
    ...t,
    title: t.countries.join(" – ") + ` ${new Date(t.start).getFullYear()}`,
    thumbnails: thumbsByTrip[t.id] || [],
  }));
});

ipcMain.handle("fetch-on-this-day", async () => {
  try {
    initDatabase();

    const now = new Date();
    // Zero-pad month and day so they match SQLite's strftime output
    const todayMM = String(now.getMonth() + 1).padStart(2, "0");
    const todayDD = String(now.getDate()).padStart(2, "0");
    const currentYear = now.getFullYear();

    // The same date-expression used throughout the app
    const datePart = (fmt) => `
      CASE
        WHEN create_date_local IS NOT NULL
          THEN strftime('${fmt}', create_date_local)
        WHEN create_date IS NOT NULL
          THEN strftime('${fmt}', datetime(create_date, 'unixepoch', 'localtime'))
        ELSE
          strftime('${fmt}', datetime(MIN(created, modified), 'unixepoch', 'localtime'))
      END
    `;

    // Fetch all files whose month AND day match today, grouped by year,
    // excluding the current year (those aren't "memories" yet).
    const rows = db
      .prepare(
        `
      SELECT
        ${datePart("%Y")} AS year,
        COUNT(*)          AS total,
        GROUP_CONCAT(id)  AS ids
      FROM files
      WHERE
        ${datePart("%m")} = ?
        AND ${datePart("%d")} = ?
        AND CAST(${datePart("%Y")} AS INTEGER) < ?
      GROUP BY year
      ORDER BY year DESC
    `,
      )
      .all(todayMM, todayDD, currentYear);

    if (!rows.length) return [];

    // Grab up to 20 random image thumbnails per year in one pass
    const thumbRows = db
      .prepare(
        `
      SELECT id, thumbnail_path,
        ${datePart("%Y")} AS year
      FROM files
      WHERE
        file_type = 'image'
        AND thumbnail_path IS NOT NULL
        AND ${datePart("%m")} = ?
        AND ${datePart("%d")} = ?
        AND CAST(${datePart("%Y")} AS INTEGER) < ?
      ORDER BY
        (
          CASE WHEN camera_make IS NOT NULL THEN 4 ELSE 0 END +
          CASE WHEN camera_model IS NOT NULL THEN 3 ELSE 0 END +
          CASE WHEN lens_model IS NOT NULL THEN 2 ELSE 0 END +
          CASE WHEN focal_length IS NOT NULL THEN 2 ELSE 0 END +
          CASE WHEN iso IS NOT NULL THEN 1 ELSE 0 END +
          CASE WHEN aperture IS NOT NULL THEN 1 ELSE 0 END +
          CASE WHEN latitude IS NOT NULL THEN 2 ELSE 0 END +
          CASE WHEN longitude IS NOT NULL THEN 2 ELSE 0 END
        ) DESC,

        ABS((CAST(width AS REAL) / height) - 1.3) ASC,

        megapixels DESC,

        RANDOM()
    `,
      )
      .all(todayMM, todayDD, currentYear);

    // Group thumbnails by year (cap at 20 each)
    const thumbsByYear = {};
    for (const t of thumbRows) {
      if (!thumbsByYear[t.year]) thumbsByYear[t.year] = [];
      if (thumbsByYear[t.year].length < 20) thumbsByYear[t.year].push(t);
    }

    return rows.map((r) => ({
      year: parseInt(r.year, 10),
      total: r.total,
      ids: r.ids.split(",").map(Number),
      thumbnails: thumbsByYear[r.year] || [],
    }));
  } catch (err) {
    console.error("fetch-on-this-day error:", err);
    return [];
  }
});

ipcMain.handle(
  "add-memory",
  async (
    event,
    {
      title,
      description,
      color,
      startDate,
      endDate,
      idFrom,
      idTo,
      pathStartsWith,
    },
  ) => {
    try {
      initDatabase();

      let mediaIds = [];

      /**
       * DATE RANGE (takes priority)
       */
      if (startDate || endDate) {
        const where = [];
        const params = [];

        if (startDate) {
          where.push(`
            COALESCE(
              create_date,
              CASE
                WHEN created <= modified THEN created
                ELSE modified
              END
            ) >= ?
          `);
          params.push(Math.floor(new Date(startDate).getTime() / 1000));
        }

        if (endDate) {
          where.push(`
            COALESCE(
              create_date,
              CASE
                WHEN created <= modified THEN created
                ELSE modified
              END
            ) <= ?
          `);
          params.push(Math.floor(new Date(endDate).getTime() / 1000));
        }

        const rows = db
          .prepare(`SELECT id FROM files WHERE ${where.join(" AND ")}`)
          .all(...params);

        mediaIds = rows.map((r) => r.id);
      } else if (idFrom != null && idTo != null) {
        /**
         * ID RANGE (fallback if no dates)
         */
        const rows = db
          .prepare(
            `
          SELECT id
          FROM files
          WHERE id BETWEEN ? AND ?
          ORDER BY id
        `,
          )
          .all(Number(idFrom), Number(idTo));

        mediaIds = rows.map((r) => r.id);
      } else if (pathStartsWith) {
        /**
         * PATH PREFIX
         */
        const rows = db
          .prepare(
            `
          SELECT id
          FROM files
          WHERE path LIKE ?
          ORDER BY id
        `,
          )
          .all(pathStartsWith.replace(/%/g, "\\%").replace(/_/g, "\\_") + "%");
        mediaIds = rows.map((r) => r.id);
      }

      const now = Math.floor(Date.now() / 1000);

      const maxOrder =
        db
          .prepare(`SELECT COALESCE(MAX(sort_order), 0) AS m FROM memories`)
          .get()?.m ?? 0;

      const info = db
        .prepare(
          `
        INSERT INTO memories (title, description, color, media_ids, created, sort_order)
        VALUES (?, ?, ?, ?, ?, ?)
      `,
        )
        .run(
          title,
          description,
          color,
          JSON.stringify(mediaIds),
          now,
          maxOrder + 1,
        );

      return {
        success: true,
        id: info.lastInsertRowid,
        mediaIds,
      };
    } catch (err) {
      console.error("add-memory error:", err);
      return { success: false, error: err.message };
    }
  },
);

ipcMain.handle("fetch-memories", async () => {
  try {
    initDatabase();

    const memories = db
      .prepare(
        `
      SELECT *
      FROM memories
      ORDER BY sort_order DESC, created DESC
    `,
      )
      .all();

    const results = memories.map((m) => {
      let mediaIds = [];
      try {
        mediaIds = JSON.parse(m.media_ids || "[]");
      } catch (err) {
        console.error("Invalid media_ids JSON for memory:", m.id, err);
      }

      if (!mediaIds.length) return { ...m, thumbnails: [], total: 0 };

      // Chunk into batches of 999 to stay under SQLite's variable limit
      const chunkSize = 999;
      const chunks = [];
      for (let i = 0; i < mediaIds.length; i += chunkSize) {
        chunks.push(mediaIds.slice(i, i + chunkSize));
      }

      const thumbnails = [];
      for (const chunk of chunks) {
        if (thumbnails.length >= 20) break;

        const remaining = 20 - thumbnails.length;
        const rows = db
          .prepare(
            `
          SELECT id, thumbnail_path
          FROM files
          WHERE id IN (${chunk.map(() => "?").join(",")})
            AND file_type = 'image'
            AND thumbnail_path IS NOT NULL
          ORDER BY
            (
              CASE WHEN camera_make IS NOT NULL THEN 4 ELSE 0 END +
              CASE WHEN camera_model IS NOT NULL THEN 3 ELSE 0 END +
              CASE WHEN lens_model IS NOT NULL THEN 2 ELSE 0 END +
              CASE WHEN focal_length IS NOT NULL THEN 2 ELSE 0 END +
              CASE WHEN iso IS NOT NULL THEN 1 ELSE 0 END +
              CASE WHEN aperture IS NOT NULL THEN 1 ELSE 0 END +
              CASE WHEN latitude IS NOT NULL THEN 2 ELSE 0 END +
              CASE WHEN longitude IS NOT NULL THEN 2 ELSE 0 END
            ) DESC,

            ABS((CAST(width AS REAL) / height) - 1.3) ASC,

            megapixels DESC,

            RANDOM()
          LIMIT ?
        `,
          )
          .all(...chunk, remaining);

        thumbnails.push(...rows);
      }

      // Shuffle and limit to 20 in JS since we're merging chunks
      const shuffled = thumbnails.sort(() => Math.random() - 0.5).slice(0, 20);

      return { ...m, thumbnails: shuffled, total: mediaIds.length };
    });

    return results;
  } catch (err) {
    console.error("fetch-memories error:", err);
    return [];
  }
});

ipcMain.handle("memory:reorder", async (event, { order }) => {
  // order: [{ id, sort_order }, ...]
  try {
    initDatabase();
    const stmt = db.prepare(`UPDATE memories SET sort_order = ? WHERE id = ?`);
    const updateAll = db.transaction((items) => {
      for (const { id, sort_order } of items) {
        stmt.run(sort_order, id);
      }
    });
    updateAll(order);
    return { success: true };
  } catch (err) {
    console.error("memory:reorder error:", err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle(
  "update-memory",
  async (event, { id, title, description, color }) => {
    try {
      initDatabase();

      if (!id) {
        throw new Error("Missing memory id");
      }

      const stmt = db.prepare(`
      UPDATE memories
      SET
        title = ?,
        description = ?,
        color = ?
      WHERE id = ?
    `);

      const info = stmt.run(title, description, color, id);

      if (info.changes === 0) {
        throw new Error(`Memory ${id} not found`);
      }

      return { success: true, id };
    } catch (err) {
      console.error("update-memory error:", err);
      return { success: false, error: err.message };
    }
  },
);

ipcMain.handle("delete-memory", async (event, { id }) => {
  try {
    initDatabase();

    if (!id) {
      throw new Error("Missing memory id");
    }

    const stmt = db.prepare(`
      DELETE FROM memories
      WHERE id = ?
    `);

    const info = stmt.run(id);

    if (info.changes === 0) {
      throw new Error(`Memory ${id} not found`);
    }

    return { success: true, id };
  } catch (err) {
    console.error("delete-memory error:", err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle("fetch-stats", async (event, { birthDate } = {}) => {
  try {
    initDatabase();

    const hasDate = `(create_date_local IS NOT NULL OR create_date IS NOT NULL OR created IS NOT NULL OR modified IS NOT NULL)`;

    const datePart = (fmt) => `
      CASE
        WHEN create_date_local IS NOT NULL
          THEN strftime('${fmt}', create_date_local)
        WHEN create_date IS NOT NULL
          THEN strftime('${fmt}', datetime(create_date, 'unixepoch', 'localtime'))
        ELSE
          strftime('${fmt}', datetime(MIN(created, modified), 'unixepoch', 'localtime'))
      END
    `;

    const perYear = db
      .prepare(
        `
      SELECT CAST(${datePart("%Y")} AS INTEGER) AS year, COUNT(*) AS count
      FROM files
      WHERE ${hasDate}
      GROUP BY year
      ORDER BY year DESC
    `,
      )
      .all();

    const perMonth = db
      .prepare(
        `
      SELECT ${datePart("%Y-%m")} AS month, COUNT(*) AS count
      FROM files
      WHERE ${hasDate}
      GROUP BY month
      ORDER BY month DESC
    `,
      )
      .all();

    const topDays = db
      .prepare(
        `
      SELECT ${datePart("%Y-%m-%d")} AS day, COUNT(*) AS count
      FROM files
      WHERE ${hasDate}
      GROUP BY day
      ORDER BY count DESC
      LIMIT 10
    `,
      )
      .all();

    const allDays = db
      .prepare(
        `
      SELECT ${datePart("%Y-%m-%d")} AS day, COUNT(*) AS count
      FROM files
      WHERE ${hasDate}
      GROUP BY day
      ORDER BY day ASC
    `,
      )
      .all();

    const byType = db
      .prepare(
        `
      SELECT COALESCE(file_type, 'Unknown') AS type, COUNT(*) AS count
      FROM files
      GROUP BY type
      ORDER BY count DESC
    `,
      )
      .all();

    const byDevice = db
      .prepare(
        `
      SELECT COALESCE(device_model, 'Unknown') AS device, COUNT(*) AS count
      FROM files
      GROUP BY device
      ORDER BY count DESC
    `,
      )
      .all();

    const rawCountries = db
      .prepare(
        `
      SELECT country FROM files
      WHERE country IS NOT NULL
    `,
      )
      .all();

    const byCountryMap = {};

    for (const row of rawCountries) {
      for (const c of normalizeCountries(row.country)) {
        byCountryMap[c] = (byCountryMap[c] || 0) + 1;
      }
    }

    const totals = db
      .prepare(
        `
      SELECT COUNT(*) AS totalFiles, SUM(size) AS totalStorage FROM files
    `,
      )
      .get();

    const sources = db
      .prepare(
        `
      SELECT
        folder_path AS folder,
        MIN(${datePart("%Y-%m-%d")}) AS first,
        MAX(${datePart("%Y-%m-%d")}) AS last,
        COUNT(*) AS count
      FROM files
      WHERE folder_path IS NOT NULL
      GROUP BY folder_path
      ORDER BY first DESC
    `,
      )
      .all();

    const devices = db
      .prepare(
        `
      SELECT
        device_model AS device,
        MIN(${datePart("%Y-%m-%d")}) AS first,
        MAX(${datePart("%Y-%m-%d")}) AS last,
        COUNT(*) AS count
      FROM files
      WHERE device_model IS NOT NULL
      GROUP BY device_model
      ORDER BY first DESC
    `,
      )
      .all();

    let perAge = [];
    if (birthDate) {
      const birth = new Date(birthDate);
      const byYearMonthDay = db
        .prepare(
          `
        SELECT
          CAST(${datePart("%Y")} AS INTEGER) AS year,
          CAST(${datePart("%m")} AS INTEGER) AS month,
          CAST(${datePart("%d")} AS INTEGER) AS day,
          COUNT(*) AS count
        FROM files
        WHERE ${hasDate}
        GROUP BY year, month, day
      `,
        )
        .all();

      const ageCounts = {};
      for (const row of byYearMonthDay) {
        let age = row.year - birth.getFullYear();
        if (
          row.month < birth.getMonth() + 1 ||
          (row.month === birth.getMonth() + 1 && row.day < birth.getDate())
        )
          age--;
        ageCounts[age] = (ageCounts[age] || 0) + row.count;
      }
      perAge = Object.keys(ageCounts)
        .map((a) => ({ age: Number(a), count: ageCounts[a] }))
        .sort((a, b) => b.age - a.age);
    }

    const map = getDriveLetterMap();
    const mappedSources = sources.map((s) => ({
      ...s,
      folder: applyDriveLetterMap(s.folder, map),
    }));

    return {
      success: true,
      perYear,
      perMonth,
      topDays,
      allDays,
      byType,
      byDevice,
      byCountry: Object.entries(byCountryMap)
        .map(([country, count]) => ({ country, count }))
        .sort((a, b) => b.count - a.count),
      totalFiles: totals.totalFiles,
      totalStorage: totals.totalStorage || 0,
      sources: mappedSources,
      perAge,
      devices,
    };
  } catch (err) {
    console.error("fetch-stats error:", err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle("migrate-create-date-local", async () => {
  try {
    initDatabase();

    const rows = db
      .prepare(
        `
      SELECT id, path
      FROM files
      WHERE create_date_local IS NULL
        AND create_date IS NOT NULL
    `,
      )
      .all();

    console.log(`Found ${rows.length} rows to migrate`);
    if (rows.length === 0) return { success: true, updated: 0 };

    const updateStmt = db.prepare(
      `UPDATE files SET create_date_local = ? WHERE id = ?`,
    );

    // Much higher concurrency — exiftool reads are I/O bound
    const limit = pLimit(32);
    let updated = 0;
    let processed = 0;

    // Process in chunks so we can write incrementally and report progress
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const chunk = rows.slice(i, i + BATCH_SIZE);

      const results = await Promise.all(
        chunk.map((row) =>
          limit(async () => {
            try {
              const exifData = await exiftool.read(row.path);
              // Mirror the same priority as extractMetadata
              const rawDate =
                exifData?.DateTimeOriginal ?? exifData?.CreationDate ?? null;

              if (rawDate) {
                if (typeof rawDate === "object" && rawDate.year) {
                  const pad = (n) => String(n).padStart(2, "0");
                  const local =
                    `${rawDate.year}-${pad(rawDate.month)}-${pad(rawDate.day)} ` +
                    `${pad(rawDate.hour)}:${pad(rawDate.minute)}:${pad(rawDate.second)}`;
                  return { id: row.id, local };
                }
                // String form (e.g. CreationDate with offset stripped to 19 chars)
                const dateStr =
                  typeof rawDate === "object" ? rawDate.toString() : rawDate;
                const normalised = dateStr.replace(
                  /^(\d{4}):(\d{2}):(\d{2})/,
                  "$1-$2-$3",
                );
                return { id: row.id, local: normalised.substring(0, 19) };
              }

              // Fallback: filename-encoded local time
              const fromFilename = parseFilenameDateTime(row.path);
              if (fromFilename) return { id: row.id, local: fromFilename };

              return null;
            } catch {
              return null;
            }
          }),
        ),
      );

      const valid = results.filter(Boolean);

      if (valid.length > 0) {
        db.transaction((b) => {
          for (const { id, local } of b) {
            updateStmt.run(local, id);
          }
        })(valid);
        updated += valid.length;
      }

      processed += chunk.length;

      if (mainWindow) {
        mainWindow.webContents.send("migration-progress", {
          processed,
          total: rows.length,
          percentage: Math.round((processed / rows.length) * 100),
        });
      }

      console.log(
        `Progress: ${processed}/${rows.length} processed, ${updated} updated`,
      );
    }

    return { success: true, updated };
  } catch (err) {
    console.error("migrate-create-date-local error:", err);
    return { success: false, error: err.message };
  }
});

/**
 * Parses local datetime from Android/camera filename conventions.
 * Handles: 20230101_000507.mp4, VID_20230101_000507.mp4, IMG_20230101_000507.jpg, etc.
 * Returns "YYYY-MM-DD HH:MM:SS" string, or null if no match.
 */
function parseFilenameDateTime(filePath) {
  const name = path.basename(filePath);
  const match = name.match(/(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/);
  if (!match) return null;

  const [, yr, mo, dy, hh, mm, ss] = match;

  // Basic sanity check
  if (mo < 1 || mo > 12 || dy < 1 || dy > 31 || hh > 23 || mm > 59 || ss > 59)
    return null;

  return `${yr}-${mo}-${dy} ${hh}:${mm}:${ss}`;
}

ipcMain.handle("cleanup-thumbnails", async () => {
  try {
    initDatabase();

    const thumbnailsDir = path.join(dataDir, "thumbnails");
    if (!fs.existsSync(thumbnailsDir)) {
      return {
        success: true,
        message: "No thumbnails folder found.",
        removed: 0,
      };
    }

    // Build a Set of all valid thumbnail filenames from the DB
    const rows = db.prepare("SELECT id FROM files").all();
    const validFilenames = new Set(rows.map((r) => `${r.id}_thumb.jpg`));

    // Read all files in the thumbnails directory
    const files = fs.readdirSync(thumbnailsDir);
    let removed = 0;

    for (const file of files) {
      if (!validFilenames.has(file)) {
        try {
          fs.unlinkSync(path.join(thumbnailsDir, file));
          removed++;
        } catch (err) {
          console.warn(
            `Failed to delete orphan thumbnail: ${file}`,
            err.message,
          );
        }
      }
    }

    return {
      success: true,
      message: `Removed ${removed} thumbnail(s).`,
      removed,
    };
  } catch (err) {
    console.error("cleanup-thumbnails error:", err);
    return { success: false, error: err.message };
  }
});

// Remove derived records that outlived their source rows.  These tables do not
// use foreign keys because the indexing workers access the database
// independently, so this is kept as an explicit maintenance action.
ipcMain.handle("cleanup-orphaned-index-data", async () => {
  try {
    initDatabase();

    const tableExists = (tableName) =>
      !!db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
        )
        .get(tableName);
    const cleanupTable = (tableName) => {
      if (!tableExists(tableName)) return 0;
      return db
        .prepare(
          `DELETE FROM ${tableName}
           WHERE NOT EXISTS (
             SELECT 1 FROM files WHERE files.id = ${tableName}.file_id
           )`,
        )
        .run().changes;
    };

    const removed = db.transaction(() => ({
      embeddings: cleanupTable("embeddings"),
      locations: cleanupTable("locations"),
      ocr: cleanupTable(OCR_INDEX_TABLE),
    }))();
    const total = removed.embeddings + removed.locations + removed.ocr;

    invalidateProgressSnapshots();
    return {
      success: true,
      removed,
      message: total
        ? `Removed ${total} stale indexing record(s): Smart Search ${removed.embeddings}, Places ${removed.locations}, Text Recognition ${removed.ocr}.`
        : "No stale Smart Search, Places, or Text Recognition records found.",
    };
  } catch (err) {
    console.error("cleanup-orphaned-index-data error:", err);
    return { success: false, error: err.message };
  }
});

// Overwrite a tag's media_ids entirely (enables removing items)
ipcMain.handle("tag:set-items", async (event, { tagId, mediaIds }) => {
  try {
    initDatabase();
    if (!tagId || !Array.isArray(mediaIds)) {
      throw new Error("Invalid parameters: tagId and mediaIds are required.");
    }
    const now = Date.now();
    db.prepare("UPDATE tags SET media_ids = ?, last_used = ? WHERE id = ?").run(
      JSON.stringify(mediaIds),
      now,
      tagId,
    );
    return { success: true, mediaIds };
  } catch (err) {
    console.error("tag:set-items error:", err);
    return { success: false, error: err.message };
  }
});

// Overwrite a memory's media_ids entirely (enables removing items)
ipcMain.handle("memory:set-items", async (event, { memoryId, mediaIds }) => {
  try {
    initDatabase();
    if (!memoryId || !Array.isArray(mediaIds)) {
      throw new Error(
        "Invalid parameters: memoryId and mediaIds are required.",
      );
    }
    db.prepare("UPDATE memories SET media_ids = ? WHERE id = ?").run(
      JSON.stringify(mediaIds),
      memoryId,
    );
    return { success: true, mediaIds };
  } catch (err) {
    console.error("memory:set-items error:", err);
    return { success: false, error: err.message };
  }
});

// ─── Drive Letter Map (stored in config.json under "driveLetterMap") ──────────
// Add "driveLetterMap": {} to your defaultConfig object.
// Format: { "D:/Photos": "E:", "C:/OldDrive/Media": "F:" }

ipcMain.handle("get-drive-letter-map", () => {
  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    return config.driveLetterMap || {};
  } catch {
    return {};
  }
});

ipcMain.handle("save-drive-letter-map", (event, map) => {
  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    config.driveLetterMap = map;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
    return { success: true };
  } catch (err) {
    console.error("save-drive-letter-map error:", err);
    return { success: false, error: err.message };
  }
});

/** Return current embedding progress */
ipcMain.handle("embedding:get-status", async () => {
  const resource = getResourceStatus("smart-search");
  if (!embeddingService || !embeddingService._worker) {
    const progress = await getProgressSnapshot("embedding");
    const serviceStatus = embeddingService?.getStatus();
    return {
      modelReady: false,
      initError: serviceStatus?.initError ?? null,
      ...progress,
      resource,
      paused: serviceStatus?.paused ?? readConfig().smartSearchPaused,
      pausePending: serviceStatus?.pausePending ?? false,
      percentage:
        progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0,
    };
  }
  return { ...embeddingService.getStatus(), resource };
});

/** Pause/resume from the renderer (optional — e.g. during active media browsing) */
ipcMain.handle("embedding:pause", () => {
  embeddingService?.pause();
  try {
    saveConfigPatch({ smartSearchPaused: true });
    return { ok: true };
  } catch (err) {
    console.error("Failed to persist Smart Search pause state:", err);
    return { ok: false, error: err.message };
  }
},
);
ipcMain.handle("embedding:resume", () => {
  try {
    saveConfigPatch({ smartSearchPaused: false });
    if (!embeddingService) startEmbeddingService();
    else {
      embeddingService.resume();
      embeddingService.start();
    }
    return { ok: true };
  } catch (err) {
    console.error("Failed to persist Smart Search pause state:", err);
    return { ok: false, error: err.message };
  }
});

/**
 * Smart search: find the top-N most similar images to a text query.
 * Returns an array of file IDs sorted by descending similarity.
 * Embed the query text via the child process,
 * then score all stored image vectors and return top-K file IDs.
 */
// ipcMain.handle("embedding:search", async (event, { query, topK = 200, threshold = 0.20 }) => {
//   if (!embeddingService?._pipelineReady) {
//     return { success: false, error: "Model not ready yet", results: [] };
//   }

//   try {
//     // Get text embedding from child process
//     const textVecArray = await embeddingService.embedText(query);
//     const textVec = new Float32Array(textVecArray);

//     // In main.js embedding:search handler, replace the single embedText call:
//     // const phrases = [
//     //   query,
//     //   `a photo of ${query}`,
//     //   `a picture of ${query}`,
//     // ];

//     // const embeddings = await Promise.all(
//     //   phrases.map(p => embeddingService.embedText(p))
//     // );

//     // // Average the vectors
//     // const dim = embeddings[0].length;
//     // const avgVec = new Float32Array(dim);
//     // for (const emb of embeddings) {
//     //   for (let i = 0; i < dim; i++) avgVec[i] += emb[i] / embeddings.length;
//     // }

//     // // Re-normalise
//     // const norm = Math.sqrt(avgVec.reduce((s, v) => s + v * v, 0)) || 1;
//     // const textVec = avgVec.map(v => v / norm);

//     initDatabase();
//     const rows = db.prepare(`
//       SELECT e.file_id, e.embedding
//       FROM   embeddings e
//       INNER  JOIN files f ON f.id = e.file_id
//     `).all();

//     if (!rows.length) return { success: true, results: [] };

//     const scored = rows.map(row => {
//       const imgVec = new Float32Array(
//         row.embedding.buffer,
//         row.embedding.byteOffset,
//         row.embedding.byteLength / 4
//       );
//       let dot = 0;
//       for (let i = 0; i < textVec.length; i++) dot += textVec[i] * imgVec[i];
//       return { fileId: row.file_id, score: dot };
//     });

//     scored.sort((a, b) => b.score - a.score);

//     // Filter out results below a similarity threshold.
//     // CLIP dot products on normalised vectors range roughly 0.15–0.35 for this model.
//     // 0.20 is a reasonable starting point — raise it to get stricter results.

//     const SIMILARITY_THRESHOLD = 0.20;
//     const filtered = scored.filter(r => r.score >= SIMILARITY_THRESHOLD).slice(0, topK);

//     return {
//       success: true,
//       results: filtered.map(r => r.fileId),
//       // Map of fileId → similarity score (0–1), so the UI can display confidence
//       scores: Object.fromEntries(filtered.map(r => [r.fileId, r.score])),
//     };
//   } catch (err) {
//     console.error("embedding:search error:", err);
//     return { success: false, error: err.message, results: [] };
//   }
// });

ipcMain.handle(
  "embedding:search",
  async (event, { query, topK = 200, threshold = 0.2 }) => {
    if (!embeddingService?._pipelineReady) {
      return { success: false, error: "Model not ready yet", results: [] };
    }

    try {
      const textVecArray = await embeddingService.embedText(query);

      // Always re-normalise the text vector here, regardless of what the child did.
      // CLIPTextModelWithProjection returns a projection that may not be unit length.
      const textRaw = new Float32Array(textVecArray);
      const textNorm = Math.sqrt(textRaw.reduce((s, v) => s + v * v, 0)) || 1;
      const textVec = textRaw.map((v) => v / textNorm);

      initDatabase();
      const rows = db
        .prepare(
          `
      SELECT e.file_id, e.embedding
      FROM   embeddings e
      INNER  JOIN files f ON f.id = e.file_id
    `,
        )
        .all();

      if (!rows.length) return { success: true, results: [], scores: {} };

      const scored = rows.map((row) => {
        const imgRaw = new Float32Array(
          row.embedding.buffer,
          row.embedding.byteOffset,
          row.embedding.byteLength / 4,
        );

        // Re-normalise image vector too — belt-and-suspenders in case the
        // pipeline's normalize:true produced vectors that drifted from unit length.
        const imgNorm = Math.sqrt(imgRaw.reduce((s, v) => s + v * v, 0)) || 1;

        let dot = 0;
        for (let i = 0; i < textVec.length; i++)
          dot += textVec[i] * (imgRaw[i] / imgNorm);

        return { fileId: row.file_id, score: dot };
      });

      scored.sort((a, b) => b.score - a.score);

      const SIMILARITY_THRESHOLD = threshold;
      const filtered = scored
        .filter((r) => r.score >= SIMILARITY_THRESHOLD)
        .slice(0, topK);

      return {
        success: true,
        results: filtered.map((r) => r.fileId),
        scores: Object.fromEntries(filtered.map((r) => [r.fileId, r.score])),
      };
    } catch (err) {
      console.error("embedding:search error:", err);
      return { success: false, error: err.message, results: [] };
    }
  },
);

ipcMain.handle(
  "embedding:search-by-id",
  async (event, { fileId, topK = 200, threshold = 0.2 }) => {
    if (!embeddingService?._pipelineReady) {
      return { success: false, error: "Model not ready yet", results: [] };
    }

    try {
      initDatabase();

      // Fetch the query image's stored embedding
      const queryRow = db
        .prepare(
          `
      SELECT embedding FROM embeddings WHERE file_id = ?
    `,
        )
        .get(fileId);

      if (!queryRow) {
        return {
          success: false,
          error: "No embedding found for this file",
          results: [],
        };
      }

      const queryRaw = new Float32Array(
        queryRow.embedding.buffer,
        queryRow.embedding.byteOffset,
        queryRow.embedding.byteLength / 4,
      );

      // Normalise query vector
      const queryNorm = Math.sqrt(queryRaw.reduce((s, v) => s + v * v, 0)) || 1;
      const queryVec = queryRaw.map((v) => v / queryNorm);

      // Fetch all other embeddings
      const rows = db
        .prepare(
          `
      SELECT e.file_id, e.embedding
      FROM embeddings e
      INNER JOIN files f ON f.id = e.file_id
      WHERE e.file_id != ?
    `,
        )
        .all(fileId);

      if (!rows.length) return { success: true, results: [], scores: {} };

      const scored = rows.map((row) => {
        const imgRaw = new Float32Array(
          row.embedding.buffer,
          row.embedding.byteOffset,
          row.embedding.byteLength / 4,
        );
        const imgNorm = Math.sqrt(imgRaw.reduce((s, v) => s + v * v, 0)) || 1;

        let dot = 0;
        for (let i = 0; i < queryVec.length; i++)
          dot += queryVec[i] * (imgRaw[i] / imgNorm);

        return { fileId: row.file_id, score: dot };
      });

      scored.sort((a, b) => b.score - a.score);

      const filtered = scored
        .filter((r) => r.score >= threshold)
        .slice(0, topK);

      return {
        success: true,
        results: filtered.map((r) => r.fileId),
        scores: Object.fromEntries(filtered.map((r) => [r.fileId, r.score])),
      };
    } catch (err) {
      console.error("embedding:search-by-id error:", err);
      return { success: false, error: err.message, results: [] };
    }
  },
);

ipcMain.handle("embedding:has-embedding", async (event, fileId) => {
  try {
    initDatabase();
    const row = db
      .prepare("SELECT 1 FROM embeddings WHERE file_id = ? LIMIT 1")
      .get(fileId);
    return !!row;
  } catch {
    return false;
  }
});

// ─── Location service IPC ──────────────────────────────────────────────────

/** Current progress snapshot */
ipcMain.handle("location:get-status", async () => {
  const resource = getResourceStatus("places");
  if (!locationService || !locationService._worker) {
    const progress = await getProgressSnapshot(
      "location",
      getLocationGeocoderVersion(
        normalizeLocationSelectionMode(readConfig().placesSelectionMode),
      ),
    );
    const serviceStatus = locationService?.getStatus();
    return {
      ...progress,
      resource,
      paused: serviceStatus?.paused ?? readConfig().locationIndexingPaused,
      pausePending: serviceStatus?.pausePending ?? false,
      percentage:
        progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0,
    };
  }
  return { ...locationService.getStatus(), resource };
});

ipcMain.handle("ocr:get-status", async () => {
  const resource = getResourceStatus("ocr");
  if (!ocrService || !ocrService._worker) {
    const progress = await getProgressSnapshot("ocr");
    const serviceStatus = ocrService?.getStatus();
    return {
      modelReady: false,
      initError: serviceStatus?.initError ?? null,
      ...progress,
      resource,
      paused: serviceStatus?.paused ?? readConfig().ocrIndexingPaused,
      pausePending: serviceStatus?.pausePending ?? false,
      percentage: progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0,
    };
  }
  return { ...ocrService.getStatus(), resource };
});

ipcMain.handle("ocr:pause", () => {
  ocrService?.pause();
  try {
    saveConfigPatch({ ocrIndexingPaused: true });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle("ocr:resume", () => {
  try {
    saveConfigPatch({ ocrIndexingPaused: false });
    if (!ocrService) startOcrService();
    else {
      ocrService.resume();
      ocrService.start();
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

function makeFtsQuery(query) {
  return String(query ?? "")
    .normalize("NFKC")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((term) => term.replace(/[^\p{L}\p{N}_]/gu, ""))
    .filter(Boolean)
    // Prefix matching finds longer OCR words; OR avoids requiring every term.
    .map((term) => `"${term}"*`)
    .join(" OR ");
}

function textSearchTerms(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .match(/[\p{L}\p{N}_]+/gu) ?? [];
}

// True for one substitution, insertion, or deletion. Keeping this bounded
// prevents OCR search from becoming a broad fuzzy search.
function differsByAtMostOneCharacter(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  if (a.length < b.length) [a, b] = [b, a];
  let left = 0;
  while (left < b.length && a[left] === b[left]) left += 1;
  if (a.length === b.length) {
    return a.slice(left + 1) === b.slice(left + 1);
  }
  return a.slice(left + 1) === b.slice(left);
}

function findOneCharacterTypoMatches(queryTerms, limit) {
  const typoTerms = [...new Set(queryTerms.filter((term) => term.length >= 4))];
  if (!typoTerms.length) return [];
  // Use anchors from multiple parts of the query. A first-character OCR typo
  // should not prevent the candidate from reaching the exact one-edit check.
  const anchors = [...new Set(typoTerms.flatMap((term) => [
    term.slice(0, 3),
    term.slice(Math.max(0, Math.floor(term.length / 2) - 1), Math.floor(term.length / 2) + 2),
    term.slice(-3),
  ]).filter((anchor) => anchor.length >= 3))];
  const where = anchors.map(() => "lower(text) LIKE ?").join(" OR ");
  const candidates = db.prepare(
    "SELECT file_id, text FROM " + OCR_INDEX_TABLE +
    " WHERE COALESCE(mean_confidence, 0) > 0 AND (" + where + ") LIMIT 1000",
  ).all(...anchors.map((anchor) => "%" + anchor + "%"));
  const matches = [];
  for (const candidate of candidates) {
    const words = textSearchTerms(candidate.text);
    if (typoTerms.some((term) => words.some((word) => differsByAtMostOneCharacter(term, word)))) {
      matches.push(candidate.file_id);
      if (matches.length >= limit) break;
    }
  }
  return matches;
}

ipcMain.handle("ocr:search", async (_event, { query, topK = 200 } = {}) => {
  try {
    initDatabase();
    const ftsQuery = makeFtsQuery(query);
    if (!ftsQuery) return { success: true, results: [], matches: {} };
    const ftsAvailable = db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
    ).get(OCR_FTS_TABLE);
    if (!ftsAvailable) return { success: true, results: [], matches: {} };
    const limit = Math.max(1, Math.min(5_000, Number(topK) || 200));
    const normalizedQuery = String(query ?? "").normalize("NFKC").trim();
    const searchSql =
      "SELECT file_id, MIN(score) AS score FROM (" +
      "SELECT " + OCR_FTS_TABLE + ".rowid AS file_id, bm25(" + OCR_FTS_TABLE + ") AS score " +
      "FROM " + OCR_FTS_TABLE + " JOIN " + OCR_INDEX_TABLE + " fts_index" +
      " ON fts_index.file_id = " + OCR_FTS_TABLE + ".rowid" +
      " WHERE " + OCR_FTS_TABLE + " MATCH ? AND COALESCE(fts_index.mean_confidence, 0) > 0 " +
      "UNION ALL SELECT file_id, 0 AS score FROM " + OCR_INDEX_TABLE +
      " WHERE COALESCE(mean_confidence, 0) > 0 AND instr(lower(text), lower(?)) > 0 " +
      ") GROUP BY file_id ORDER BY score ASC, file_id ASC LIMIT ?";
    const rows = db.prepare(searchSql).all(
      ftsQuery, normalizedQuery, limit,
    );
    const existingIds = new Set(rows.map((row) => row.file_id));
    const typoIds = findOneCharacterTypoMatches(textSearchTerms(normalizedQuery), limit)
      .filter((fileId) => !existingIds.has(fileId));
    const results = [
      ...rows.map((row) => row.file_id),
      ...typoIds,
    ].slice(0, limit);
    return {
      success: true,
      results,
      matches: Object.fromEntries([
        ...rows.map((row) => [row.file_id, row.score < 0 ? "Text match" : "Contains query"]),
        ...typoIds.map((fileId) => [fileId, "1-character typo match"]),
      ]),
    };
  } catch (error) {
    console.error("ocr:search error:", error);
    return { success: false, error: error.message, results: [], matches: {} };
  }
});

function decodeOcrBoxes(blob) {
  if (!blob?.byteLength) return [];
  const values = new Uint16Array(blob.buffer, blob.byteOffset, Math.floor(blob.byteLength / 2));
  const boxes = [];
  for (let offset = 0; offset + 7 < values.length; offset += 8) {
    boxes.push([
      [values[offset] / 65535, values[offset + 1] / 65535],
      [values[offset + 2] / 65535, values[offset + 3] / 65535],
      [values[offset + 4] / 65535, values[offset + 5] / 65535],
      [values[offset + 6] / 65535, values[offset + 7] / 65535],
    ]);
  }
  return boxes;
}

// The UI does not render OCR overlays yet, but expose the compact, normalized
// quadrilaterals now so PreviewPanel can add them without a schema migration.
ipcMain.handle("ocr:get-for-files", async (_event, fileIds) => {
  try {
    initDatabase();
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(OCR_INDEX_TABLE)) {
      return { success: true, rows: [] };
    }
    const ids = Array.isArray(fileIds) ? fileIds.filter(Number.isInteger) : [];
    if (!ids.length) return { success: true, rows: [] };
    const rows = [];
    for (let index = 0; index < ids.length; index += 999) {
      const chunk = ids.slice(index, index + 999);
      const sql = "SELECT file_id, text, boxes, box_count, mean_confidence FROM " +
        OCR_INDEX_TABLE + " WHERE file_id IN (" + chunk.map(() => "?").join(",") + ")";
      rows.push(...db.prepare(sql).all(...chunk).map((row) => {
        // OCR text is stored in detection order, one line per retained box.
        // Return that pairing so the preview can highlight the matching region.
        const boxTexts = String(row.text ?? "").split("\n");
        return {
          ...row,
          boxes: decodeOcrBoxes(row.boxes).map((points, index) => ({
            points,
            text: boxTexts[index] ?? "",
          })),
        };
      }));
    }
    return { success: true, rows };
  } catch (error) {
    return { success: false, error: error.message, rows: [] };
  }
});

ipcMain.handle("resource:download", async (_event, requestedId) => {
  const resourceId =
    typeof requestedId === "string" ? requestedId : requestedId?.id;

  try {
    const status = await resourceManager.download(resourceId);
    if (resourceId === "smart-search") startEmbeddingService();
    if (resourceId === "places") startLocationService();
    if (resourceId === "ocr") startOcrService();
    return { ok: true, status };
  } catch (error) {
    return {
      ok: false,
      status: getResourceStatus(resourceId),
      error: error.message || "Resource download failed.",
    };
  }
});

ipcMain.handle("location:pause", () => {
  locationService?.pause();
  try {
    saveConfigPatch({ locationIndexingPaused: true });
    return { ok: true };
  } catch (err) {
    console.error("Failed to persist Location Indexing pause state:", err);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle("location:resume", () => {
  try {
    saveConfigPatch({ locationIndexingPaused: false });
    if (!locationService) startLocationService();
    else {
      locationService.resume();
      locationService.start();
    }
    return { ok: true };
  } catch (err) {
    console.error("Failed to persist Location Indexing pause state:", err);
    return { ok: false, error: err.message };
  }
});

/**
 * Fetch resolved location rows for a set of file IDs.
 * Accepts an optional array of file IDs; if omitted returns all rows.
 * Returns: [{ file_id, country, subdivision, city }]
 */
ipcMain.handle("location:get-for-files", async (event, fileIds) => {
  try {
    initDatabase();
    const displayName = locationDisplayNameExpression(
      readConfig().placesNameDisplay,
    );

    if (Array.isArray(fileIds) && fileIds.length > 0) {
      // Chunk to stay under SQLite's 999-variable limit.
      const chunkSize = 999;
      const rows = [];
      for (let i = 0; i < fileIds.length; i += chunkSize) {
        const chunk = fileIds.slice(i, i + chunkSize);
        const placeholders = chunk.map(() => "?").join(",");
        rows.push(
          ...db
            .prepare(
              "SELECT file_id, country, subdivision, " +
                displayName +
                " AS city, local_name, english_name, subtype, admin_level, area " +
                "FROM locations WHERE file_id IN (" +
                placeholders +
                ")",
            )
            .all(...chunk)
        );
      }
      return { success: true, rows };
    }

    // No filter — return everything (used by stats / map views).
    const rows = db
      .prepare(
        "SELECT file_id, country, subdivision, " +
          displayName +
          " AS city, local_name, english_name, subtype, admin_level, area FROM locations",
      )
      .all();
    return { success: true, rows };
  } catch (err) {
    console.error("location:get-for-files error:", err);
    return { success: false, error: err.message, rows: [] };
  }
});

// ─── Shared thumbnail helper ─────────────────────────────────────────────────
//
// Given an array of file IDs, returns up to `limit` thumbnail rows ordered by
// the same "quality score" used in the memories fetch (camera metadata,
// aspect-ratio proximity to 1.3, megapixels, then random tie-break).
//
function pickThumbnails(db, ids, limit = 1) {
  if (!ids || ids.length === 0) return [];

  const chunkSize = 999;
  const thumbnails = [];

  for (let i = 0; i < ids.length; i += chunkSize) {
    if (thumbnails.length >= limit) break;
    const chunk = ids.slice(i, i + chunkSize);
    const remaining = limit - thumbnails.length;

    const rows = db
      .prepare(
        `
        SELECT id, thumbnail_path
        FROM   files
        WHERE  id IN (${chunk.map(() => "?").join(",")})
          AND  file_type       = 'image'
          AND  thumbnail_path IS NOT NULL
        ORDER BY
          (
            CASE WHEN camera_make   IS NOT NULL THEN 4 ELSE 0 END +
            CASE WHEN camera_model  IS NOT NULL THEN 3 ELSE 0 END +
            CASE WHEN lens_model    IS NOT NULL THEN 2 ELSE 0 END +
            CASE WHEN focal_length  IS NOT NULL THEN 2 ELSE 0 END +
            CASE WHEN iso           IS NOT NULL THEN 1 ELSE 0 END +
            CASE WHEN aperture      IS NOT NULL THEN 1 ELSE 0 END +
            CASE WHEN latitude      IS NOT NULL THEN 2 ELSE 0 END +
            CASE WHEN longitude     IS NOT NULL THEN 2 ELSE 0 END
          ) DESC,
          ABS((CAST(width AS REAL) / height) - 1.3) ASC,
          megapixels DESC,
          RANDOM()
        LIMIT ?
      `
      )
      .all(...chunk, remaining);

    thumbnails.push(...rows);
  }

  return thumbnails;
}

// A visit segment continues until the place changes. This keeps consecutive
// occurrences together while preserving a return visit after another place.
function createPlaceVisitSegments(rows, getPlaces) {
  const segments = [];
  let previousSegments = new Map();
  const sortedRows = [...rows].sort(
    (a, b) => (a.create_date || 0) - (b.create_date || 0) || a.id - b.id,
  );

  for (const row of sortedRows) {
    const timestamp = Number(row.create_date) || 0;
    const currentSegments = new Map();

    for (const place of getPlaces(row)) {
      const previous = previousSegments.get(place.key);
      const canContinue = Boolean(previous);
      const segment = canContinue
        ? previous
        : {
            ...place,
            count: 0,
            ids: [],
            startVisit: timestamp,
            lastVisit: timestamp,
            lastThumbnail: null,
          };

      if (!canContinue) segments.push(segment);
      segment.count++;
      segment.ids.push(row.id);
      segment.lastVisit = timestamp;
      if (row.file_type === "image" && row.thumbnail_path) {
        segment.lastThumbnail = { id: row.id, thumbnail_path: row.thumbnail_path };
      }
      currentSegments.set(place.key, segment);
    }
    previousSegments = currentSegments;
  }

  return segments;
}

// ─── Countries ────────────────────────────────────────────────────────────────
//
// Source: files.country  (the column on the file itself, not locations)
// Returns: [{ country, count, ids, thumbnails }]

ipcMain.handle("location:get-countries", async (event, currentSettings = {}) => {
  try {
    initDatabase();

    const {
      placesSortBy = "count",
      placesChronological = false,
      placesThumbnails = "random",
      placesMinCount = 1,
      placesExcludeFlights = false,
    } = currentSettings;

    const rows = db
      .prepare(
        `
        SELECT id, country, altitude, create_date, file_type, thumbnail_path
        FROM files
        WHERE country IS NOT NULL
          AND country != ''
          ${placesExcludeFlights ? "AND (altitude IS NULL OR altitude <= 9000)" : ""}
      `
      )
      .all();

    const countryMap = {};

    for (const row of rows) {
      const countries = normalizeCountries(row.country);

      for (const country of countries) {
        if (!countryMap[country]) {
          countryMap[country] = {
            country,
            count: 0,
            ids: [],
            lastVisit: 0,
            lastThumbnail: null,
          };
        }

        const entry = countryMap[country];

        entry.count++;
        entry.ids.push(row.id);

        // track last visit
        if (row.create_date && row.create_date > entry.lastVisit) {
          entry.lastVisit = row.create_date;

          // store thumbnail of newest item
          if (
            placesThumbnails === "last_visit" &&
            row.file_type === "image" &&
            row.thumbnail_path
          ) {
            entry.lastThumbnail = {
              id: row.id,
              thumbnail_path: row.thumbnail_path,
            };
          }
        }
      }
    }

    const entries = placesChronological
      ? createPlaceVisitSegments(rows, (row) =>
          normalizeCountries(row.country).map((country) => ({
            key: country,
            country,
          })),
        )
      : Object.values(countryMap);

    let result = entries
      .filter((x) => x.count >= placesMinCount)
      .map((entry) => {
        const thumbnail =
          placesThumbnails === "last_visit"
            ? entry.lastThumbnail
            : pickThumbnails(db, entry.ids, 1)[0];

        return {
          country: entry.country,
          count: entry.count,
          ids: entry.ids,
          startVisit: entry.startVisit,
          lastVisit: entry.lastVisit,
          thumbnails: thumbnail ? [thumbnail] : [],
        };
      });

    if (placesChronological) {
      result.sort((a, b) => b.startVisit - a.startVisit);
    } else if (placesSortBy === "last_visit") {
      result.sort((a, b) => b.lastVisit - a.lastVisit);
    } else if (placesSortBy === "population") {
      result.sort((a, b) => {
        const popA = countryPopulationMap[(a.country || "").toUpperCase()] || 0;
        const popB = countryPopulationMap[(b.country || "").toUpperCase()] || 0;
    
        return popB - popA;
      });
    } else if (placesSortBy === "alphabetical") {
      result.sort((a, b) => a.country.localeCompare(b.country));
    } else {
      result.sort((a, b) => b.count - a.count);
    }

    return { success: true, data: result };
  } catch (err) {
    console.error("location:get-countries error:", err);
    return { success: false, error: err.message };
  }
});

// ─── Regions ──────────────────────────────────────────────────────────────────
//
// Source: locations.subdivision (locality region/subdivision code)
//         joined back to files for thumbnails & IDs
// Returns: [{ country, subdivision, count, ids, thumbnails }]

ipcMain.handle("location:get-regions", async (event, currentSettings = {}) => {
  try {
    initDatabase();

    const {
      placesSortBy = "count",
      placesChronological = false,
      placesThumbnails = "random",
      placesMinCount = 1,
      placesExcludeFlights = false,
    } = currentSettings;

    const rows = db
      .prepare(
        `
        SELECT
          l.country,
          l.subdivision,
          f.id,
          f.create_date,
          f.file_type,
          f.thumbnail_path
        FROM locations l
        JOIN files f ON f.id = l.file_id
        WHERE l.subdivision IS NOT NULL
          AND l.subdivision != ''
          ${placesExcludeFlights ? "AND (f.altitude IS NULL OR f.altitude <= 9000)" : ""}
      `
      )
      .all();

    const map = {};

    for (const row of rows) {
      const key = `${row.country}|${row.subdivision}`;

      if (!map[key]) {
        map[key] = {
          country: row.country,
          subdivision: row.subdivision,
          count: 0,
          ids: [],
          lastVisit: 0,
          lastThumbnail: null,
        };
      }

      const entry = map[key];

      entry.count++;
      entry.ids.push(row.id);

      if (row.create_date && row.create_date > entry.lastVisit) {
        entry.lastVisit = row.create_date;

        if (
          placesThumbnails === "last_visit" &&
          row.file_type === "image" &&
          row.thumbnail_path
        ) {
          entry.lastThumbnail = {
            id: row.id,
            thumbnail_path: row.thumbnail_path,
          };
        }
      }
    }

    const entries = placesChronological
      ? createPlaceVisitSegments(rows, (row) => [
          {
            key: `${row.country}|${row.subdivision}`,
            country: row.country,
            subdivision: row.subdivision,
          },
        ])
      : Object.values(map);

    let result = entries
      .filter((x) => x.count >= placesMinCount)
      .map((entry) => {
        const thumbnail =
          placesThumbnails === "last_visit"
            ? entry.lastThumbnail
            : pickThumbnails(db, entry.ids, 1)[0];

        return {
          country: entry.country,
          subdivision: entry.subdivision,
          count: entry.count,
          ids: entry.ids,
          startVisit: entry.startVisit,
          lastVisit: entry.lastVisit,
          thumbnails: thumbnail ? [thumbnail] : [],
        };
      });

    if (placesChronological) {
      result.sort((a, b) => b.startVisit - a.startVisit);
    } else if (placesSortBy === "last_visit") {
      result.sort((a, b) => b.lastVisit - a.lastVisit);
    } else if (placesSortBy === "alphabetical") {
      result.sort((a, b) => a.subdivision.localeCompare(b.subdivision));
    } else {
      result.sort((a, b) => b.count - a.count);
    }

    return { success: true, data: result };
  } catch (err) {
    console.error("location:get-regions error:", err);
    return { success: false, error: err.message };
  }
});

// ─── Cities ───────────────────────────────────────────────────────────────────
//
// Source: locations.city (containing locality display name)
// Returns: [{ country, subdivision, city, count, ids, thumbnails }]

ipcMain.handle("location:get-cities", async (event, currentSettings = {}) => {
  try {
    initDatabase();

    const {
      placesSortBy = "count",
      placesChronological = false,
      placesThumbnails = "random",
      placesMinCount = 1,
      placesExcludeFlights = false,
      placesNameDisplay = "english",
    } = currentSettings;
    const cityDisplayName = locationDisplayNameExpression(
      placesNameDisplay,
      "l",
    );

    const rows = db
      .prepare(
        `
        SELECT
          l.country,
          l.subdivision,
          ${cityDisplayName} AS city,
          f.id,
          f.create_date,
          f.file_type,
          f.thumbnail_path
        FROM locations l
        JOIN files f ON f.id = l.file_id
        WHERE ${cityDisplayName} IS NOT NULL
          AND ${cityDisplayName} != ''
          ${placesExcludeFlights ? "AND (f.altitude IS NULL OR f.altitude <= 9000)" : ""}
      `
      )
      .all();

    const map = {};

    for (const row of rows) {
      const key = `${row.country}|${row.subdivision}|${row.city}`;

      if (!map[key]) {
        map[key] = {
          country: row.country,
          subdivision: row.subdivision,
          city: row.city,
          count: 0,
          ids: [],
          lastVisit: 0,
          lastThumbnail: null,
        };
      }

      const entry = map[key];

      entry.count++;
      entry.ids.push(row.id);

      // track newest visit + thumbnail in one pass
      if (row.create_date && row.create_date > entry.lastVisit) {
        entry.lastVisit = row.create_date;

        if (
          placesThumbnails === "last_visit" &&
          row.file_type === "image" &&
          row.thumbnail_path
        ) {
          entry.lastThumbnail = {
            id: row.id,
            thumbnail_path: row.thumbnail_path,
          };
        }
      }
    }

    const entries = placesChronological
      ? createPlaceVisitSegments(rows, (row) => [
          {
            key: `${row.country}|${row.subdivision}|${row.city}`,
            country: row.country,
            subdivision: row.subdivision,
            city: row.city,
          },
        ])
      : Object.values(map);

    let result = entries
      .filter((x) => x.count >= placesMinCount)
      .map((entry) => {
        const thumbnail =
          placesThumbnails === "last_visit"
            ? entry.lastThumbnail
            : pickThumbnails(db, entry.ids, 1)[0];

        return {
          country: entry.country,
          subdivision: entry.subdivision,
          city: entry.city,
          count: entry.count,
          ids: entry.ids,
          startVisit: entry.startVisit,
          lastVisit: entry.lastVisit,
          thumbnails: thumbnail ? [thumbnail] : [],
        };
      });

    if (placesChronological) {
      result.sort((a, b) => b.startVisit - a.startVisit);
    } else if (placesSortBy === "last_visit") {
      result.sort((a, b) => b.lastVisit - a.lastVisit);
    } else if (placesSortBy === "alphabetical") {
      result.sort((a, b) => a.city.localeCompare(b.city));
    } else {
      result.sort((a, b) => b.count - a.count);
    }

    return { success: true, data: result };
  } catch (err) {
    console.error("location:get-cities error:", err);
    return { success: false, error: err.message };
  }
});

// Helper for use in Express routes and open-in-default-viewer:
function getDriveLetterMap() {
  // Use getSettings if it exists, otherwise fall back to reading directly
  const settings =
    typeof getSettings === "function"
      ? getSettings()
      : (() => {
          try {
            return JSON.parse(fs.readFileSync(configPath, "utf8"));
          } catch {
            return defaultConfig;
          }
        })();

  return settings.driveLetterMap || {};
}

function applyDriveLetterMap(filePath, map) {
  if (!filePath || !map || Object.keys(map).length === 0) return filePath;

  const normalizedPath = filePath.replace(/\//g, "\\"); // normalize slashes for matching

  for (const [originalFolder, customLetter] of Object.entries(map)) {
    if (!originalFolder || !customLetter) continue;

    // Remove trailing slashes from the map path
    const trimmedOriginal = originalFolder.replace(/[\\/]+$/, "");

    // Compare case-insensitively
    if (
      normalizedPath.toUpperCase().startsWith(trimmedOriginal.toUpperCase())
    ) {
      // Ensure custom drive ends with colon only (no double backslash)
      const normalizedCustom = customLetter.replace(/:?$/, ":");

      // Keep the full path after the original drive (do not slice the folder)
      const remainder = filePath.slice(2); // remove original drive letter only

      // Avoid double backslash if remainder starts with \
      const cleanRemainder = remainder.startsWith("\\")
        ? remainder
        : "\\" + remainder;

      return normalizedCustom + cleanRemainder;
    }
  }

  return filePath;
}

ipcMain.handle(
  "fetch-timeline-months",
  async (event, { filters = {}, sortOrder = "desc", settings = {} } = {}) => {
    try {
      initDatabase();
      settings = settings ?? {};
      const dir = sortOrder === "asc" ? "ASC" : "DESC";
      const datePart = (fmt) => `
      CASE
        WHEN create_date_local IS NOT NULL
          THEN strftime('${fmt}', create_date_local)
        WHEN create_date IS NOT NULL
          THEN strftime('${fmt}', datetime(create_date, 'unixepoch', 'localtime'))
        ELSE
          strftime('${fmt}', datetime(MIN(created, modified), 'unixepoch', 'localtime'))
      END
    `;
      const { sql, params } = buildWhereClause(filters, {
        excludeScreenCaptures: !!settings.hideScreenshotsAndScreenRecordings,
        hiddenFolders: settings.hiddenFolders,
      });
      return db
        .prepare(
          `
      SELECT
        ${datePart("%Y")} AS year,
        ${datePart("%m")} AS month,
        COUNT(*)          AS total
      FROM files
      ${sql}
      GROUP BY year, month
      ORDER BY year ${dir}, month ${dir}
    `,
        )
        .all(...params);
    } catch (err) {
      console.error("fetch-timeline-months error:", err);
      return [];
    }
  },
);

ipcMain.handle("get-item-by-id", async (event, id) => {
  try {
    initDatabase();

    const row = db
      .prepare("SELECT * FROM FILES WHERE id = ?")
      .get(id);

    if (!row) {
      throw new Error(`Item ${id} not found`);
    }

    return { success: true, item: row };
  } catch (err) {
    console.error("get-item-by-id error:", err);
    return { success: false, error: err.message };
  }
});

// Returns filename suggestion + size estimate for the backup popup
ipcMain.handle("get-backup-preview", async () => {
  try {
    const configSize = fs.existsSync(configPath)
      ? fs.statSync(configPath).size
      : 0;

    const dbFilePath = path.join(dataDir, "orbit-index.db");
    const dbSize = fs.existsSync(dbFilePath) ? fs.statSync(dbFilePath).size : 0;

    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const defaultFilename = `orbit-backup-${now.getFullYear()}-${pad(
      now.getMonth() + 1,
    )}-${pad(now.getDate())}.zip`;

    return {
      success: true,
      configSize,
      dbSize,
      totalSize: configSize + dbSize,
      defaultFilename,
    };
  } catch (err) {
    console.error("get-backup-preview error:", err);
    return { success: false, error: err.message };
  }
});

// Creates the zip. Opens a native save dialog so the user picks the destination.
ipcMain.handle("create-backup", async (event, filename) => {
  try {
    const safeFilename = (filename || "orbit-backup.zip").trim() || "orbit-backup.zip";
    const finalFilename = safeFilename.toLowerCase().endsWith(".zip")
      ? safeFilename
      : `${safeFilename}.zip`;

    const result = await dialog.showSaveDialog(mainWindow, {
      title: "Save Backup",
      defaultPath: finalFilename,
      filters: [{ name: "Zip Archives", extensions: ["zip"] }],
    });

    if (result.canceled || !result.filePath) {
      return { success: false, canceled: true };
    }

    const zip = new AdmZip();

    if (fs.existsSync(configPath)) {
      zip.addLocalFile(configPath);
    }

    const dbFilePath = path.join(dataDir, "orbit-index.db");
    if (fs.existsSync(dbFilePath)) {
      zip.addLocalFile(dbFilePath);
    }

    zip.writeZip(result.filePath);

    return { success: true, filePath: result.filePath };
  } catch (err) {
    console.error("create-backup error:", err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle(
  "fetch-milestones",
  async (event, { excludeScreenCaptures = false } = {}) => {
  try {
    initDatabase();

    const hasDate = `(create_date_local IS NOT NULL OR create_date IS NOT NULL OR created IS NOT NULL OR modified IS NOT NULL)`;
    const captureFilter = excludeScreenCaptures
      ? "COALESCE(NULLIF(TRIM(capture_type), ''), 'unknown') IN ('camera', 'unknown')"
      : null;
    const captureWhere = captureFilter ? `WHERE ${captureFilter}` : "";
    const datedCaptureWhere = captureFilter
      ? `WHERE ${captureFilter} AND ${hasDate}`
      : `WHERE ${hasDate}`;
    const dateExpr = `
      CASE
        WHEN create_date_local IS NOT NULL THEN create_date_local
        WHEN create_date IS NOT NULL THEN datetime(create_date, 'unixepoch', 'localtime')
        ELSE datetime(MIN(created, modified), 'unixepoch', 'localtime')
      END
    `;

    const currentMax = excludeScreenCaptures
      ? db.prepare(`SELECT COUNT(*) as count FROM files ${captureWhere}`).get()
          ?.count || 0
      : db.prepare(`SELECT MAX(media_id) as maxId FROM files`).get()?.maxId ||
        0;

    if (currentMax === 0) {
      return { success: true, achieved: [], upcoming: [], currentMax: 0 };
    }

    // --- Build the milestone ladder ---
    // 1k, 10k, 25k, 50k, 75k, 100k, 150k, then every 50k to 1M, then every 100k after
    const milestoneSet = [1000, 10000, 25000, 50000, 75000, 100000, 150000];
    for (let m = 200000; m <= 1000000; m += 50000) milestoneSet.push(m);
    const upperBound = Math.max(currentMax * 3, 2000000);
    for (let m = 1100000; m <= upperBound; m += 100000) milestoneSet.push(m);

    const achievedThresholds = milestoneSet.filter((m) => m <= currentMax);
    const upcomingThresholds = milestoneSet.filter((m) => m > currentMax).slice(0, 8);

    // --- Achieved: look up the item that reaches each milestone ---
    const achieved = [];
    if (achievedThresholds.length) {
      const selectFields = `id, media_id, filename, thumbnail_path, ${dateExpr} AS date`;
      const rows = excludeScreenCaptures
        ? (() => {
            const milestoneItemStmt = db.prepare(
              `SELECT ${selectFields} FROM files ${captureWhere} ORDER BY media_id ASC LIMIT 1 OFFSET ?`,
            );
            return achievedThresholds.map((milestone) =>
              milestoneItemStmt.get(milestone - 1),
            );
          })()
        : db
            .prepare(
              `SELECT ${selectFields} FROM files WHERE media_id IN (${achievedThresholds.map(() => "?").join(",")})`,
            )
            .all(...achievedThresholds);
      for (const [index, m] of achievedThresholds.entries()) {
        const item = excludeScreenCaptures
          ? rows[index]
          : rows.find((row) => row.media_id === m);
        achieved.push({
          milestone: m,
          date: item?.date || null,
          item: item || null,
        });
      }
    }

    // --- Growth rate: weekly counts (zero-filled) -> EWMA, spike-capped ---
    const dateRows = db
      .prepare(`SELECT ${dateExpr} AS date FROM files ${datedCaptureWhere}`)
      .all();

    let weeklyRate = 0;
    if (dateRows.length > 1) {
      const WEEK_SECONDS = 7 * 24 * 60 * 60;
      const buckets = {};
      let minBucket = Infinity;

      for (const row of dateRows) {
        if (!row.date) continue;
        const t = new Date(row.date.replace(" ", "T")).getTime();
        if (isNaN(t)) continue;
        const bucket = Math.floor(t / 1000 / WEEK_SECONDS);
        buckets[bucket] = (buckets[bucket] || 0) + 1;
        if (bucket < minBucket) minBucket = bucket;
      }

      const nowBucket = Math.floor(Date.now() / 1000 / WEEK_SECONDS);
      const maxBucket = Math.max(nowBucket, ...Object.keys(buckets).map(Number));

      const ALPHA = 0.2; // smoothing factor
      const CAP_MULTIPLIER = 3; // clip any week to at most 3x the current smoothed rate
      let ewma = null;

      for (let b = minBucket; b <= maxBucket; b++) {
        let value = buckets[b] || 0;
        if (ewma !== null) {
          const cap = ewma * CAP_MULTIPLIER;
          if (value > cap) value = cap;
        }
        ewma = ewma === null ? value : ALPHA * value + (1 - ALPHA) * ewma;
      }

      weeklyRate = ewma || 0;
    }

    const dailyRate = weeklyRate / 7;
    const MIN_DAILY_RATE = 0.02; // below this, growth is too flat to forecast meaningfully

    const upcoming = upcomingThresholds.map((m) => {
      const remaining = m - currentMax;
      if (dailyRate < MIN_DAILY_RATE) {
        return { milestone: m, predictedDate: null, unavailable: true };
      }
      const daysNeeded = remaining / dailyRate;
      const predicted = new Date(Date.now() + daysNeeded * 86400000);
      return { milestone: m, predictedDate: predicted.toISOString(), unavailable: false };
    });

    return { success: true, achieved, upcoming, currentMax, weeklyRate };
  } catch (err) {
    console.error("fetch-milestones error:", err);
    return { success: false, error: err.message, achieved: [], upcoming: [] };
  }
  },
);

ipcMain.handle("toggle-fullscreen", () => {
  if (mainWindow) mainWindow.setFullScreen(!mainWindow.isFullScreen());
});

ipcMain.on("quick-minimize", () => {
  mainWindow.minimize();
});

ipcMain.handle("maximize-app", (event) => {
  if (mainWindow.isMaximized()) {
    mainWindow.unmaximize();
  } else {
    mainWindow.maximize();
  }
});

// Properly shut down exiftool on exit
app.on("before-quit", async () => {
  await exiftool.end();
  embeddingService?.stop();
  locationService?.stop();
  ocrService?.stop();
});
