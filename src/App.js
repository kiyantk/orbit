import React, { useState, useEffect, useLayoutEffect, useCallback } from "react";
import MenuBar from "./components/MenuBar";
import BottomBar from "./components/BottomBar";
import SideBar from "./components/SideBar";
import WelcomePopup from "./components/WelcomePopup";
import SettingsView from "./components/SettingsView";
import "./App.css";
import ExplorerView from "./components/ExplorerView";
import PreviewPanel from "./components/PreviewPanel";
import ActionPanel from "./components/ActionPanel";
import StatsView from "./components/StatsView";
import MapView from "./components/MapView";
import TagsView from "./components/TagsView";
import ShuffleView from "./components/ShuffleView";
import MemoriesView from "./components/MemoriesView";
import PlacesView from "./components/PlacesView";
import PeopleView from "./components/PeopleView";

function hasActiveExplorerConstraint(activeFilters) {
  return Object.entries(activeFilters || {}).some(([key, value]) => {
    if (key === "searchBy" || key === "sortBy" || key === "sortOrder") {
      return false;
    }

    if (key === "searchTerm") {
      return Boolean(String(value || "").trim());
    }

    if (Array.isArray(value)) return value.length > 0;
    return value !== null && value !== undefined && value !== "" && value !== false;
  });
}

const THEME_NAMES = new Set(["cosmic", "midnight", "glacier"]);

function getThemeName(theme) {
  return THEME_NAMES.has(theme) ? theme : "cosmic";
}

