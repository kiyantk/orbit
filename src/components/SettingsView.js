// SettingsView.jsx
import React, { useState, useEffect, useCallback } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faArrowDown,
  faArrowLeft,
  faArrowRight,
  faArrowUp,
  faHardDrive,
  faKeyboard,
  faPanorama,
  faPhotoFilm,
  faTableCells,
  faToolbox,
  faUser,
  faLocationDot,
  faMap,
  faChartSimple,
} from "@fortawesome/free-solid-svg-icons";
import FolderList from "./FolderList";
import HeicPopup from "./HeicPopup";
import Popup from "./Popup";
import ConfirmPopup from "./ConfirmPopup";

const TABS = [
  "User",
  "Media",
  "Explorer",
  "Map",
  "Stats",
  "Memories",
  "Places",
  "Storage",
  "Controls",
  "App",
];

const TAB_ICONS = {
  User: faUser,
  Media: faPhotoFilm,
  Explorer: faTableCells,
  Map: faMap,
  Stats: faChartSimple,
  Memories: faPanorama,
  Places: faLocationDot,
  Storage: faHardDrive,
  Controls: faKeyboard,
  App: faToolbox,
};

function formatBytes(bytes, decimals = 2) {
  if (!+bytes) return "0 Bytes";
  const k = 1024;
  const dm = Math.max(0, decimals);
  const sizes = [
    "Bytes",
    "KiB",
    "MiB",
    "GiB",
    "TiB",
    "PiB",
    "EiB",
    "ZiB",
    "YiB",
  ];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

function normalizePath(path) {
  if (!path) return "";
  let p = path.trim().replace(/[/\\]+$/, "");
  if (navigator.platform.startsWith("Win")) p = p.toLowerCase();
  return p;
}

export function resolvePathWithDriveMap(filePath, driveLetterMap) {
  if (!filePath || !driveLetterMap || Object.keys(driveLetterMap).length === 0)
    return filePath;
  for (const [originalFolder, customLetter] of Object.entries(driveLetterMap)) {
    const originalDrive = originalFolder
      .match(/^([A-Za-z]:)/)?.[1]
      ?.toUpperCase();
    if (!originalDrive || !customLetter) continue;
    const normalizedCustom = customLetter.replace(/:?$/, ":").toUpperCase();
    if (filePath.toUpperCase().startsWith(originalDrive)) {
      return normalizedCustom + filePath.slice(originalDrive.length);
    }
  }
  return filePath;
}

const ShortcutKey = ({ children }) => (
  <span className="settings-shortcut-key">{children}</span>
);

const SettingsRow = ({ children }) => (
  <div className="settings-content-item">{children}</div>
);

// ─── Backup Popup ─────────────────────────────────────────────────────────
const BackupPopup = ({
  preview,
  filename,
  onFilenameChange,
  onCreate,
  onClose,
  isCreating,
  status,
}) => (
  <Popup
    title="Create Backup"
    width={480}
    actions={[
      {
        label: "Close",
        kind: "secondary",
        onClick: onClose,
        disabled: isCreating,
      },
      {
        label: isCreating ? "Creating…" : "Create Backup",
        kind: "primary",
        onClick: onCreate,
        disabled: isCreating || !filename.trim(),
      },
    ]}
  >
    <SettingsRow>
      <span>Filename:</span>
      <input
        className="settings-content-input"
        type="text"
        value={filename}
        onChange={(e) => onFilenameChange(e.target.value)}
        disabled={isCreating}
      />
    </SettingsRow>
    <SettingsRow>
      <span>Uncompressed size:</span>
      <span>
        {preview ? `~${formatBytes(preview.totalSize)}` : "Calculating…"}
      </span>
    </SettingsRow>
    <span className="settings-hint">
      Backs up config.json and orbit-index.db. Thumbnails are not included. The
      actual zip may be smaller due to compression.
    </span>
    {status && (
      <div
        style={{
          marginTop: 10,
          color: status.type === "error" ? "#ff9a9a" : "#8ee6a0",
        }}
      >
        {status.message}
      </div>
    )}
  </Popup>
);

// ─── Smart Search Status Panel ────────────────────────────────────────────────
const SmartSearchStatus = () => {
  const [status, setStatus] = useState({
    modelReady: false,
    initError: null,
    total: 0,
    done: 0,
    percentage: 0,
    paused: false,
    pausePending: false,
  });
  const [loading, setLoading] = useState(true);
  const [isToggling, setIsToggling] = useState(false);

  const fetchStatus = useCallback(async () => {
    try {
      const s = await window.electron.ipcRenderer.invoke(
        "embedding:get-status",
      );
      if (s) setStatus(s);
      return s;
    } catch {
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  const togglePaused = useCallback(async () => {
    if (isToggling || status.pausePending) return;
    setIsToggling(true);
    try {
      await window.electron.ipcRenderer.invoke(
        status.paused ? "embedding:resume" : "embedding:pause",
      );
      const nextStatus = await fetchStatus();
      if (!nextStatus?.pausePending) setIsToggling(false);
    } catch {
      setIsToggling(false);
    }
  }, [isToggling, status.paused, status.pausePending, fetchStatus]);

  // Poll every 4 seconds
  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 4000);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  // Also listen for push updates from the background service
  useEffect(() => {
    const handler = (data) => {
      if (data) {
        setStatus(data);
        if (!data.pausePending) setIsToggling(false);
      }
      setLoading(false);
    };
    return window.electron.ipcRenderer.on("embedding-progress", handler);
  }, []);

  const isComplete = status.total > 0 && status.done >= status.total;
  const percentage =
    status.total > 0 ? Math.round((status.done / status.total) * 100) : 0;

  // ── Determine status label & colour ──
  let statusLabel;
  let statusColor;

  if (loading) {
    statusLabel = "Checking…";
    statusColor = "#888";
  } else if (status.initError) {
    statusLabel = "Error loading model";
    statusColor = "#ff9a9a";
  } else if (status.paused) {
    statusLabel = "Paused";
    statusColor = "#888";
  } else if (!status.modelReady) {
    statusLabel = "Loading CLIP model…";
    statusColor = "#ffd577";
  } else if (isComplete) {
    statusLabel = "Complete";
    statusColor = "#d8d8d8";
  } else if (status.total === 0) {
    statusLabel = "No images indexed yet";
    statusColor = "#888";
  } else {
    statusLabel = `Indexing in background… ${percentage}%`;
    statusColor = "#8f8f8f";
  }

  return (
    <div className="smart-search-status-panel">
      <div className="smart-search-status-header">
        <span className="smart-search-status-title">Smart Search</span>
        <span
          className="smart-search-status-badge"
          style={{ color: statusColor }}
        >
          {statusLabel}
        </span>
      </div>

      {/* Progress bar */}
      {status.total > 0 && (
        <>
          <div className="smart-search-status-bar-track">
            <div
              className="smart-search-status-bar-fill"
              style={{
                width: `${percentage}%`,
                backgroundColor: isComplete ? "#4caf82" : "#a78bfa",
              }}
            />
          </div>
        </>
      )}

      <div className="smart-search-status-counts-row">
        {status.total > 0 && (
          <div className="smart-search-status-counts">
            {status.done.toLocaleString()} / {status.total.toLocaleString()} images
          </div>
        )}
        <button
          className="smart-search-status-button"
          onClick={togglePaused}
          disabled={isToggling || status.pausePending}
        >
          {status.paused ? "Resume" : "Pause"}
        </button>
      </div>

      {/* Error detail */}
      {status.initError && (
        <div className="smart-search-status-error">{status.initError}</div>
      )}

    </div>
  );
};

// ─── Component ────────────────────────────────────────────────────────────────
const SettingsView = ({
  currentSettings,
  applySettings,
  folderStatuses,
  checkStatusses,
  newTab,
  enterRemoveMode,
}) => {
  const [selectedTab, setSelectedTab] = useState("User");
  const [settings, setSettings] = useState({
    driveLetterMap: {},
    ...currentSettings,
  });
  const [isIndexing, setIsIndexing] = useState(false);
  const [indexingStatus, setIndexingStatus] = useState(null);
  const [missingHeicFiles, setMissingHeicFiles] = useState([]);
  const [showHeicPopup, setShowHeicPopup] = useState(false);
  const [showToolsPopup, setShowToolsPopup] = useState(false);
  const [isFetchingUsage, setIsFetchingUsage] = useState(false);
  const [storageUsage, setStorageUsage] = useState(null);

  const [showBackupPopup, setShowBackupPopup] = useState(false);
  const [backupPreview, setBackupPreview] = useState(null);
  const [backupFilename, setBackupFilename] = useState("");
  const [isCreatingBackup, setIsCreatingBackup] = useState(false);
  const [backupStatus, setBackupStatus] = useState(null);

  const [confirmPopup, setConfirmPopup] = useState(null);

  const [locationStatus, setLocationStatus] = useState({
    total: 0,
    done: 0,
    percentage: 0,
    paused: false,
    pausePending: false,
  });
  const [isTogglingLocation, setIsTogglingLocation] = useState(false);

  const ipc = useCallback(
    (channel, ...args) => window.electron.ipcRenderer.invoke(channel, ...args),
    [],
  );

  const fetchLocationStatus = useCallback(async () => {
    try {
      const status = await ipc("location:get-status");
      if (status) setLocationStatus(status);
      return status;
    } catch {
      return null;
    }
  }, [ipc]);

  const toggleLocationPaused = useCallback(async () => {
    if (isTogglingLocation || locationStatus.pausePending) return;
    setIsTogglingLocation(true);
    try {
      await ipc(locationStatus.paused ? "location:resume" : "location:pause");
      const nextStatus = await fetchLocationStatus();
      if (!nextStatus?.pausePending) setIsTogglingLocation(false);
    } catch {
      setIsTogglingLocation(false);
    }
  }, [
    isTogglingLocation,
    locationStatus.paused,
    locationStatus.pausePending,
    ipc,
    fetchLocationStatus,
  ]);

  const saveSettings = useCallback(
    async (next) => {
      applySettings(next);
      try {
        const res = await ipc("save-settings", next);
        if (!res.success) console.error("Failed to save settings:", res.error);
      } catch (err) {
        console.error("Error saving settings:", err);
      }
    },
    [applySettings, ipc],
  );

  const updateSettings = useCallback((patch) => {
    setSettings((prev) => ({ ...prev, ...patch }));
  }, []);

  const handleCheckbox = (key) => (e) =>
    updateSettings({ [key]: e.target.checked });
  const handleSelect = (key) => (e) =>
    updateSettings({ [key]: e.target.value });

  const handleUsernameChange = (e) => {
    const v = e.target.value;
    if (
      v !== "" &&
      (v.length > 32 ||
        /\s{2,}/.test(v) ||
        !/^[a-zA-Z0-9 _-]+$/.test(v) ||
        /^\s|\s$/.test(v))
    )
      return;
    updateSettings({ username: v });
  };

  const handleSetDriveLetter = useCallback((folder, customLetter) => {
    setSettings((prev) => {
      const next = { ...(prev.driveLetterMap || {}) };
      if (customLetter === null || customLetter === undefined) {
        delete next[folder];
      } else {
        next[folder] = customLetter;
      }
      return { ...prev, driveLetterMap: next };
    });
  }, []);

  // ─── Effects ────────────────────────────────────────────────────────────────

  useEffect(() => {
    ipc("get-settings").then((loaded) => {
      if (loaded) setSettings({ driveLetterMap: {}, ...loaded });
    });
    new Image().src = `${process.env.PUBLIC_URL}/logo-v2-orbit-bright-white-shadow-small.png`;
  }, [ipc]);

  useEffect(() => {
    let interval;

    fetchLocationStatus();
    interval = setInterval(fetchLocationStatus, 4000);

    // optional: live updates if you later emit events
    const handler = (data) => {
      if (data) {
        setLocationStatus(data);
        if (!data.pausePending) setIsTogglingLocation(false);
      }
    };

    const unsubscribe = window.electron.ipcRenderer.on("location-progress", handler);

    return () => {
      clearInterval(interval);
      unsubscribe?.();
    };
  }, [fetchLocationStatus]);

  useEffect(() => {
    if (newTab) setSelectedTab(newTab);
  }, [newTab]);

  useEffect(() => {
    saveSettings(settings);
  }, [settings]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    ipc("fetch-heic-missing-thumbnails").then((res) => {
      if (res.success) setMissingHeicFiles(res.files);
    });
  }, [settings.indexedFolders, ipc]);

  useEffect(() => {
    const handleProgress = (data) => {
      if (data && typeof data === "object") {
        const { filename, processed, total, percentage } = data;
        setIndexingStatus(
          total > 0
            ? `Indexing: ${processed}/${total} files (${percentage}%)`
            : filename
              ? `Indexing: ${filename}`
              : "Indexing files...",
        );
      } else {
        setIndexingStatus(data ? `Indexing: ${data}` : "Indexing files...");
      }
    };
    return window.electron.ipcRenderer.on("indexing-progress", handleProgress);
  }, []);

  // ─── Folder actions ──────────────────────────────────────────────────────────

  const startIndex = async (folders) => {
    if (!folders.length) {
      setIndexingStatus("Please select at least one folder to index");
      return;
    }
    setIsIndexing(true);
    setShowToolsPopup(false);
    try {
      const result = await ipc("index-files", folders);
      setIndexingStatus(result.success ? null : `Error: ${result.error}`);
    } catch (err) {
      console.error("Error indexing files:", err);
      setIndexingStatus("Error occurred during indexing");
    }
    setIsIndexing(false);
  };

  const selectFolders = async () => {
    try {
      const folders = await ipc("select-folders");
      if (!folders.length) return;
      setSettings((prev) => {
        const existing = prev.indexedFolders.map(normalizePath);
        const unique = folders.filter(
          (f) => !existing.includes(normalizePath(f)),
        );
        startIndex(folders);
        return { ...prev, indexedFolders: [...prev.indexedFolders, ...unique] };
      });
    } catch (err) {
      console.error("Error selecting folders:", err);
    }
  };

  const doRemoveFolder = async (folderPath) => {
    setSettings((prev) => {
      const nextMap = { ...(prev.driveLetterMap || {}) };
      delete nextMap[folderPath];
      return {
        ...prev,
        indexedFolders: prev.indexedFolders.filter((f) => f !== folderPath),
        driveLetterMap: nextMap,
      };
    });
    try {
      const res = await ipc("remove-folder-data", folderPath);
      if (!res.success)
        console.error("Failed to remove folder data:", res.error);
    } catch (err) {
      console.error("Error removing folder:", err);
    }
  };

  const removeFolder = (folderPath) => {
    setConfirmPopup({
      message: `Remove this source?`,
      subMessage: folderPath,
      onConfirm: () => {
        setConfirmPopup(null);
        doRemoveFolder(folderPath);
      },
    });
  };

  const doRemoveAll = async () => {
    for (const folder of settings.indexedFolders) {
      try {
        const res = await ipc("remove-folder-data", folder);
        if (!res.success)
          console.error("Failed to remove folder data:", res.error);
      } catch (err) {
        console.error("Error removing folder:", err);
      }
    }
    updateSettings({ indexedFolders: [], driveLetterMap: {} });
  };

  const handleRemoveAll = () => {
    setConfirmPopup({
      message: "Remove ALL indexed sources?",
      subMessage:
        "This will delete all index data and thumbnails. This cannot be undone.",
      onConfirm: () => {
        setConfirmPopup(null);
        doRemoveAll();
      },
    });
  };

  // ─── Tool actions ────────────────────────────────────────────────────────────

  const runTool = useCallback(
    async (channel, label, after) => {
      setIndexingStatus(`${label}...`);
      setIsIndexing(true);
      setShowToolsPopup(false);

      try {
        const result = await ipc(channel);

        setIndexingStatus(
          result.success ? result.message : `Error: ${result.error}`,
        );

        if (result.success && after) {
          await after(result);
        }

        if (result.success) {
          setTimeout(() => setIndexingStatus(null), 5000);
        }
      } catch (err) {
        setIndexingStatus(`Error: ${err.message}`);
      }

      setIsIndexing(false);
    },
    [ipc],
  );

  const fixThumbnails = () =>
    runTool("fix-thumbnails", "Fixing thumbnails", async () => {
      await runTool(
        "generate-derived-thumbnails",
        "Generating 64px thumbnails",
      );
    });
  const fixIDs = () => runTool("fix-media-ids", "Fixing media IDs");
  const detectScreenshots = () =>
    runTool("detect-screenshots", "Re-detecting capture types");
  const cleanupThumbnails = () =>
    runTool("cleanup-thumbnails", "Scanning for orphaned thumbnails");

  const getUsageData = async () => {
    setIsFetchingUsage(true);
    try {
      const data = await ipc("get-storage-usage");
      if (data) setStorageUsage(data);
    } finally {
      setIsFetchingUsage(false);
    }
  };

  const openBackupPopup = async () => {
    setShowBackupPopup(true);
    setBackupStatus(null);
    setBackupPreview(null);
    try {
      const preview = await ipc("get-backup-preview");
      if (preview.success) {
        setBackupPreview(preview);
        setBackupFilename(preview.defaultFilename);
      } else {
        setBackupStatus({ type: "error", message: preview.error });
      }
    } catch (err) {
      console.error("Error fetching backup preview:", err);
      setBackupStatus({ type: "error", message: err.message });
    }
  };

  const handleCreateBackup = async () => {
    setIsCreatingBackup(true);
    setBackupStatus(null);
    try {
      const result = await ipc("create-backup", backupFilename);
      if (result.canceled) {
        // user dismissed the save dialog — leave popup open, no message
      } else if (result.success) {
        setBackupStatus({
          type: "success",
          message: `Backup saved to ${result.filePath}`,
        });
      } else {
        setBackupStatus({
          type: "error",
          message: result.error || "Failed to create backup",
        });
      }
    } catch (err) {
      setBackupStatus({ type: "error", message: err.message });
    }
    setIsCreatingBackup(false);
  };

  const openAppLocation = () => ipc("open-orbit-location");
  const openDataLocation = () => ipc("open-data-location");
  const toggleFullscreen = () => ipc("toggle-fullscreen");

  // ─── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="settings-view">
      <div className="settings-main">
        <div className="settings-list">
          <h2>Settings</h2>
          <ul>
            {TABS.map((tab) => (
              <li
                key={tab}
                className={`settings-list-item ${selectedTab === tab ? "settings-list-active" : ""}`}
                onClick={() => setSelectedTab(tab)}
              >
                <FontAwesomeIcon icon={TAB_ICONS[tab]} />
                <span>{tab}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="settings-content">
          {selectedTab === "User" && (
            <div>
              <SettingsRow>
                <span>Username:</span>
                <input
                  className="settings-content-input"
                  type="text"
                  value={settings.username}
                  onChange={handleUsernameChange}
                />
              </SettingsRow>
              <SettingsRow>
                <span>Birthdate:</span>
                <input
                  className="settings-content-input"
                  type="date"
                  style={{ colorScheme: "dark" }}
                  value={settings.birthDate}
                  onChange={handleSelect("birthDate")}
                />
              </SettingsRow>
            </div>
          )}

          {selectedTab === "Explorer" && (
            <div>
              <SettingsRow>
                <div className="slider-wrapper">
                  <label className="switch">
                    <input
                      type="checkbox"
                      checked={settings.adjustHeicColors ?? true}
                      onChange={handleCheckbox("adjustHeicColors")}
                    />
                    <div className="slider round"></div>
                  </label>
                </div>
                <span>Adjust HEIC colors</span>
                <span className="settings-hint">
                  Recommended. Improves color accuracy for HEIC photos.
                </span>
              </SettingsRow>
              <SettingsRow>
                <div className="slider-wrapper">
                  <label className="switch">
                    <input
                      type="checkbox"
                      checked={!!settings.hideScreenshotsAndScreenRecordings}
                      onChange={handleCheckbox(
                        "hideScreenshotsAndScreenRecordings",
                      )}
                    />
                    <div className="slider round"></div>
                  </label>
                </div>
                <span>Hide screenshots and screen recordings</span>
                <span className="settings-hint">
                  Experimental. Detection is not always accurate, so this may
                  hide some photos or videos that are not screen captures.
                </span>
              </SettingsRow>
              <SettingsRow>
                <div className="slider-wrapper">
                  <label className="switch">
                    <input
                      type="checkbox"
                      checked={!!settings.preloadHeic}
                      onChange={handleCheckbox("preloadHeic")}
                    />
                    <div className="slider round"></div>
                  </label>
                </div>
                <span>Preload HEIC on hover</span>
                <span className="settings-hint">
                  Experimental. Can significantly reduce loading times for HEIC
                  files by decoding them in the background while hovering.
                </span>
              </SettingsRow>
              <SettingsRow>
                <div className="slider-wrapper">
                  <label className="switch">
                    <input
                      type="checkbox"
                      checked={settings.showThumbnailWhileFullImageLoads ?? false}
                      onChange={handleCheckbox(
                        "showThumbnailWhileFullImageLoads",
                      )}
                    />
                    <div className="slider round"></div>
                  </label>
                </div>
                <span>Show thumbnail while full image loads</span>
              </SettingsRow>
              <SettingsRow>
                <span>Unavailable behaviour:</span>
                <select
                  value={settings.unavailableBehaviour ?? "overlay"}
                  onChange={handleSelect("unavailableBehaviour")}
                  className="settings-itemstyle-select"
                >
                  <option value="overlay">
                    Show overlay &amp; don't load (default)
                  </option>
                  <option value="thumbnail">Use thumbnail</option>
                </select>
              </SettingsRow>
              <SettingsRow>
                <span>Default sort:</span>
                <select
                  value={settings.defaultSort ?? "media_id"}
                  onChange={handleSelect("defaultSort")}
                  className="settings-itemstyle-select"
                >
                  <option value="media_id">ID (default)</option>
                  <option value="name">Name</option>
                  <option value="create_date">Date Taken</option>
                  <option value="created">Date Created</option>
                  <option value="size">File Size</option>
                  <option value="random">Random</option>
                </select>
              </SettingsRow>
              {/* <SettingsRow>
                <span>Explorer layout:</span>
                <select
                  value={settings.explorerLayout}
                  onChange={(e) => {
                    const val = e.target.value;
                    updateSettings({ explorerLayout: val, ...(val !== "grid" ? { noGutters: false } : {}) });
                  }}
                  className="settings-itemstyle-select"
                >
                  <option value="grid">Grid (default)</option>
                  <option value="justified">Justified (collage)</option>
                </select>
              </SettingsRow> */}
              <SettingsRow>
                <span
                  style={
                    settings.explorerLayout !== "grid" ? { opacity: 0.4 } : {}
                  }
                >
                  Item text:
                </span>
                <select
                  value={settings.itemText ?? "filename"}
                  onChange={handleSelect("itemText")}
                  className="settings-itemstyle-select"
                  disabled={settings.explorerLayout !== "grid"}
                  style={
                    settings.explorerLayout !== "grid"
                      ? { opacity: 0.4, cursor: "not-allowed" }
                      : {}
                  }
                >
                  <option value="filename">Filename (default)</option>
                  <option value="datetime">Date</option>
                  <option value="none">None</option>
                </select>
              </SettingsRow>
              <SettingsRow>
                <div className="slider-wrapper">
                  <label className="switch">
                    <input
                      type="checkbox"
                      checked={!!settings.noGutters}
                      onChange={handleCheckbox("noGutters")}
                      disabled={settings.explorerLayout !== "grid"}
                    />
                    <div className="slider round"></div>
                  </label>
                </div>
                <span
                  style={
                    settings.explorerLayout !== "grid" ? { opacity: 0.4 } : {}
                  }
                >
                  No gutters
                </span>
              </SettingsRow>
              <SettingsRow>
                <div className="slider-wrapper">
                  <label className="switch">
                    <input
                      type="checkbox"
                      checked={settings.explorerDateScroll ?? true}
                      onChange={handleCheckbox("explorerDateScroll")}
                    />
                    <div className="slider round"></div>
                  </label>
                </div>
                <span>Show timeline overlay</span>
              </SettingsRow>
              <SettingsRow>
                <span>Preset filter:</span>
                <select
                  value={settings.mediaFilter ?? "none"}
                  onChange={handleSelect("mediaFilter")}
                  className="settings-itemstyle-select"
                >
                  <option value="none">None (default)</option>
                  <option value="extra_contrast">Extra Contrast</option>
                  <option value="extra_bright">Extra Bright</option>
                  <option value="extra_contrast_extra_bright">
                    Extra Contrast + Extra Bright
                  </option>
                  <option value="extra_saturation">Extra Saturation</option>
                  <option value="inverted">Inverted</option>
                  <option value="inverted_pro">Inverted Pro</option>
                  <option value="inverted_pro_bright">
                    Inverted Pro Bright
                  </option>
                  <option value="inverted_extra_contrast">
                    Inverted + Extra Contrast
                  </option>
                  <option value="inverted_extra_bright">
                    Inverted + Extra Bright
                  </option>
                  <option value="inverted_extra_contrast_extra_bright">
                    Inverted + Extra Contrast + Extra Bright
                  </option>
                  <option value="grayscale">Grayscale</option>
                  <option value="grayscale_extra_contrast">
                    Grayscale + Extra Contrast
                  </option>
                  <option value="grayscale_extra_bright">
                    Grayscale + Extra Bright
                  </option>
                </select>
              </SettingsRow>
            </div>
          )}

          {selectedTab === "Map" && (
            <div>
              <SettingsRow>
                <span>Map style:</span>
                <select
                  value={settings.mapStyle ?? "default"}
                  onChange={handleSelect("mapStyle")}
                  className="settings-itemstyle-select"
                >
                  <option value="default">Default</option>
                  <option value="dark">Dark</option>
                  <option value="grayscale">Grayscale</option>
                </select>
              </SettingsRow>
            </div>
          )}

          {selectedTab === "Stats" && (
            <div>
              <SettingsRow>
                <span>Table style:</span>
                <select
                  value={settings.tableStyle ?? "comfortable"}
                  onChange={handleSelect("tableStyle")}
                  className="settings-itemstyle-select"
                >
                  <option value="dense">Dense</option>
                  <option value="compact">Compact</option>
                  <option value="comfortable">Comfortable (default)</option>
                  <option value="tall">Tall</option>
                </select>
              </SettingsRow>
              <SettingsRow>
                <div className="slider-wrapper">
                  <label className="switch">
                    <input
                      type="checkbox"
                      checked={!!settings.excludeScreenCapturesFromMilestones}
                      onChange={handleCheckbox("excludeScreenCapturesFromMilestones")}
                    />
                    <div className="slider round"></div>
                  </label>
                </div>
                <span>Exclude screenshots & screen recordings from Milestones</span>
              </SettingsRow>
            </div>
          )}

          {selectedTab === "Memories" && (
            <div>
              <SettingsRow>
                <span>Open memories in:</span>
                <select
                  value={settings.openMemoriesIn ?? "explorer"}
                  onChange={handleSelect("openMemoriesIn")}
                  className="settings-itemstyle-select"
                >
                  <option value="explorer">Explorer (default)</option>
                  <option value="shuffle">Shuffle</option>
                  <option value="map">Map</option>
                </select>
              </SettingsRow>
              <SettingsRow>
                <span>Memories layout:</span>
                <select
                  value={settings.memoriesLayout ?? "list"}
                  onChange={handleSelect("memoriesLayout")}
                  className="settings-itemstyle-select"
                >
                  <option value="list">List (default)</option>
                  <option value="grid">Grid</option>
                </select>
              </SettingsRow>
            </div>
          )}

          {selectedTab === "Places" && (
            <div>
              <SettingsRow>
                <span>Sort places by:</span>
                <select
                  value={settings.placesSortBy ?? "count"}
                  onChange={handleSelect("placesSortBy")}
                  className="settings-itemstyle-select"
                >
                  <option value="count">Item count (default)</option>
                  <option value="last_visit">Last visit</option>
                  <option value="population">Population</option>
                  <option value="alphabetical">Alphabetical</option>
                </select>
              </SettingsRow>

              <SettingsRow>
                <span>Thumbnails:</span>
                <select
                  value={settings.placesThumbnails ?? "random"}
                  onChange={handleSelect("placesThumbnails")}
                  className="settings-itemstyle-select"
                >
                  <option value="random">Random (default)</option>
                  <option value="last_visit">Last visit</option>
                </select>
              </SettingsRow>

              <SettingsRow>
                <span>Subtitles:</span>
                <select
                  value={settings.placesSubtitles ?? "count"}
                  onChange={handleSelect("placesSubtitles")}
                  className="settings-itemstyle-select"
                >
                  <option value="count">Item count (default)</option>
                  <option value="last_visit">Last visit</option>
                </select>
              </SettingsRow>

              <SettingsRow>
                <span>Minimum item count:</span>
                <input
                  type="number"
                  min={1}
                  value={settings.placesMinCount ?? 1}
                  onChange={(e) =>
                    updateSettings({
                      placesMinCount: Math.max(1, Number(e.target.value) || 1),
                    })
                  }
                  className="settings-content-input"
                  style={{ width: 100 }}
                />
              </SettingsRow>

              <SettingsRow>
                <div className="slider-wrapper">
                  <label className="switch">
                    <input
                      type="checkbox"
                      checked={!!settings.placesExcludeFlights}
                      onChange={handleCheckbox("placesExcludeFlights")}
                    />
                    <div className="slider round"></div>
                  </label>
                </div>

                <span>Exclude flights</span>
                <span className="settings-hint">
                  Hides items with altitude higher than 9000 meters.
                </span>
              </SettingsRow>
            </div>
          )}

          {selectedTab === "Media" && (
            <div>
              <h3>Indexed sources</h3>
              <FolderList
                folders={settings.indexedFolders}
                onRemoveFolder={removeFolder}
                folderStatuses={folderStatuses}
                driveLetterMap={settings.driveLetterMap || {}}
                onSetDriveLetter={handleSetDriveLetter}
              />
              <div className="settings-media-buttons">
                <button
                  className="welcome-popup-select-folders-btn"
                  onClick={selectFolders}
                  disabled={isIndexing}
                >
                  Add Source
                </button>
                <button
                  className="welcome-popup-select-folders-btn"
                  onClick={handleRemoveAll}
                  disabled={
                    isIndexing || (settings && !settings.indexedFolders.length)
                  }
                >
                  Remove All
                </button>
                <button
                  className="welcome-popup-select-folders-btn"
                  onClick={() => setShowToolsPopup(true)}
                  disabled={
                    isIndexing || (settings && !settings.indexedFolders.length)
                  }
                >
                  Tools
                </button>
              </div>
              {indexingStatus && (
                <div className="welcome-popup-status">
                  <span>{indexingStatus}</span>
                  <br />
                  <span>Don't close the app</span>
                </div>
              )}
              <h3 style={{ marginTop: 18 }}>Smart search</h3>
              {/* ── Smart Search Status ── */}
              <div style={{ marginTop: 10 }}>
                <SmartSearchStatus />
              </div>
              <h3 style={{ marginTop: 18 }}>Location indexing</h3>

              <div
                className="smart-search-status-panel"
                style={{ marginTop: 10 }}
              >
                <div className="smart-search-status-header">
                  <span className="smart-search-status-title">Locations</span>

                  <span
                    className="smart-search-status-badge"
                    style={{ color: "#8f8f8f" }}
                  >
                    {locationStatus.paused
                      ? "Paused"
                      : locationStatus.total === 0
                        ? "Idle"
                        : `${Math.round((locationStatus.done / locationStatus.total) * 100)}%`}
                  </span>
                </div>

                {locationStatus.total > 0 && (
                  <>
                    <div className="smart-search-status-bar-track">
                      <div
                        className="smart-search-status-bar-fill"
                        style={{
                          width: `${(locationStatus.done / locationStatus.total) * 100}%`,
                          backgroundColor: "#a78bfa",
                        }}
                      />
                    </div>

                  </>
                )}
                <div className="smart-search-status-counts-row">
                  {locationStatus.total > 0 && (
                    <div className="smart-search-status-counts">
                      {locationStatus.done.toLocaleString()} /{" "}
                      {locationStatus.total.toLocaleString()} locations
                    </div>
                  )}
                  <button
                    className="smart-search-status-button"
                    onClick={toggleLocationPaused}
                    disabled={isTogglingLocation || locationStatus.pausePending}
                  >
                    {locationStatus.paused ? "Resume" : "Pause"}
                  </button>
                </div>
              </div>
            </div>
          )}

          {selectedTab === "Storage" && (
            <div>
              <SettingsRow>
                <button
                  className="settings-normal-button"
                  onClick={openAppLocation}
                >
                  Open app folder
                </button>
              </SettingsRow>
              <SettingsRow>
                <button
                  className="settings-normal-button"
                  onClick={openDataLocation}
                >
                  Open data folder
                </button>
              </SettingsRow>
              <SettingsRow>
                <button
                  className="settings-normal-button"
                  onClick={openBackupPopup}
                >
                  Create Backup
                </button>
              </SettingsRow>
              <SettingsRow>
                <span>Storage usage:</span>
                <button
                  className="settings-normal-button"
                  onClick={getUsageData}
                  disabled={isFetchingUsage}
                  style={
                    isFetchingUsage
                      ? { opacity: 0.5, cursor: "not-allowed" }
                      : {}
                  }
                >
                  {isFetchingUsage ? "Loading..." : "Fetch"}
                </button>
              </SettingsRow>

              {storageUsage &&
                (() => {
                  const {
                    appStorageUsed,
                    dbSize,
                    thumbSize,
                    tables = {},
                  } = storageUsage;

                  const tableDefs = [
                    { key: "files", label: "File Index", color: "#a78bfa" },
                    {
                      key: "embeddings",
                      label: "Smart Search",
                      color: "#60a5fa",
                    },
                    { key: "memories", label: "Memories", color: "#f472b6" },
                    { key: "tags", label: "Tags", color: "#34d399" },
                    {
                      key: "removed_files",
                      label: "Removed",
                      color: "#fb523c",
                    },
                  ];

                  const dbOtherBytes = Math.max(
                    0,
                    dbSize -
                      tableDefs.reduce(
                        (s, d) => s + (tables[d.key]?.bytes ?? 0),
                        0,
                      ),
                  );

                  // Bar excludes App Total (which is just dbSize + thumbSize, not additive)
                  const segments = [
                    ...tableDefs.map((d) => ({
                      label: d.label,
                      color: d.color,
                      bytes: tables[d.key]?.bytes ?? 0,
                    })),
                    {
                      label: "DB overhead",
                      color: "#afafaf",
                      bytes: dbOtherBytes,
                    },
                    { label: "Thumbnails", color: "#fbbf24", bytes: thumbSize },
                  ].filter((s) => s.bytes > 0);

                  const total = dbSize + thumbSize || 1;

                  const topItems = [
                    {
                      color: "#7e30fa",
                      label: "App Total",
                      val: appStorageUsed,
                    },
                  ];

                  const midItems = [
                    { color: "#afafaf", label: "Database", val: dbSize },
                    { color: "#fbbf24", label: "Thumbnails", val: thumbSize }, // matches bar segment color
                  ];

                  const tableItems = tableDefs.map((d) => ({
                    color: d.color,
                    label: d.label,
                    val: tables[d.key]?.bytes ?? 0,
                    rows: tables[d.key]?.rows ?? 0,
                  }));

                  const dot = (color) => (
                    <div
                      style={{
                        width: 10,
                        height: 10,
                        borderRadius: "50%",
                        backgroundColor: color,
                        flexShrink: 0,
                      }}
                    />
                  );

                  return (
                    <>
                      {/* Distribution bar — db segments + thumbnails, no "App Total" wrapper */}
                      <div
                        style={{
                          display: "flex",
                          height: 10,
                          borderRadius: 6,
                          overflow: "hidden",
                          marginTop: 12,
                          width: "40%",
                          gap: 2,
                        }}
                      >
                        {segments.map((s, i) => (
                          <div
                            key={i}
                            title={`${s.label}: ${formatBytes(s.bytes)}`}
                            style={{
                              width: `${(s.bytes / total) * 100}%`,
                              backgroundColor: s.color,
                              minWidth: s.bytes > 0 ? 3 : 0,
                              transition: "width 0.3s ease",
                            }}
                          />
                        ))}
                      </div>
                      {/* Legend */}
                      <div
                        className="storage-bar-container"
                        style={{ marginTop: 12 }}
                      >
                        <div className="storage-legend">
                          {/* App Total */}
                          {topItems.map(({ color, label, val }) => (
                            <span key={label} className="storage-legend-text">
                              {dot(color)}
                              {label}: {val > 0 ? formatBytes(val) : "0 Bytes"}
                            </span>
                          ))}

                          <div
                            style={{
                              width: "100%",
                              height: 1,
                              backgroundColor: "#2d2a35",
                              margin: "6px 0",
                            }}
                          />

                          {/* Database + Thumbnails */}
                          {midItems.map(({ color, label, val }) => (
                            <span key={label} className="storage-legend-text">
                              {dot(color)}
                              {label}: {val > 0 ? formatBytes(val) : "0 Bytes"}
                            </span>
                          ))}

                          <div
                            style={{
                              width: "100%",
                              height: 1,
                              backgroundColor: "#2d2a35",
                              margin: "6px 0",
                            }}
                          />

                          {/* Per-table breakdown */}
                          {tableItems.map(({ color, label, val, rows }) => (
                            <span key={label} className="storage-legend-text">
                              {dot(color)}
                              {label}: {val > 0 ? formatBytes(val) : "0 Bytes"}
                              <span style={{ color: "#666", marginLeft: 4 }}>
                                ({rows.toLocaleString()})
                              </span>
                            </span>
                          ))}
                        </div>
                      </div>
                    </>
                  );
                })()}
            </div>
          )}

          {selectedTab === "Controls" && (
            <div>
              <h3>General</h3>
              <SettingsRow>
                <span>Quick minimize:</span>
                <ShortcutKey>~</ShortcutKey> <span>or</span>{" "}
                <ShortcutKey>`</ShortcutKey>
              </SettingsRow>
              <br />
              <h3>Explorer</h3>
              {[
                {
                  label: "Show preview:",
                  keys: [
                    <ShortcutKey key="lmb">Left Mouse Button</ShortcutKey>,
                  ],
                },
                {
                  label: "Open fullscreen:",
                  keys: [
                    <ShortcutKey key="dlmb">
                      Double Left Mouse Button
                    </ShortcutKey>,
                  ],
                },
                {
                  label: "Open in default viewer:",
                  keys: [
                    <ShortcutKey key="ctrl">CTRL</ShortcutKey>,
                    <span>+</span>,
                    <ShortcutKey key="lmb2">Left Mouse Button</ShortcutKey>,
                  ],
                },
                {
                  label: "Navigate:",
                  keys: [
                    <ShortcutKey key="scroll">SCROLL</ShortcutKey>,
                    <span>or</span>,
                    <ShortcutKey key="arrows">
                      <FontAwesomeIcon icon={faArrowLeft} />{" "}
                      <FontAwesomeIcon icon={faArrowUp} />{" "}
                      <FontAwesomeIcon icon={faArrowDown} />{" "}
                      <FontAwesomeIcon icon={faArrowRight} />
                    </ShortcutKey>,
                  ],
                },
                {
                  label: "Scale grid:",
                  keys: [
                    <ShortcutKey key="ctrl">CTRL</ShortcutKey>,
                    <span>+</span>,
                    <ShortcutKey key="scroll">SCROLL</ShortcutKey>,
                  ],
                },
                {
                  label: "Assign last used tag to selected item:",
                  keys: [<ShortcutKey key="t">T</ShortcutKey>],
                },
              ].map(({ label, keys }) => (
                <SettingsRow key={label}>
                  <span>{label}</span> {keys}
                </SettingsRow>
              ))}
            </div>
          )}

          {selectedTab === "App" && (
            <div>
              <SettingsRow>
                <img
                  width="44"
                  src={`${process.env.PUBLIC_URL}/logo-v2-orbit-bright-white-shadow-small.png`}
                  alt="Orbit logo"
                />
                <span>Orbit 1.2.0</span>
              </SettingsRow>
              <SettingsRow>
                <button
                  className="settings-normal-button"
                  onClick={toggleFullscreen}
                >
                  Toggle Fullscreen
                </button>
              </SettingsRow>
            </div>
          )}
        </div>
      </div>

      {/* ── Popups ── */}
      {showHeicPopup && (
        <HeicPopup
          missingFiles={missingHeicFiles}
          onClose={() => setShowHeicPopup(false)}
        />
      )}
      {showToolsPopup && (
        <Popup
          title="Tools"
          contentWidth="90%"
          actions={[
            {
              label: "Close",
              kind: "secondary",
              onClick: () => setShowToolsPopup(false),
            },
          ]}
        >
          <p style={{ marginBottom: 10 }}>Select which tool to run:</p>
          <div className="tools-popup-content">
            {[
              {
                label: "Index New Files",
                action: () => {
                  setShowToolsPopup(false);
                  startIndex(settings.indexedFolders);
                },
              },
              {
                label: "Check Status",
                action: () => {
                  setShowToolsPopup(false);
                  checkStatusses();
                },
              },
              {
                label: "Verify IDs",
                action: () => {
                  setShowToolsPopup(false);
                  fixIDs();
                },
              },
              {
                label: "Verify Thumbnails",
                action: () => {
                  setShowToolsPopup(false);
                  fixThumbnails();
                },
              },
              {
                label: "Re-detect capture types",
                action: () => {
                  setShowToolsPopup(false);
                  detectScreenshots();
                },
              },
              {
                label: "Cleanup Thumbnails",
                action: () => {
                  setShowToolsPopup(false);
                  cleanupThumbnails();
                },
              },
              {
                label: "Generate HEIC Thumbnails",
                action: () => {
                  setShowToolsPopup(false);
                  setShowHeicPopup(true);
                },
              },
              {
                label: "Remove Mode",
                action: () => {
                  setShowToolsPopup(false);
                  enterRemoveMode();
                },
              },
            ].map(({ label, action }) => (
              <button
                key={label}
                className="welcome-popup-select-folders-btn"
                onClick={action}
              >
                {label}
              </button>
            ))}
          </div>
        </Popup>
      )}

      {confirmPopup && (
        <ConfirmPopup
          message={confirmPopup.message}
          subMessage={confirmPopup.subMessage}
          onConfirm={confirmPopup.onConfirm}
          onCancel={() => setConfirmPopup(null)}
        />
      )}

      {showBackupPopup && (
        <BackupPopup
          preview={backupPreview}
          filename={backupFilename}
          onFilenameChange={setBackupFilename}
          onCreate={handleCreateBackup}
          onClose={() => setShowBackupPopup(false)}
          isCreating={isCreatingBackup}
          status={backupStatus}
        />
      )}
    </div>
  );
};

export default SettingsView;
