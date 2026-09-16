import { faSearch, faUndo } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import React, { useState, useEffect, useRef, useCallback } from "react";

// ─── Constants ────────────────────────────────────────────────────────────────

const EMPTY_FILTERS = {
  dateExact: "",
  dateFrom: "",
  dateTo: "",
  device: "",
  folder: "",
  filetype: "",
  mediaType: "",
  captureType: "",
  country: "",
  year: "",
  tagId: "",
  age: "",
  lens: "",
  ids: null,
};

const DEFAULT_SORT = { sortBy: "media_id", sortOrder: "desc" };
const DEFAULT_SEARCH = { searchBy: "name", searchTerm: "" };
const DEFAULT_SHUFFLE_SETTINGS = {
  shuffleInterval: 8,
  hideInfo: false,
  smoothTransition: false,
};

// ─── Generic filter hook ───────────────────────────────────────────────────────

function useFilterState(initial = EMPTY_FILTERS) {
  const [filters, setFilters] = useState(initial);

  const handleDateChange = (field, value) => {
    setFilters((prev) => {
      const next = { ...prev, [field]: value };
      if (field === "dateExact" && value) {
        next.dateFrom = "";
        next.dateTo = "";
        next.year = "";
        next.age = "";
      } else if ((field === "dateFrom" || field === "dateTo") && value) {
        next.dateExact = "";
        next.year = "";
        next.age = "";
      }
      if (field === "dateFrom" && next.dateTo && value > next.dateTo)
        next.dateTo = value;
      if (field === "dateTo" && next.dateFrom && value < next.dateFrom)
        next.dateFrom = value;
      return next;
    });
  };

  const handleYearChange = (year) => {
    setFilters((prev) => {
      if (!year)
        return { ...prev, year: "", dateFrom: "", dateTo: "", age: "" };
      return {
        ...prev,
        year,
        age: "",
        dateFrom: `${year}-01-01`,
        dateTo: `${year}-12-31`,
      };
    });
  };

  const handleAgeChange = (age, birthDate) => {
    setFilters((prev) => {
      if (!age || !birthDate)
        return { ...prev, age: "", dateFrom: "", dateTo: "" };
      const birth = new Date(birthDate);
      const dateFrom = new Date(birth);
      dateFrom.setFullYear(birth.getFullYear() + Number(age));
      const dateTo = new Date(birth);
      dateTo.setFullYear(birth.getFullYear() + Number(age) + 1);
      dateTo.setDate(dateTo.getDate() - 1);
      return {
        ...prev,
        age,
        year: "",
        dateExact: "",
        dateFrom: dateFrom.toISOString().slice(0, 10),
        dateTo: dateTo.toISOString().slice(0, 10),
      };
    });
  };

  const resetFilters = () => setFilters(EMPTY_FILTERS);

  return {
    filters,
    setFilters,
    handleDateChange,
    handleYearChange,
    handleAgeChange,
    resetFilters,
  };
}

// ─── Smart Search Input ────────────────────────────────────────────────────────

/**
 * The input + status display for Smart Search.
 * Shows a progress bar while embeddings are being built,
 * disables input until the model is ready.
 */