const App = () => {
  const [settings, setSettings] = useState(null);
  const [showWelcomePopup, setShowWelcomePopup] = useState(false);
  const [activeView, setActiveView] = useState(null);
  const [folderStatuses, setFolderStatuses] = useState({}); // { "C:/path": true/false }
  const [selectedSettingsTab, setSelectedSettingsTab] = useState(null);
  const [selectedItem, setSelectedItem] = useState(null);
  const [selectedItemAvailable, setSelectedItemAvailable] = useState(true);
  const [isMuted, setIsMuted] = useState(true); // session-wide mute state
  const [forceFullscreen, setForceFullscreen] = useState(false);
  const [explorerScale, setExplorerScale] = useState(1);
  const [actionPanelType, setActionPanelType] = useState(null);
  const [filters, setFilters] = useState(null);
  const [filteredCount, setFilteredCount] = useState(null);
  const [viewCount, setViewCount] = useState(null);
  const [shuffleFilters, setShuffleFilters] = useState({});
  const [mapFilters, setMapFilters] = useState({});
  const [shuffleSettings, setShuffleSettings] = useState({
    shuffleInterval: 8,
    hideInfo: false,
    smoothTransition: false,
    chronological: false,
    ambientMode: false,
  });
  const [explorerScroll, setExplorerScroll] = useState(0);
  const [previewPanelKey, setPreviewPanelKey] = useState(0);
  const [actionPanelKey, setActionPanelKey] = useState(0);
  const [mapViewType, setMapViewType] = useState("cluster");
  const [memoryMode, setMemoryMode] = useState(null);
  const [showTagPopup, setShowTagPopup] = useState({ value: false, type: "" });
  const [explorerMode, setExplorerMode] = useState({
    enabled: false,
    value: null,
    type: "",
    existing: null,
  });
  const [explorerLoading, setExplorerLoading] = useState(false);
  const [itemToReveal, setItemToReveal] = useState(null);
  const [activeExplorerPersonId, setActiveExplorerPersonId] = useState(null);
  const ambientModeActive =
    activeView === "shuffle" && shuffleSettings.ambientMode;

  const handleActionPanelApply = (data) => {
    if (
      actionPanelType === "filter" ||
      actionPanelType === "sort" ||
      actionPanelType === "search" ||
      data._similarTo
    ) {
      const isEmptySearch =
        actionPanelType === "search" &&
        !String(data.searchTerm || "").trim();

      // Changing between search types with no query should leave the already
      // complete grid untouched. An empty query still clears an active search
      // or filter result set.
      if (isEmptySearch && !hasActiveExplorerConstraint(filters)) return;

      if (data.searchBy === "smart") {
        if (data.smartIds?.length > 0) {
          setFilters({
            ids: data.smartIds,
            _smartSearch: true,
            _smartScores: data.smartScores || {},
            searchBy: "smart",
            searchTerm: data.searchTerm,
          });
        } else if (data.searchTerm) {
          // Search ran but returned zero results — pass an empty ids array so
          // Explorer shows "No results" instead of keeping the previous view.
          setFilters({
            ids: [-1],
            _smartSearch: true,
            _smartScores: {},
            searchBy: "smart",
            searchTerm: data.searchTerm,
          });
        } else {
          setFilters({});
        }
        return;
      }
      if (data.searchBy === "text") {
        if (data.textIds?.length > 0) {
          setFilters({
            ids: data.textIds,
            _textSearch: true,
            _textMatches: data.textMatches || {},
            searchBy: "text",
            searchTerm: data.searchTerm,
          });
        } else if (data.searchTerm) {
          setFilters({
            ids: [-1],
            _textSearch: true,
            _textMatches: {},
            searchBy: "text",
            searchTerm: data.searchTerm,
          });
        } else {
          setFilters({});
        }
        return;
      }
      setExplorerScroll(0);
      if (actionPanelType === "filter" && !hasActiveExplorerConstraint(data)) {
        setActiveExplorerPersonId(null);
      }
      setFilters(data);
    } else if (actionPanelType === "shuffle-filter") {
      setShuffleFilters(data);
    } else if (actionPanelType === "shuffle-settings") {
      setShuffleSettings((prev) => ({ ...prev, ...data }));
    } else if (actionPanelType === "map-filter") {
      setMapFilters(data);
    }
  };

  const revealItemInExplorer = (item) => {
    setActiveView("explore");
    setItemToReveal(item);
  };

  useEffect(() => {
    // Load settings from Electron (preload.js)
    window.electron.ipcRenderer
      .invoke("get-settings")
      .then(async (loadedSettings) => {
        if (loadedSettings) {
          setSettings(loadedSettings);
        }
      });
  }, []);

  useLayoutEffect(() => {
    document.documentElement.dataset.theme = getThemeName(settings?.theme);
  }, [settings?.theme]);

  const checkFolderStatuses = useCallback(async () => {
    if (!settings?.indexedFolders?.length) return;

    try {
      const map = settings.driveLetterMap || {};

      // Helper function to apply the drive-letter map
      const applyDriveLetterMap = (filePath) => {
        if (!filePath || !map || Object.keys(map).length === 0) return filePath;

        const normalizedPath = filePath.replace(/\//g, "\\"); // normalize slashes

        for (const [originalFolder, customLetter] of Object.entries(map)) {
          if (!originalFolder || !customLetter) continue;

          // Remove trailing slashes from the map path
          const trimmedOriginal = originalFolder.replace(/[\\/]+$/, "");

          // Case-insensitive comparison
          if (
            normalizedPath
              .toUpperCase()
              .startsWith(trimmedOriginal.toUpperCase())
          ) {
            const normalizedCustom = customLetter.replace(/:?$/, ":");
            const remainder = filePath.slice(2); // remove original drive letter
            const cleanRemainder = remainder.startsWith("\\")
              ? remainder
              : "\\" + remainder;
            return normalizedCustom + cleanRemainder;
          }
        }

        return filePath;
      };

      // Map all indexed folders
      const mappedFolders = settings.indexedFolders.map((folder) =>
        applyDriveLetterMap(folder),
      );

      // Send mapped folders to Electron IPC
      const statuses = await window.electron.ipcRenderer.invoke(
        "check-folders",
        mappedFolders,
      );
      // Expecting { "X:/Phone/...": true, ... }
      setFolderStatuses(statuses);
    } catch (error) {
      console.error("Error checking folder statuses:", error);
    }
  }, [settings]);

  // Run check every minute
  useEffect(() => {
    if (!settings) return;
    checkFolderStatuses(); // Initial run

    const interval = setInterval(checkFolderStatuses, 60 * 1000);
    return () => clearInterval(interval);
  }, [settings, checkFolderStatuses]);

  // Run check when switching views
  useEffect(() => {
    if (settings) {
      checkFolderStatuses();
    }
  }, [activeView, settings, checkFolderStatuses]);

  useEffect(() => {
    const handleKeyDown = (e) => {
      // Ignore if user is typing in an input / textarea
      const tag = document.activeElement?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;

      // ~ or `
      if (e.code === "Backquote") {
        e.preventDefault();
        window.electron.ipcRenderer.send("quick-minimize");
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  useEffect(() => {
    setActionPanelType(null);
    setViewCount(null);
  }, [activeView]);

  useEffect(() => {
    document
      .querySelector(".App-main")
      ?.classList.toggle("ambient-mode", ambientModeActive);

    return () => {
      document.querySelector(".App-main")?.classList.remove("ambient-mode");
    };
  }, [ambientModeActive]);

  // Check if user has seen Welcome Popup on mount & check username
  useEffect(() => {
    if (settings && settings.welcomePopupSeen === false) {
      setShowWelcomePopup(true);
    } else if (activeView === null) {
      setActiveView("explore");
    }
  }, [settings]);

  const applyWelcomeData = async (welcomeData) => {
    const newConfig = { ...settings };
    newConfig.welcomePopupSeen = true;
    newConfig.username = null;
    newConfig.indexedFolders = welcomeData.selectedFolders || [];
    setSettings(newConfig);
    try {
      const response = await window.electron.ipcRenderer.invoke(
        "save-settings",
        newConfig,
      );
      if (!response.success) {
        console.error("Failed to save settings:", response.error);
      }
    } catch (error) {
      console.error("Error saving settings:", error);
    }
    setShowWelcomePopup(false);
    setActiveView("explore");
  };

  const setNewActiveView = (view) => {
    setActiveView(view);
    setMapViewType("cluster");
  };

  useEffect(() => {
    if (activeView !== "explore") setActiveExplorerPersonId(null);
  }, [activeView]);

  // Apply new settings from Settings popup
  const applySettings = (newSettings) => {
    setSettings(newSettings); // Update state
  };

  // Apply new settings from Settings popup
  const openMediaSettings = () => {
    setActiveView("settings");
    setSelectedSettingsTab("Media");
  };

  const handleExplorerSelect = (item, type) => {
    setSelectedItem(item);
  
    if (!item) {
      setSelectedItemAvailable(false);
      setForceFullscreen(false);
      return;
    }
  
    setSelectedItemAvailable(folderStatuses[item.folder_path] ?? true);
  
    if (type === "double") {
      setForceFullscreen(true);
    } else {
      setForceFullscreen(false);
    }
  };

  const handleTagAssign = () => {
    setPreviewPanelKey(previewPanelKey + 1);
  };

  const handlePersonItemsRemoved = useCallback((itemIds) => {
    const removedIds = new Set(itemIds || []);
    if (!removedIds.size) return;
    setFilters((current) => {
      if (!activeExplorerPersonId || !Array.isArray(current?.ids)) return current;
      return {
        ...current,
        ids: current.ids.filter((id) => !removedIds.has(id)),
      };
    });
  }, [activeExplorerPersonId]);

  const handleActivePersonChange = useCallback((personId) => {
    const nextPersonId = Number.isInteger(Number(personId)) ? Number(personId) : null;
    setActiveExplorerPersonId(nextPersonId);
    setFilters((current) => {
      if (!current?._facePersonId && nextPersonId == null) return current;
      const next = { ...(current || {}) };
      if (nextPersonId == null) delete next._facePersonId;
      else next._facePersonId = nextPersonId;
      return next;
    });
  }, []);

  const handleExplorerScale = (newScale) => {
    setExplorerScale(newScale);
  };

  const handleActionPanelClick = (type) => {
    if (actionPanelType === null || actionPanelType !== type) {
      setActionPanelType(type);
    } else {
      setActionPanelType(null);
    }
  };

  const disableAddMode = () => {
    setFilters({});
  };

  const resetFilters = () => {
    setFilters({});
    setActiveExplorerPersonId(null);
    setActionPanelKey(actionPanelKey + 1);
  };

  const handleItemDeleted = useCallback(() => {
    setActionPanelKey((key) => key + 1);
  }, []);

  const handleFindSimilar = async (item) => {
    setExplorerLoading(true);
    const result = await window.electron.ipcRenderer.invoke(
      "embedding:search-by-id",
      {
        fileId: item.id,
        topK: 200,
      },
    );

    if (result.success && result.results.length > 0) {
      setExplorerLoading(false);
      handleActionPanelApply({
        ids: result.results,
        _smartSearch: true,
        _smartScores: result.scores,
        _similarTo: item.filename,
      });
    }
  };

  return (
    <div className="App">
      <div className="App-main">
        <MenuBar />
        <SideBar
          activeView={activeView}
          activeViewChanged={setNewActiveView}
          openActionPanel={handleActionPanelClick}
          actionPanelType={actionPanelType}
          mapViewType={mapViewType}
          switchMapViewType={setMapViewType}
          switchMemoryMode={setMemoryMode}
          memoryMode={memoryMode}
          setShowTagPopup={setShowTagPopup}
          showTagPopup={showTagPopup}
        />
        <div className="content">
          {activeView === "settings" && (
            <SettingsView
              currentSettings={settings} // Pass current settings
              applySettings={applySettings} // Pass function to apply new settings
              folderStatuses={folderStatuses}
              checkStatusses={checkFolderStatuses}
              newTab={selectedSettingsTab}
              enterRemoveMode={() => {
                setExplorerMode({ enabled: true, value: null, type: "remove" });
                setActiveView("explore");
              }}
            />
          )}
          {activeView === "stats" && (
            <StatsView
              birthDate={settings.birthDate}
              currentSettings={settings}
              onRevealItem={(item) => {
                setFilters({});
                setExplorerScroll(0);
                setActiveView("explore");
                setItemToReveal(item);
              }}
            />
          )}
          {activeView === "map" && (
            <MapView
              mapViewType={mapViewType}
              filters={mapFilters}
              currentSettings={settings}
              onRevealItem={revealItemInExplorer}
              onCountChange={setViewCount}
            />
          )}
          {activeView === "tags" && (
            <TagsView
              onViewTag={(tag) => {
                setFilters({ tagId: String(tag.id) });
                setExplorerScroll(0);
                setActiveView("explore");
              }}
              onAddMedia={(tag) => {
                setExplorerMode({
                  enabled: true,
                  value: tag.id,
                  type: "tag",
                  existing: tag.media_ids || [],
                });
                // setFilters({ tagId: tag.id, addMode: true });
                setActiveView("explore");
              }}
              showPopup={showTagPopup}
              setShowPopup={setShowTagPopup}
              onCountChange={setViewCount}
            />
          )}
          {activeView === "shuffle" && (
            <ShuffleView
              filters={shuffleFilters}
              interval={shuffleSettings.shuffleInterval * 1000}
              hideMetadata={shuffleSettings.hideInfo}
              smoothTransition={shuffleSettings.smoothTransition}
              chronological={shuffleSettings.chronological}
              currentSettings={settings}
            />
          )}
          {activeView === "memories" && (
            <MemoriesView
              switchMemoryMode={setMemoryMode}
              memoryMode={memoryMode}
              memoryLayout={settings.memoriesLayout}
              onViewMemory={(ids) => {
                if (!settings) {
                  setFilters({ ids });
                  setExplorerScroll(0);
                  setActiveView("explore");
                }
                switch (settings.openMemoriesIn) {
                  case "explorer":
                    setFilters({ ids });
                    setExplorerScroll(0);
                    setActiveView("explore");
                    break;
                  case "shuffle":
                    setShuffleFilters({ ids });
                    setActiveView("shuffle");
                    break;
                  case "map":
                    setMapFilters({ ids });
                    setActiveView("map");
                    break;
                  default:
                    setFilters({ ids });
                    setExplorerScroll(0);
                    setActiveView("explore");
                    break;
                }
              }}
              onAddMedia={(memory) => {
                setExplorerMode({
                  enabled: true,
                  value: memory.id,
                  type: "memory",
                  existing: memory.existing || [],
                });
                setActiveView("explore");
              }}
              onCountChange={setViewCount}
            />
          )}
          {activeView === "places" && (
            <PlacesView
              currentSettings={settings}
              onViewPlace={(ids) => {
                setFilters({ ids });
                setExplorerScroll(0);
                setActiveView("explore");
              }}
              onCountChange={setViewCount}
            />
          )}
          {activeView === "people" && (
            <PeopleView
              currentSettings={settings}
              onViewPerson={(person, view = "explore") => {
                if (view === "shuffle") {
                  setShuffleFilters({ ids: person.fileIds });
                  setActiveView("shuffle");
                  return;
                }
                if (view === "map") {
                  setMapFilters({ ids: person.fileIds });
                  setActiveView("map");
                  return;
                }
                setFilters({
                  ids: person.fileIds,
                  _facePersonId: person.id,
                });
                setActiveExplorerPersonId(person.id);
                setExplorerScroll(0);
                setActiveView("explore");
              }}
              onCountChange={setViewCount}
            />
          )}
          {activeView === "explore" && (
            <div className="explorer-container">
              <ExplorerView
                currentSettings={settings} // Pass current settings
                folderStatuses={folderStatuses}
                openSettings={openMediaSettings}
                onSelect={handleExplorerSelect}
                onTagAssign={handleTagAssign}
                onScale={handleExplorerScale}
                filters={filters}
                filteredCountUpdated={setFilteredCount}
                disableAddMode={disableAddMode}
                scrollPosition={explorerScroll}
                setScrollPosition={setExplorerScroll}
                actionPanelType={actionPanelType}
                resetFilters={resetFilters}
                itemDeleted={handleItemDeleted}
                explorerMode={explorerMode}
                setExplorerMode={setExplorerMode}
                explorerScale={explorerScale}
                onFindSimilar={handleFindSimilar}
                explorerLoading={explorerLoading}
                itemToReveal={itemToReveal}
                setItemToReveal={setItemToReveal}
                onPersonItemsRemoved={handlePersonItemsRemoved}
                activePersonId={activeExplorerPersonId}
                onActivePersonChange={handleActivePersonChange}
              />
              <div className="border-l overflow-y-auto bg-gray-50">
                {selectedItem ? (
                  <PreviewPanel
                    item={selectedItem}
                    isMuted={isMuted}
                    setIsMuted={setIsMuted}
                    forceFullscreen={forceFullscreen}
                    setForceFullscreen={setForceFullscreen}
                    birthDate={settings.birthDate}
                    currentSettings={settings}
                    panelKey={previewPanelKey}
                    selectedItemAvailable={selectedItemAvailable}
                    smartScore={
                      selectedItem && filters?._smartSearch && filters?._smartScores
                        ? (filters._smartScores[selectedItem.id] ?? null)
                        : null
                    }
                    textMatch={
                      selectedItem && filters?._textSearch && filters?._textMatches
                        ? (filters._textMatches[selectedItem.id] ?? null)
                        : null
                    }
                    textSearchTerm={
                      selectedItem && filters?._textSearch
                        ? (filters.searchTerm ?? "")
                        : ""
                    }
                    facePersonId={activeExplorerPersonId}
                  />
                ) : (
                  <div className="preview-center-text p-4 text-gray-400">
                    Select a file to preview
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
        {(activeView === "explore" ||
          activeView === "shuffle" ||
          activeView === "map") && (
          <ActionPanel
            settings={settings}
            type={actionPanelType}
            activeView={activeView}
            activeFilters={filters}
            activeShuffleFilters={shuffleFilters}
            activeMapFilters={mapFilters}
            activeShuffleSettings={shuffleSettings}
            onApply={handleActionPanelApply}
            actionPanelKey={actionPanelKey}
          />
        )}
        <div>
          {showWelcomePopup && (
            <WelcomePopup
              submitWelcomePopup={applyWelcomeData} // Pass function to apply new settings
            />
          )}
        </div>
        <BottomBar
          explorerScale={explorerScale}
          filteredCount={filteredCount}
          activeView={activeView}
          viewCount={viewCount}
        />
      </div>
    </div>
  );
};

export default App;
