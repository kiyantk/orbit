import { faSearch, faUndo } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import React, { useState, useEffect, useRef, useCallback } from "react";
import Select, { components } from "react-select";

// ─── Constants ────────────────────────────────────────────────────────────────

const EMPTY_FILTERS = {
  dateExact: "",
  dateFrom: "",
  dateTo: "",
  device: [],
  folder: [],
  filetype: [],
  mediaType: [],
  captureType: [],
  country: [],
  year: [],
  tagId: [],
  age: [],
  lens: [],
  ids: null,
};

const DEFAULT_SORT = { sortBy: "media_id", sortOrder: "desc" };
const DEFAULT_SEARCH = { searchBy: "name", searchTerm: "" };
const DEFAULT_SHUFFLE_SETTINGS = {
  shuffleInterval: 8,
  hideInfo: false,
  smoothTransition: false,
};

function hasActiveExplorerConstraint(filters) {
  return Object.entries(filters || {}).some(([key, value]) => {
    if (
      key === "searchBy" ||
      key === "sortBy" ||
      key === "sortOrder" ||
      key === "tagMatch"
    ) {
      return false;
    }

    if (key === "searchTerm") return Boolean(String(value || "").trim());
    if (Array.isArray(value)) return value.length > 0;
    return value !== null && value !== undefined && value !== "" && value !== false;
  });
}

const asFilterValues = (value) =>
  (Array.isArray(value) ? value : value ? [value] : []).filter(
    (item) => item !== "" && item !== null && item !== undefined,
  );

// ─── Generic filter hook ───────────────────────────────────────────────────────