const SmartSearchInput = ({
  status,
  value,
  isSearching,
  onChange,
  onSearch,
  onReset,
  threshold,
  setThreshold,
  topK,
  setTopK,
}) => {
  const inputRef = useRef(null);

  const embeddingsComplete = status.total > 0 && status.done >= status.total;
  const embeddingsReady = status.modelReady && status.done > 0;

  let placeholder;
  if (!status.modelReady && !status.initError) {
    placeholder = "Loading CLIP model…";
  } else if (status.initError) {
    placeholder = "Model unavailable — check logs";
  } else if (!embeddingsReady) {
    placeholder = "Building index… please wait";
  } else if (isSearching) {
    placeholder = "Searching…";
  } else {
    placeholder = embeddingsComplete
      ? "Search your photos (e.g. 'beach sunset')"
      : `Search available (${status.done} / ${status.total} indexed)`;
  }

  const handleKey = (e) => {
    if (e.key === "Enter" && embeddingsReady && !isSearching && value.trim()) {
      onSearch(value, threshold, topK);
    }
  };

  return (
    <div className="smart-search-wrapper">
      {/* Row 1: text input + go + reset */}
      <div className="smart-search-input-row">
        <input
          ref={inputRef}
          type="text"
          value={value}
          disabled={!embeddingsReady || isSearching}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKey}
          className="smart-search-input"
        />
        {embeddingsReady && !isSearching && value.trim() && (
          <button
            className="smart-search-go-btn"
            onClick={() => onSearch(value, threshold, topK)}
            title="Search"
          >
            <FontAwesomeIcon icon={faSearch} />
          </button>
        )}
        {isSearching && (
          <span className="smart-search-spinner" title="Searching…" />
        )}
        <div className="action-panel-reset">
          <button onClick={onReset} title="Clear smart search">
            <FontAwesomeIcon icon={faUndo} />
          </button>
        </div>
      </div>

      {/* Row 2: threshold + topK — only shown when model is ready */}
      {embeddingsReady && (
        <div className="smart-search-options-row">
          <label
            className="smart-search-option-label"
            title="Minimum similarity score (0–1). Higher = stricter matches only."
          >
            Min score
            <input
              type="number"
              className="smart-search-option-input"
              // toFixed(2) ensures "0.20" is displayed instead of "0.2"
              value={Number(threshold).toFixed(2)}
              min={0.01}
              max={0.99}
              step={0.01}
              onChange={(e) =>
                setThreshold(
                  Math.min(0.99, Math.max(0.01, Number(e.target.value))),
                )
              }
            />
          </label>
          <label
            className="smart-search-option-label"
            title="Maximum number of results to return."
          >
            Max results
            <input
              type="number"
              className="smart-search-option-input smart-search-option-max"
              value={topK}
              min={1}
              // max={10000}
              step={50}
              onChange={(e) => setTopK(Math.max(1, Number(e.target.value)))}
            />
          </label>
        </div>
      )}
    </div>
  );
};

// ─── Shared FilterPanel component ─────────────────────────────────────────────

