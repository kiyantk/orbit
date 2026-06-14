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
const crypto = require("crypto");
let embeddingService = null;
let _textPipeline = null;

if (ffmpegPath) ffmpeg.setFfmpegPath(ffmpegPath);

let mainWindow;
let splash;

const normalizeCountries = (country) =>
  (country || "")
    .split(",")
    .map((c) => c.trim().toUpperCase())
    .filter(Boolean);

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

  appServer.listen(serverPort, () => {
    console.log(`Local file server running on http://localhost:${serverPort}`);
  });

  mainWindow.loadURL("http://localhost:3000");
  // mainWindow.loadFile(path.join(__dirname, 'index.html'));
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
  memoriesLayout: "list",
  driveLetterMap: {},
};

// Database
let db;

function initPaths() {
  dataDir = path.join(app.getPath("userData"), "data");
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  configPath = path.join(dataDir, "config.json");
  dbPath = path.join(dataDir, "orbit-index.db");
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
  initDatabase();
  embeddingService = new EmbeddingService(db, dataDir, () => mainWindow);
  embeddingService.start();
}

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

  return JSON.parse(fs.readFileSync(configPath, "utf8"));
});

ipcMain.handle("save-settings", async (event, settings) => {
  try {
    fs.writeFileSync(configPath, JSON.stringify(settings, null, 2), "utf8");
    return { success: true };
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
    }
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

      const { sql: whereSQL, params } = buildWhereClause(filters);

      // --- sorting ---
      let orderSQL = "";
      if (filters.sortBy === "random") {
        orderSQL = "ORDER BY RANDOM()";
      } else if (
        Array.isArray(filters.ids) &&
        filters.ids.length > 0 &&
        filters._smartSearch
      ) {
        // Smart search: preserve similarity rank order supplied by the caller.
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

  const { sql: whereSQL, params } = buildWhereClause(filters);

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
      SELECT latitude, longitude, altitude, country, create_date, filename, device_model
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

    const { sql, params } = buildWhereClause(filters);

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
    console.error(`Error generating thumbnail for ${filePath}:`, err.message);
    return null;
  }
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
    if (!exifData) return metadata;

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

  return metadata;
}

const pLimit = require("p-limit");
const os = require("os");
const cpuCount = os.cpus().length;
const METADATA_CONCURRENCY = Math.max(1, Math.floor(cpuCount / 2)); // 1 task per 2 cores
const THUMBNAIL_CONCURRENCY = Math.max(1, Math.floor(cpuCount / 3)); // 1 task per 3 cores
const BATCH_SIZE = 1000; // insert batch size
const dbWriteLimit = pLimit(1);

// Count total files for progress tracking
function countTotalFiles(folderPath, existingPaths = new Set()) {
  let total = 0;
  const entries = fs.readdirSync(folderPath, { withFileTypes: true });

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
  const dirHandle = await fsPromises.opendir(dir);
  for await (const entry of dirHandle) {
    const res = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkDir(res);
    } else if (entry.isFile()) {
      yield res;
    }
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
     file_type, device_model, camera_make, camera_model, width, height,
     orientation, latitude, longitude, altitude, create_date, create_date_local, thumbnail_path,
     lens_model, iso, software, offset_time_original, megapixels,
     exposure_time, color_space, flash, aperture, focal_length, focal_length_35mm, country)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const limitMetadata = pLimit(METADATA_CONCURRENCY);
  const limitThumb = pLimit(THUMBNAIL_CONCURRENCY);

  let batchRows = [];
  let processed = 0;
  let lastUpdate = Date.now();

  for await (const filePath of walkDir(rootFolder)) {
    if (existingPaths.has(filePath)) {
      continue; // already indexed
    }

    const stats = await fsPromises.stat(filePath);
    const fileName = path.basename(filePath);

    const metadata = await limitMetadata(() => extractMetadata(filePath));

    batchRows.push({ fileName, fullPath: filePath, stats, metadata });

    if (batchRows.length >= BATCH_SIZE) {
      await insertBatch(batchRows, insertStmt, rootFolder, limitThumb);
      batchRows = [];
    }

    processed++;

    // Throttle IPC progress updates (max 1 every 100ms)
    const now = Date.now();
    if (now - lastUpdate > 100) {
      progressCallback?.(processed);
      lastUpdate = now;
    }
  }

  if (batchRows.length > 0) {
    await insertBatch(batchRows, insertStmt, rootFolder, limitThumb);
    // processed += batchRows.length;
    progressCallback?.(processed);
  }
}

ipcMain.handle("fetch-options", async (event, { birthDate = null }) => {
  try {
    initDatabase();

    const devices = db
      .prepare(
        "SELECT DISTINCT device_model FROM files WHERE device_model IS NOT NULL",
      )
      .all()
      .map((r) => r.device_model);
    const driveMap = getDriveLetterMap();
    const folders = db
      .prepare(
        "SELECT DISTINCT folder_path FROM files WHERE folder_path IS NOT NULL",
      )
      .all()
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
  await Promise.all(
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

        // 2. Remove item from DB
        db.prepare("DELETE FROM files WHERE id = ?").run(id);
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
    for (const id of idSet) {
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

    event.sender.send("item-removed", { ids: [...idSet] });

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

    // Per-table row counts + byte estimates via dbstat
    const tableNames = [
      "files",
      "embeddings",
      "memories",
      "tags",
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
      appStorageUsed: dbSize + thumbSize,
      dbSize,
      thumbSize,
      tables,
    };
  } catch (error) {
    console.error("Error getting storage usage:", error);
    return { appStorageUsed: 0, dbSize: 0, thumbSize: 0, tables: {} };
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

ipcMain.handle("get-index-of-item", async (event, { itemId }) => {
  try {
    if (!db) return null;

    // Use media_id for a stable, deterministic descending sort (newest first)
    const stmt = db.prepare(`
      SELECT COUNT(*) as idx
      FROM files
      WHERE media_id > ?
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
ipcMain.handle("embedding:get-status", () => {
  if (!embeddingService)
    return { modelReady: false, total: 0, done: 0, percentage: 0 };
  return embeddingService.getStatus();
});

/** Pause/resume from the renderer (optional — e.g. during active media browsing) */
ipcMain.handle("embedding:pause", () => {
  embeddingService?.pause();
  return { ok: true };
});
ipcMain.handle("embedding:resume", () => {
  embeddingService?.resume();
  return { ok: true };
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
  async (event, { filters = {}, sortOrder = "desc" } = {}) => {
    try {
      initDatabase();
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
      const { sql, params } = buildWhereClause(filters);
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
});