function useFilterState(initial = EMPTY_FILTERS) {
  const [filters, setFilters] = useState(initial);

  const handleDateChange = (field, value) => {
    setFilters((prev) => {
      const next = { ...prev, [field]: value };
      if (field === "dateExact" && value) {
        next.dateFrom = "";
        next.dateTo = "";
        next.year = [];
        next.age = [];
      } else if ((field === "dateFrom" || field === "dateTo") && value) {
        next.dateExact = "";
        next.year = [];
        next.age = [];
      }
      if (field === "dateFrom" && next.dateTo && value > next.dateTo)
        next.dateTo = value;
      if (field === "dateTo" && next.dateFrom && value < next.dateFrom)
        next.dateFrom = value;
      return next;
    });
  };

  const handleYearChange = (years) => {
    setFilters((prev) => {
      return {
        ...prev,
        year: asFilterValues(years),
        age: [],
        dateExact: "",
        dateFrom: "",
        dateTo: "",
      };
    });
  };

  const handleAgeChange = (ages) => {
    setFilters((prev) => {
      return {
        ...prev,
        age: asFilterValues(ages),
        year: [],
        dateExact: "",
        dateFrom: "",
        dateTo: "",
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
  const resourceState = status.resource?.state;

  let placeholder;
  if (resourceState === "download-required") {
    placeholder = "Smart Search download required - install it in Settings";
  } else if (resourceState === "downloading") {
    placeholder = `Downloading Smart Search resource (${status.resource.progressPercent ?? 0}%)`;
  } else if (resourceState === "extracting") {
    placeholder = "Installing Smart Search resource...";
  } else if (resourceState === "download-failed") {
    placeholder = "Smart Search download failed - retry it in Settings";
  } else if (!status.modelReady && !status.initError) {
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

const TextSearchInput = ({ status, value, isSearching, onChange, onSearch, onReset }) => {
  const resourceState = status.resource?.state;
  const searchable = status.done > 0 && resourceState === "ready";
  let placeholder = "Search text in your photos";
  if (resourceState === "download-required") placeholder = "Text search download required - install it in Settings";
  else if (resourceState === "downloading") placeholder = `Downloading Text Search (${status.resource.progressPercent ?? 0}%)`;
  else if (resourceState === "extracting") placeholder = "Installing Text Search resource...";
  else if (resourceState === "download-failed") placeholder = "Text Search download failed - retry it in Settings";
  else if (status.initError) placeholder = "OCR model unavailable — check Settings";
  else if (!status.modelReady) placeholder = "Loading OCR model…";
  else if (!searchable) placeholder = "Building text index… please wait";
  else if (isSearching) placeholder = "Searching detected text…";
  else if (status.total > status.done) placeholder = `Search available (${status.done} / ${status.total} indexed)`;

  const submit = () => {
    if (searchable && !isSearching && value.trim()) onSearch(value);
  };

  return (
    <div className="smart-search-wrapper">
      <div className="smart-search-input-row">
        <input
          type="text"
          value={value}
          disabled={!searchable || isSearching}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          className="smart-search-input"
        />
        {searchable && !isSearching && value.trim() && (
          <button className="smart-search-go-btn" onClick={submit} title="Search detected text">
            <FontAwesomeIcon icon={faSearch} />
          </button>
        )}
        {isSearching && <span className="smart-search-spinner" title="Searching…" />}
        <div className="action-panel-reset">
          <button onClick={onReset} title="Clear text search"><FontAwesomeIcon icon={faUndo} /></button>
        </div>
      </div>
    </div>
  );
};

// ─── Shared FilterPanel component ─────────────────────────────────────────────

const TagMatchMenuList = (props) => {
  const { showTagMatchControls, tagMatchMode, onTagMatchChange } =
    props.selectProps;

  return (
    <components.MenuList {...props}>
      {showTagMatchControls && (
        <div
          className="filter-select__menu-header"
          onMouseDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
        >
          <div className="tag-match-toggle" role="group" aria-label="Tag match mode">
            <button
              className={tagMatchMode === "or" ? "active" : ""}
              onClick={() => onTagMatchChange("or")}
              title="Show files with any selected tag"
            >
              OR
            </button>
            <button
              className={tagMatchMode === "and" ? "active" : ""}
              onClick={() => onTagMatchChange("and")}
              title="Show files with every selected tag"
            >
              AND
            </button>
          </div>
        </div>
      )}
      {props.children}
    </components.MenuList>
  );
};

const TAG_MATCH_COMPONENTS = { MenuList: TagMatchMenuList };

const MultiSelectFilter = ({
  value,
  options,
  onChange,
  minWidth = 135,
  isTagFilter = false,
  showTagMatchControls = false,
  tagMatchMode = null,
  onTagMatchChange = null,
}) => {
  const selectedValues = asFilterValues(value).map(String);
  const selectedOptions = selectedValues.map(
    (selectedValue) =>
      options.find((option) => option.value === selectedValue) || {
        value: selectedValue,
        label: selectedValue,
      },
  );
  return (
    <Select
      isMulti
      closeMenuOnSelect={false}
      hideSelectedOptions={false}
      className="filter-multi-select"
      classNamePrefix="filter-select"
      components={isTagFilter ? TAG_MATCH_COMPONENTS : undefined}
      styles={{
        container: (base) => ({
          ...base,
          flex: "0 0 auto",
          minWidth,
          width: "max-content",
        }),
        control: (base) => ({ ...base, minWidth, width: "max-content" }),
        menuList: (base) =>
          isTagFilter ? { ...base, paddingTop: 0 } : base,
      }}
      menuPortalTarget={document.body}
      menuPosition="fixed"
      showTagMatchControls={showTagMatchControls}
      tagMatchMode={tagMatchMode}
      onTagMatchChange={onTagMatchChange}
      options={options}
      value={selectedOptions}
      onChange={(selected) =>
        onChange((selected ?? []).map((option) => option.value))
      }
      placeholder="All"
      noOptionsMessage={() => "No options"}
    />
  );
};

const FilterPanel = ({ filters, options, settings, handlers, onReset }) => {
  const { handleDateChange, handleYearChange, handleAgeChange, setFilters } =
    handlers;
  const hasYearOrAgeFilter =
    asFilterValues(filters.year).length > 0 || asFilterValues(filters.age).length > 0;
  const tagIds = asFilterValues(filters.tagId);
  const tagMatchMode = filters.tagMatch === "and" ? "and" : "or";

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
        <MultiSelectFilter
          value={filters.year}
          options={options.years.map((year) => ({
            value: String(year),
            label: String(year),
          }))}
          onChange={handleYearChange}
        />
      </div>

      <div>
        <label>Date</label>
        <input
          type="date"
          value={filters.dateExact}
          min={options.minDate}
          max={options.maxDate}
          disabled={
            !!filters.dateFrom || !!filters.dateTo || hasYearOrAgeFilter
          }
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
          disabled={!!filters.dateExact || hasYearOrAgeFilter}
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
          disabled={!!filters.dateExact || hasYearOrAgeFilter}
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
          <MultiSelectFilter
            value={filters[key]}
            minWidth={
              key === "device"
                ? 200
                : key === "captureType"
                  ? 150
                  : key === "lens"
                    ? 350
                    : 135
            }
            options={(opts ?? []).map((option) => ({
              value: String(option),
              label: String(option),
            }))}
            onChange={(value) =>
              setFilters((prev) => ({ ...prev, [key]: value }))
            }
          />
        </div>
      ))}

      <div>
        <label>Source</label>
        <MultiSelectFilter
          value={filters.folder}
          minWidth={350}
          options={options.folders.map((folder) => ({
            value: String(folder.value),
            label: String(folder.label),
          }))}
          onChange={(value) =>
            setFilters((prev) => ({ ...prev, folder: value }))
          }
        />
      </div>

      <div className="tag-filter">
        <label>Tag</label>
        <MultiSelectFilter
          value={filters.tagId}
          options={(options.tags ?? []).map((tag) => ({
            value: String(tag.id),
            label: tag.name,
          }))}
          isTagFilter
          tagMatchMode={tagIds.length > 1 ? tagMatchMode : null}
          showTagMatchControls={tagIds.length > 1}
          onTagMatchChange={(mode) =>
            setFilters((prev) => {
              if (mode === "and") return { ...prev, tagMatch: "and" };
              const next = { ...prev };
              delete next.tagMatch;
              return next;
            })
          }
          onChange={(value) =>
            setFilters((prev) => ({ ...prev, tagId: value }))
          }
        />
      </div>

      <div>
        <label>Country</label>
        <MultiSelectFilter
          value={filters.country}
          options={options.countries.filter(Boolean).map((country) => ({
            value: String(country),
            label: String(country),
          }))}
          onChange={(value) =>
            setFilters((prev) => ({ ...prev, country: value }))
          }
        />
      </div>

      {settings?.birthDate && (
        <div>
          <label>Age</label>
          <MultiSelectFilter
            value={filters.age}
            options={[...options.ages].reverse().map((age) => ({
              value: String(age),
              label: String(age),
            }))}
            onChange={handleAgeChange}
          />
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
  const lastNonRelevanceSortRef = useRef(DEFAULT_SORT);
  const [searchBy, setSearchBy] = useState(DEFAULT_SEARCH.searchBy);
  const [searchTerm, setSearchTerm] = useState(DEFAULT_SEARCH.searchTerm);
  const [prevActionPanelKey, setPrevActionPanelKey] = useState(actionPanelKey);
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
    resource: {
      id: "smart-search",
      state: "download-required",
      downloadSizeLabel: "107 MB",
    },
  });
  const [smartThreshold, setSmartThreshold] = useState(0.2);
  const [smartTopK, setSmartTopK] = useState(200);
  const [isSearching, setIsSearching] = useState(false);
  const [textSearchTerm, setTextSearchTerm] = useState("");
  const [textSearchStatus, setTextSearchStatus] = useState({
    modelReady: false, total: 0, done: 0, percentage: 0, initError: null,
    resource: { id: "ocr", state: "download-required", downloadSizeLabel: "25 MB" },
  });
  const [isTextSearching, setIsTextSearching] = useState(false);

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
  const relevanceSearchActive = Boolean(
    activeFilters?._smartSearch || activeFilters?._textSearch,
  );

  useEffect(() => {
    if (sortBy !== "relevance") {
      lastNonRelevanceSortRef.current = { sortBy, sortOrder };
    }
  }, [sortBy, sortOrder]);

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
    // Smart/text result IDs are search state. Keeping them out of the filter
    // panel prevents a later filter edit from reviving a cleared search.
    if (activeFilters?._smartSearch || activeFilters?._textSearch) return;

    skipNextApplyRef.current = true;

    explore.setFilters((prev) => ({
      ...(activeFilters?._similarTo ? EMPTY_FILTERS : prev),
      ids: activeFilters.ids,
    }));

    queueMicrotask(() => {
      skipNextApplyRef.current = false;
    });
  }, [
    activeFilters?.ids,
    activeFilters?._similarTo,
    activeFilters?._smartSearch,
    activeFilters?._textSearch,
  ]);

  // ── Poll embedding status when search panel is open ───────────────────────

  useEffect(() => {
    if (type !== "search") return;

    const fetchStatus = async () => {
      try {
        const status = await window.electron.ipcRenderer.invoke(
          "embedding:get-status",
        );
        if (status) setSmartSearchStatus(status);
        const ocrStatus = await window.electron.ipcRenderer.invoke("ocr:get-status");
        if (ocrStatus) setTextSearchStatus(ocrStatus);
      } catch {}
    };

    fetchStatus();
    const interval = setInterval(fetchStatus, 5000);
    return () => clearInterval(interval);
  }, [type]);

  // ── Also update status in real-time via IPC event ─────────────────────────

  useEffect(() => {
    const handler = (data) => {
      if (data) {
        setSmartSearchStatus((current) => ({
          ...data,
          resource: data.resource ?? current.resource,
        }));
      }
    };
    return window.electron.ipcRenderer.on("embedding-progress", handler);
  }, []);

  useEffect(() => {
    const handler = (data) => {
      if (data) setTextSearchStatus((current) => ({ ...data, resource: data.resource ?? current.resource }));
    };
    return window.electron.ipcRenderer.on("ocr-progress", handler);
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
  const activateRelevanceSort = useCallback(() => {
    if (sortBy !== "relevance") {
      lastNonRelevanceSortRef.current = { sortBy, sortOrder };
    }
    setSortBy("relevance");
    return { sortBy: "relevance", sortOrder };
  }, [sortBy, sortOrder]);
  const restoreNonRelevanceSort = useCallback(() => {
    const previousSort = lastNonRelevanceSortRef.current;
    setSortBy(previousSort.sortBy);
    setSortOrder(previousSort.sortOrder);
    return previousSort;
  }, []);
  const resetSearch = () => {
    setSearchBy("name");
    setSearchTerm("");
    setSmartSearchTerm("");
    setTextSearchTerm("");
  };

  const resetStandardSearch = () => {
    const searchIsAlreadyClear =
      searchBy === DEFAULT_SEARCH.searchBy &&
      searchTerm === DEFAULT_SEARCH.searchTerm;
    const hasAppliedSearch =
      Boolean(String(activeFilters?.searchTerm || "").trim()) ||
      activeFilters?._smartSearch ||
      activeFilters?._textSearch;

    resetSearch();

    // When the panel already displays its default state, React has no state
    // update to trigger the normal search auto-apply effect.
    if (searchIsAlreadyClear && hasAppliedSearch) {
      onApply(DEFAULT_SEARCH);
    }
  };

  const handleExploreDate = (field, value) => {
    explore.handleDateChange(field, value);
  };
  const handleExploreYear = (year) => {
    explore.handleYearChange(year);
  };
  const handleExploreAge = (age) => {
    explore.handleAgeChange(age);
  };
  const resetExploreAll = () => {
    const filterPanelIsAlreadyClear = !hasActiveExplorerConstraint(
      explore.filters,
    );
    const appliedResultsAreFiltered = hasActiveExplorerConstraint(
      activeFilters,
    );

    explore.resetFilters();
    // No filter-state change means the auto-apply effect will not run. Apply
    // the empty filter state explicitly; App preserves sort and search.
    if (filterPanelIsAlreadyClear && appliedResultsAreFiltered) {
      onApply(EMPTY_FILTERS);
    }
  };

  // ── Smart Search ──────────────────────────────────────────────────────────

  const handleSmartSearch = useCallback(
    async (term, threshold = 0.2, topK = 200) => {
      if (!term.trim()) {
        const restoredSort = restoreNonRelevanceSort();
        onApply({
          searchBy: "smart",
          searchTerm: "",
          smartIds: null,
          smartScores: null,
          ...restoredSort,
        });
        return;
      }
      const relevanceSort = activateRelevanceSort();
      setIsSearching(true);
      try {
        const result = await window.electron.ipcRenderer.invoke(
          "embedding:search",
          {
            query: term,
            topK,
            threshold,
            filters: activeFilters || {},
            settings: settings || {},
          },
        );
        onApply({
          searchBy: "smart",
          searchTerm: term,
          smartIds: result.success ? result.results : [],
          smartScores: result.success ? result.scores : {},
          ...relevanceSort,
        });
      } catch (err) {
        console.error("Smart search error:", err);
      }
      setIsSearching(false);
    },
    [
      activeFilters,
      activateRelevanceSort,
      onApply,
      restoreNonRelevanceSort,
      settings,
    ],
  );

  const handleSmartReset = useCallback(() => {
    setSmartSearchTerm("");
    setSmartThreshold(0.2);
    setSmartTopK(200);
    const restoredSort = restoreNonRelevanceSort();
    onApply({
      searchBy: "smart",
      searchTerm: "",
      smartIds: null,
      smartScores: null,
      ...restoredSort,
    });
  }, [onApply, restoreNonRelevanceSort]);

  const handleTextSearch = useCallback(async (term) => {
    if (!term.trim()) {
      const restoredSort = restoreNonRelevanceSort();
      onApply({ searchBy: "text", searchTerm: "", textIds: null, textMatches: null, ...restoredSort });
      return;
    }
    const relevanceSort = activateRelevanceSort();
    setIsTextSearching(true);
    try {
      const result = await window.electron.ipcRenderer.invoke("ocr:search", {
        query: term,
        topK: 200,
        filters: activeFilters || {},
        settings: settings || {},
      });
      onApply({
        searchBy: "text", searchTerm: term,
        textIds: result.success ? result.results : [],
        textMatches: result.success ? result.matches : {},
        ...relevanceSort,
      });
    } catch (error) {
      console.error("Text search error:", error);
    } finally {
      setIsTextSearching(false);
    }
  }, [
    activeFilters,
    activateRelevanceSort,
    onApply,
    restoreNonRelevanceSort,
    settings,
  ]);

  const handleTextReset = useCallback(() => {
    setTextSearchTerm("");
    const restoredSort = restoreNonRelevanceSort();
    onApply({ searchBy: "text", searchTerm: "", textIds: null, textMatches: null, ...restoredSort });
  }, [onApply, restoreNonRelevanceSort]);

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
              setSortBy(e.target.value);
            }}
          >
            {(relevanceSearchActive || sortBy === "relevance") && (
              <option value="relevance">Relevance</option>
            )}
            <option value="media_id">ID</option>
            <option value="name">Name</option>
            <option value="create_date_local">Date Taken</option>
            <option value="created">Date Created</option>
            <option value="size">File Size</option>
            <option value="random">Random</option>
          </select>
          <button
            onClick={() => {
              setSortOrder("asc");
            }}
            className={sortOrder === "asc" ? "active" : ""}
          >
            Asc
          </button>
          <button
            onClick={() => {
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
              const nextSearchBy = e.target.value;
              const restoredSort = relevanceSearchActive
                ? restoreNonRelevanceSort()
                : null;
              setSearchBy(nextSearchBy);
              setSearchTerm("");
              setSmartSearchTerm("");
              setTextSearchTerm("");
              // Changing search modes clears a current relevance result and
              // restores the last ordinary sort.
              if (
                restoredSort ||
                (nextSearchBy !== "smart" && nextSearchBy !== "text")
              ) {
                onApply({
                  searchBy: nextSearchBy,
                  searchTerm: "",
                  ...(restoredSort || {}),
                });
              }
            }}
          >
            <option value="name">Name</option>
            <option value="media_id">ID</option>
            <option value="smart">Smart</option>
            <option value="text">Text</option>
            <option value="location">Location</option>
          </select>

          {searchBy !== "smart" && searchBy !== "text" ? (
            <>
              <input
                type="text"
                value={searchTerm}
                onChange={(e) => {
                  setSearchTerm(e.target.value);
                }}
                placeholder="Search..."
              />
              <div className="action-panel-reset">
                <button onClick={resetStandardSearch}>
                  <FontAwesomeIcon icon={faUndo} />
                </button>
              </div>
            </>
          ) : searchBy === "smart" ? (
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
          ) : (
            <TextSearchInput
              status={textSearchStatus}
              value={textSearchTerm}
              isSearching={isTextSearching}
              onChange={setTextSearchTerm}
              onSearch={handleTextSearch}
              onReset={handleTextReset}
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