const FilterPanel = ({ filters, options, settings, handlers, onReset }) => {
  const { handleDateChange, handleYearChange, handleAgeChange, setFilters } =
    handlers;

  return (
    <div className="filter-panel">
      {filters.ids && (
        <div>
          <label>Selection</label>
          <span className="filter-static">{filters.ids.length + " items"}</span>
        </div>
      )}

      <div>
        <label>Year</label>
        <select
          value={filters.year}
          onChange={(e) => handleYearChange(e.target.value)}
        >
          <option value="">All</option>
          {options.years.map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label>Date</label>
        <input
          type="date"
          value={filters.dateExact}
          min={options.minDate}
          max={options.maxDate}
          disabled={!!filters.dateFrom || !!filters.dateTo}
          onChange={(e) => handleDateChange("dateExact", e.target.value)}
        />
      </div>

      <div>
        <label>Date From</label>
        <input
          type="date"
          value={filters.dateFrom}
          min={options.minDate}
          max={options.maxDate}
          disabled={!!filters.dateExact}
          onChange={(e) => handleDateChange("dateFrom", e.target.value)}
        />
      </div>

      <div>
        <label>Date To</label>
        <input
          type="date"
          value={filters.dateTo}
          min={options.minDate}
          max={options.maxDate}
          disabled={!!filters.dateExact}
          onChange={(e) => handleDateChange("dateTo", e.target.value)}
        />
      </div>

      {[
        ["Device", "device", options.devices],
        ["Filetype", "filetype", options.filetypes],
        ["Media Type", "mediaType", options.mediaTypes],
        ["Capture Type", "captureType", options.captureTypes],
        ["Lens", "lens", options.lenses],
      ].map(([label, key, opts]) => (
        <div key={key}>
          <label>{label}</label>
          <select
            value={filters[key]}
            onChange={(e) =>
              setFilters((prev) => ({ ...prev, [key]: e.target.value }))
            }
          >
            <option value="">All</option>
            {(opts ?? []).map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        </div>
      ))}

      <div>
        <label>Source</label>
        <select
          value={filters.folder}
          onChange={(e) =>
            setFilters((prev) => ({ ...prev, folder: e.target.value }))
          }
        >
          <option value="">All</option>
          {options.folders.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label>Tag</label>
        <select
          value={filters.tagId}
          onChange={(e) =>
            setFilters((prev) => ({ ...prev, tagId: e.target.value }))
          }
        >
          <option value="">All</option>
          {(options.tags ?? []).map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label>Country</label>
        <select
          value={filters.country}
          onChange={(e) =>
            setFilters((prev) => ({ ...prev, country: e.target.value }))
          }
        >
          <option value="">All</option>
          {options.countries.filter(Boolean).map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </div>

      {settings?.birthDate && (
        <div>
          <label>Age</label>
          <select
            value={filters.age}
            onChange={(e) =>
              handleAgeChange(e.target.value, settings.birthDate)
            }
          >
            <option value="">All</option>
            {[...options.ages].reverse().map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="action-panel-reset">
        <button onClick={onReset}>
          <FontAwesomeIcon icon={faUndo} />
        </button>
      </div>
    </div>
  );
};

// ─── Main component ───────────────────────────────────────────────────────────

const ActionPanel = ({
  settings,
  type,
  onApply,
  actionPanelKey,
  activeFilters,
  activeMapFilters,
  activeView,
  activeShuffleFilters,
  activeShuffleSettings,
}) => {
  const [sortBy, setSortBy] = useState(DEFAULT_SORT.sortBy);
  const [sortOrder, setSortOrder] = useState(DEFAULT_SORT.sortOrder);
  const [searchBy, setSearchBy] = useState(DEFAULT_SEARCH.searchBy);
  const [searchTerm, setSearchTerm] = useState(DEFAULT_SEARCH.searchTerm);
  const [prevActionPanelKey, setPrevActionPanelKey] = useState(0);
  const skipNextApplyRef = useRef(false);

  const [shuffleSettings, setShuffleSettings] = useState(
    DEFAULT_SHUFFLE_SETTINGS,
  );

  // ── Smart Search state ───────────────────────────────────────────────────
  const [smartSearchTerm, setSmartSearchTerm] = useState("");
  const [smartSearchStatus, setSmartSearchStatus] = useState({
    modelReady: false,
    total: 0,
    done: 0,
    percentage: 0,
    initError: null,
  });
  const [smartThreshold, setSmartThreshold] = useState(0.2);
  const [smartTopK, setSmartTopK] = useState(200);
  const [isSearching, setIsSearching] = useState(false);

  const [options, setOptions] = useState({
    devices: [],
    folders: [],
    filetypes: [],
    mediaTypes: [],
    captureTypes: [],
    minDate: "",
    maxDate: "",
    countries: [],
    years: [],
    tags: [],
    ages: [],
  });

  const explore = useFilterState(activeFilters || EMPTY_FILTERS);
  const shuffle = useFilterState(activeShuffleFilters || EMPTY_FILTERS);
  const map = useFilterState(activeMapFilters || EMPTY_FILTERS);

  // ── Fetch options ──────────────────────────────────────────────────────────

  useEffect(() => {
    async function fetchOptions() {
      const opts = await window.electron.ipcRenderer.invoke("fetch-options", {
        birthDate: settings?.birthDate ?? null,
        hiddenFolders: settings?.hiddenFolders,
      });
      setOptions(opts);
    }
    fetchOptions();
  }, [settings, actionPanelKey]);

  // ── Sync default sort from settings ───────────────────────────────────────

  useEffect(() => {
    if (settings?.defaultSort && !activeFilters) {
      setSortBy(settings.defaultSort);
    }
  }, [settings]);

  // ── Sync active state when view changes ───────────────────────────────────

  useEffect(() => {
    if (activeView === "explore") {
      if (activeFilters?.sortBy && activeFilters?.sortOrder) {
        setSortBy(activeFilters.sortBy);
        setSortOrder(activeFilters.sortOrder);
      } else if (activeFilters?.searchBy && activeFilters?.searchTerm) {
        setSearchBy(activeFilters.searchBy);
        setSearchTerm(activeFilters.searchTerm);
      } else if (activeFilters) {
        explore.setFilters((prev) => ({ ...prev, ...activeFilters }));
      }
    } else if (activeView === "shuffle") {
      if (activeShuffleFilters)
        shuffle.setFilters((prev) => ({ ...prev, ...activeShuffleFilters }));
      if (activeShuffleSettings)
        setShuffleSettings((prev) => ({ ...prev, ...activeShuffleSettings }));
    } else if (activeView === "map") {
      if (activeMapFilters)
        map.setFilters((prev) => ({ ...prev, ...activeMapFilters }));
    }
  }, [activeView]);

  useEffect(() => {
    if (activeFilters?.ids === undefined) return;

    skipNextApplyRef.current = true;

    explore.setFilters((prev) => ({
      ...(activeFilters?._similarTo ? EMPTY_FILTERS : prev),
      ids: activeFilters.ids,
    }));

    queueMicrotask(() => {
      skipNextApplyRef.current = false;
    });
  }, [activeFilters?.ids, activeFilters?._similarTo]);

  // ── Poll embedding status when search panel is open ───────────────────────

  useEffect(() => {
    if (type !== "search") return;

    const fetchStatus = async () => {
      try {
        const status = await window.electron.ipcRenderer.invoke(
          "embedding:get-status",
        );
        if (status) setSmartSearchStatus(status);
      } catch {}
    };

    fetchStatus();
    const interval = setInterval(fetchStatus, 5000);
    return () => clearInterval(interval);
  }, [type]);

  // ── Also update status in real-time via IPC event ─────────────────────────

  useEffect(() => {
    const handler = (data) => {
      if (data) setSmartSearchStatus(data);
    };
    return window.electron.ipcRenderer.on("embedding-progress", handler);
  }, []);

  // ── Auto-apply on state change ─────────────────────────────────────────────

  const typeRef = useRef(type);

  useEffect(() => {
    typeRef.current = type;
  }, [type]);

  useEffect(() => {
    if (typeRef.current === "sort") onApply({ sortBy, sortOrder });
  }, [sortBy, sortOrder]);
  useEffect(() => {
    if (typeRef.current !== "filter") return;
    if (skipNextApplyRef.current) {
      skipNextApplyRef.current = false;
      return;
    }
    onApply(explore.filters);
  }, [explore.filters]);
  useEffect(() => {
    if (typeRef.current === "shuffle-filter") onApply(shuffle.filters);
  }, [shuffle.filters]);
  useEffect(() => {
    if (typeRef.current === "shuffle-settings") onApply(shuffleSettings);
  }, [shuffleSettings]);
  useEffect(() => {
    if (typeRef.current === "search") onApply({ searchBy, searchTerm });
  }, [searchBy, searchTerm]);
  useEffect(() => {
    if (typeRef.current === "map-filter") onApply(map.filters);
  }, [map.filters]);

  // ── Reset helpers ──────────────────────────────────────────────────────────

  const resetSort = () => {
    setSortBy(settings?.defaultSort ?? "media_id");
    setSortOrder("desc");
  };
  const resetSearch = () => {
    setSearchBy("name");
    setSearchTerm("");
    setSmartSearchTerm("");
  };

  // Explore filters also clear sort/search
  const handleExploreDate = (field, value) => {
    explore.handleDateChange(field, value);
    resetSort();
    resetSearch();
  };
  const handleExploreYear = (year) => {
    explore.handleYearChange(year);
    resetSort();
    resetSearch();
  };
  const handleExploreAge = (age) => {
    explore.handleAgeChange(age, settings?.birthDate);
    resetSort();
    resetSearch();
  };
  const handleExploreFilter = (key, value) => {
    explore.setFilters((prev) => ({ ...prev, [key]: value }));
    resetSort();
    resetSearch();
  };

  const resetExploreAll = () => {
    explore.resetFilters();
    resetSort();
    resetSearch();
  };

  // ── Smart Search ──────────────────────────────────────────────────────────

  const handleSmartSearch = useCallback(
    async (term, threshold = 0.2, topK = 200) => {
      if (!term.trim()) {
        onApply({
          searchBy: "smart",
          searchTerm: "",
          smartIds: null,
          smartScores: null,
        });
        return;
      }
      setIsSearching(true);
      try {
        const result = await window.electron.ipcRenderer.invoke(
          "embedding:search",
          {
            query: term,
            topK,
            threshold,
          },
        );
        onApply({
          searchBy: "smart",
          searchTerm: term,
          smartIds: result.success ? result.results : [],
          smartScores: result.success ? result.scores : {},
        });
      } catch (err) {
        console.error("Smart search error:", err);
      }
      setIsSearching(false);
    },
    [onApply],
  );

  const handleSmartReset = useCallback(() => {
    setSmartSearchTerm("");
    setSmartThreshold(0.2);
    setSmartTopK(200);
    onApply({
      searchBy: "smart",
      searchTerm: "",
      smartIds: null,
      smartScores: null,
    });
  }, [onApply]);

  // ── Reset on panel key change ──────────────────────────────────────────────

  useEffect(() => {
    if (actionPanelKey !== prevActionPanelKey) {
      setPrevActionPanelKey(actionPanelKey);
      explore.resetFilters();
      resetSearch();
      setSortBy("media_id");
      setSortOrder("desc");
    }
  }, [actionPanelKey]);

  if (!type) return null;

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="action-panel">
      <div className="action-panel-content">
      {type === "sort" && (
        <div className="sort-panel">
          <label>Sort by:</label>
          <select
            value={sortBy}
            onChange={(e) => {
              resetSearch();
              explore.resetFilters();
              setSortBy(e.target.value);
            }}
          >
            <option value="media_id">ID</option>
            <option value="name">Name</option>
            <option value="create_date_local">Date Taken</option>
            <option value="created">Date Created</option>
            <option value="size">File Size</option>
            <option value="random">Random</option>
          </select>
          <button
            onClick={() => {
              resetSearch();
              explore.resetFilters();
              setSortOrder("asc");
            }}
            className={sortOrder === "asc" ? "active" : ""}
          >
            Asc
          </button>
          <button
            onClick={() => {
              resetSearch();
              explore.resetFilters();
              setSortOrder("desc");
            }}
            className={sortOrder === "desc" ? "active" : ""}
          >
            Desc
          </button>
          <div className="action-panel-reset">
            <button onClick={resetSort}>
              <FontAwesomeIcon icon={faUndo} />
            </button>
          </div>
        </div>
      )}

      {type === "filter" && (
        <FilterPanel
          filters={explore.filters}
          options={options}
          settings={settings}
          handlers={{
            handleDateChange: handleExploreDate,
            handleYearChange: handleExploreYear,
            handleAgeChange: handleExploreAge,
            setFilters: (updater) => {
              explore.setFilters(updater);
              resetSort();
              resetSearch();
            },
          }}
          onReset={resetExploreAll}
        />
      )}

      {type === "search" && (
        <div className="search-panel">
          <select
            className="search-panel-type-select"
            value={searchBy}
            onChange={(e) => {
              explore.resetFilters();
              resetSort();
              setSearchBy(e.target.value);
              setSearchTerm("");
              setSmartSearchTerm("");
              // Clear any active smart search when switching away
              if (e.target.value !== "smart") {
                onApply({ searchBy: e.target.value, searchTerm: "" });
              }
            }}
          >
            <option value="name">Name</option>
            <option value="media_id">ID</option>
            <option value="smart">Smart</option>
            <option value="location">Location</option>
          </select>

          {searchBy !== "smart" ? (
            <>
              <input
                type="text"
                value={searchTerm}
                onChange={(e) => {
                  explore.resetFilters();
                  resetSort();
                  setSearchTerm(e.target.value);
                }}
                placeholder="Search..."
              />
              <div className="action-panel-reset">
                <button onClick={resetSearch}>
                  <FontAwesomeIcon icon={faUndo} />
                </button>
              </div>
            </>
          ) : (
            <SmartSearchInput
              status={smartSearchStatus}
              value={smartSearchTerm}
              isSearching={isSearching}
              onChange={setSmartSearchTerm}
              onSearch={handleSmartSearch}
              onReset={handleSmartReset}
              threshold={smartThreshold}
              setThreshold={setSmartThreshold}
              topK={smartTopK}
              setTopK={setSmartTopK}
            />
          )}
        </div>
      )}

      {type === "shuffle-filter" && (
        <FilterPanel
          filters={shuffle.filters}
          options={options}
          settings={settings}
          handlers={shuffle}
          onReset={shuffle.resetFilters}
        />
      )}

      {type === "shuffle-settings" && (
        <div className="shuffle-settings-panel">
          <div>
            <label>Shuffle Interval: </label>
            <input
              type="number"
              min="1"
              value={shuffleSettings.shuffleInterval}
              onChange={(e) => {
                const value = Number(e.target.value);
                setShuffleSettings((prev) => ({
                  ...prev,
                  shuffleInterval: isNaN(value) || value < 1 ? 1 : value,
                }));
              }}
              style={{ width: "80px" }}
            />
            <span> seconds</span>
          </div>
          <div>
            <label>Hide Metadata: </label>
            <div className="slider-wrapper">
              <label className="switch">
                <input
                  type="checkbox"
                  checked={shuffleSettings.hideInfo}
                  onChange={(e) =>
                    setShuffleSettings((prev) => ({
                      ...prev,
                      hideInfo: e.target.checked,
                    }))
                  }
                />
                <div className="slider round"></div>
              </label>
            </div>
          </div>
          <div>
            <label>Smooth Transition: </label>
            <div className="slider-wrapper">
              <label className="switch">
                <input
                  type="checkbox"
                  checked={shuffleSettings.smoothTransition}
                  onChange={(e) =>
                    setShuffleSettings((prev) => ({
                      ...prev,
                      smoothTransition: e.target.checked,
                    }))
                  }
                />
                <div className="slider round"></div>
              </label>
            </div>
          </div>
          <div>
            <label>Chronological: </label>
            <div className="slider-wrapper">
              <label className="switch">
                <input
                  type="checkbox"
                  checked={shuffleSettings.chronological}
                  onChange={(e) =>
                    setShuffleSettings((prev) => ({
                      ...prev,
                      chronological: e.target.checked,
                    }))
                  }
                />
                <div className="slider round"></div>
              </label>
            </div>
          </div>
          <div>
            <label>Ambient Mode: </label>
            <div className="slider-wrapper">
              <label className="switch">
                <input
                  type="checkbox"
                  checked={shuffleSettings.ambientMode}
                  onChange={(e) =>
                    setShuffleSettings((prev) => ({
                      ...prev,
                      ambientMode: e.target.checked,
                    }))
                  }
                />
                <div className="slider round"></div>
              </label>
            </div>
          </div>
        </div>
      )}

      {type === "map-filter" && (
        <FilterPanel
          filters={map.filters}
          options={options}
          settings={settings}
          handlers={map}
          onReset={map.resetFilters}
        />
      )}
      </div>
    </div>
  );
};

export default ActionPanel;
