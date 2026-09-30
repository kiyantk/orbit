import React from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faChartSimple,
  faCircleDot,
  faCircleNodes,
  faFilter,
  faFire,
  faGear,
  faGlobe,
  faLocationDot,
  faMagnifyingGlass,
  faMap,
  faPanorama,
  faPenToSquare,
  faPhotoFilm,
  faPlus,
  faShuffle,
  faSliders,
  faSort,
  faTags,
  faTrash,
  faUser,
  faUserGroup,
  faUsers,
} from "@fortawesome/free-solid-svg-icons";

const isSearchActive = (filters) => {
  const activeFilters = filters || {};
  return (
    Boolean(String(activeFilters.searchTerm || "").trim()) ||
    Boolean(activeFilters._smartSearch || activeFilters._textSearch)
  );
};

const isFilterActive = (filters) => {
  const activeFilters = filters || {};
  const searchIsActive = isSearchActive(activeFilters);

  return Object.entries(activeFilters).some(([key, value]) => {
    if (
      [
        "searchBy",
        "searchTerm",
        "sortBy",
        "sortOrder",
        "tagMatch",
        "_smartSearch",
        "_smartScores",
        "_textSearch",
        "_textMatches",
        "_similarTo",
      ].includes(key)
    ) {
      return false;
    }

    // Search result IDs support a search rather than constituting a separate
    // filter. IDs supplied by another view still indicate an active filter.
    if (key === "ids" && searchIsActive) return false;

    if (Array.isArray(value)) return value.length > 0;
    return value !== null && value !== undefined && value !== "" && value !== false;
  });
};

const isSortActive = (filters, defaultSort = "media_id") => {
  const activeFilters = filters || {};
  return (
    activeFilters.sortBy != null &&
    (activeFilters.sortBy !== defaultSort ||
      (activeFilters.sortOrder || "desc") !== "desc")
  );
};

const SideBar = ({
  activeView,
  activeViewChanged,
  openActionPanel,
  actionPanelType,
  mapViewType,
  switchMapViewType,
  switchMemoryMode,
  memoryMode,
  showTagPopup,
  setShowTagPopup,
  filters,
  shuffleFilters,
  mapFilters,
  settings,
}) => {
  const explorerSearchActive = isSearchActive(filters);
  const explorerFilterActive = isFilterActive(filters);
  const explorerSortActive = isSortActive(filters, settings?.defaultSort ?? "media_id");
  const shuffleFilterActive = isFilterActive(shuffleFilters);
  const mapFilterActive = isFilterActive(mapFilters);

  const switchView = (type) => {
    activeViewChanged(type);
  };

  return (
    <div className="side-bar">
      <button
        className={`side-bar-btn ${activeView === "explore" ? "side-bar-active" : ""}`}
        onClick={() => switchView("explore")}
      >
        <FontAwesomeIcon icon={faPhotoFilm} />
        <span className="tooltip">Explore</span>
      </button>
      <button
        className={`side-bar-btn ${activeView === "map" ? "side-bar-active" : ""}`}
        onClick={() => switchView("map")}
      >
        <FontAwesomeIcon icon={faMap} />
        <span className="tooltip">Map</span>
      </button>
      <button
        className={`side-bar-btn ${activeView === "stats" ? "side-bar-active" : ""}`}
        onClick={() => switchView("stats")}
      >
        <FontAwesomeIcon icon={faChartSimple} />
        <span className="tooltip">Stats</span>
      </button>
      <button
        className={`side-bar-btn ${activeView === "shuffle" ? "side-bar-active" : ""}`}
        onClick={() => switchView("shuffle")}
      >
        <FontAwesomeIcon icon={faShuffle} />
        <span className="tooltip">Shuffle</span>
      </button>
      <button
        className={`side-bar-btn ${activeView === "memories" ? "side-bar-active" : ""}`}
        onClick={() => switchView("memories")}
      >
        <FontAwesomeIcon icon={faPanorama} />
        <span className="tooltip">Memories</span>
      </button>
      <button
        className={`side-bar-btn ${activeView === "places" ? "side-bar-active" : ""}`}
        onClick={() => switchView("places")}
      >
        <FontAwesomeIcon icon={faLocationDot} />
        <span className="tooltip">Places</span>
      </button>
      <button
        className={`side-bar-btn ${activeView === "people" ? "side-bar-active" : ""}`}
        onClick={() => switchView("people")}
      >
        <FontAwesomeIcon icon={faUser} />
        <span className="tooltip">People</span>
      </button>
      <button
        className={`side-bar-btn ${activeView === "tags" ? "side-bar-active" : ""}`}
        onClick={() => switchView("tags")}
      >
        <FontAwesomeIcon icon={faTags} />
        <span className="tooltip">Tags</span>
      </button>
      <button
        className={`side-bar-btn ${activeView === "settings" ? "side-bar-active" : ""}`}
        onClick={() => switchView("settings")}
      >
        <FontAwesomeIcon icon={faGear} />
        <span className="tooltip">Settings</span>
      </button>
      {activeView === "explore" && (
        <div className="side-bar-bottom">
          <button
            className={`side-bar-btn ${actionPanelType === "sort" ? "side-bar-active" : ""}`}
            onClick={() => openActionPanel("sort")}
          >
            <FontAwesomeIcon icon={faSort} />
            {explorerSortActive && <span className="side-bar-activity-indicator" />}
            <span className="tooltip">Sort</span>
          </button>
          <button
            className={`side-bar-btn ${actionPanelType === "filter" ? "side-bar-active" : ""}`}
            onClick={() => openActionPanel("filter")}
          >
            <FontAwesomeIcon icon={faFilter} />
            {explorerFilterActive && <span className="side-bar-activity-indicator" />}
            <span className="tooltip">Filter</span>
          </button>
          <button
            className={`side-bar-btn ${actionPanelType === "search" ? "side-bar-active" : ""}`}
            onClick={() => openActionPanel("search")}
          >
            <FontAwesomeIcon icon={faMagnifyingGlass} />
            {explorerSearchActive && <span className="side-bar-activity-indicator" />}
            <span className="tooltip">Search</span>
          </button>
        </div>
      )}
      {activeView === "shuffle" && (
        <div className="side-bar-bottom">
          <button
            className={`side-bar-btn ${actionPanelType === "shuffle-filter" ? "side-bar-active" : ""}`}
            onClick={() => openActionPanel("shuffle-filter")}
          >
            <FontAwesomeIcon icon={faFilter} />
            {shuffleFilterActive && <span className="side-bar-activity-indicator" />}
            <span className="tooltip">Filter</span>
          </button>
          <button
            className={`side-bar-btn ${actionPanelType === "shuffle-settings" ? "side-bar-active" : ""}`}
            onClick={() => openActionPanel("shuffle-settings")}
          >
            <FontAwesomeIcon icon={faSliders} />
            <span className="tooltip">Shuffle Settings</span>
          </button>
        </div>
      )}
      {activeView === "map" && (
        <div className="side-bar-bottom">
          <button
            className={`side-bar-btn ${mapViewType === "cluster" ? "side-bar-active" : ""}`}
            onClick={() => switchMapViewType("cluster")}
          >
            <FontAwesomeIcon icon={faCircleDot} />
            <span className="tooltip">Cluster Mode</span>
          </button>
          <button
            className={`side-bar-btn ${mapViewType === "heatmap" ? "side-bar-active" : ""}`}
            onClick={() => switchMapViewType("heatmap")}
          >
            <FontAwesomeIcon icon={faFire} />
            <span className="tooltip">Heatmap Mode</span>
          </button>
          <button
            className={`side-bar-btn ${mapViewType === "line" ? "side-bar-active" : ""}`}
            onClick={() => switchMapViewType("line")}
          >
            <FontAwesomeIcon icon={faCircleNodes} />
            <span className="tooltip">Line Mode</span>
          </button>
          <button
            className={`side-bar-btn ${mapViewType === "countries" ? "side-bar-active" : ""}`}
            onClick={() => switchMapViewType("countries")}
          >
            <FontAwesomeIcon icon={faGlobe} />
            <span className="tooltip">Country Mode</span>
          </button>
          <button
            className={`side-bar-btn ${actionPanelType === "map-filter" ? "side-bar-active" : ""}`}
            onClick={() => openActionPanel("map-filter")}
          >
            <FontAwesomeIcon icon={faFilter} />
            {mapFilterActive && <span className="side-bar-activity-indicator" />}
            <span className="tooltip">Filter</span>
          </button>
        </div>
      )}
      {activeView === "memories" && (
        <div className="side-bar-bottom">
          <button
            className={`side-bar-btn ${memoryMode === "new" ? "side-bar-active" : ""}`}
            onClick={() => switchMemoryMode("new")}
          >
            <FontAwesomeIcon icon={faPlus} />
            <span className="tooltip">New Memory</span>
          </button>
          <button
            className={`side-bar-btn ${memoryMode === "edit" ? "side-bar-active" : ""}`}
            onClick={() =>
              switchMemoryMode(memoryMode !== "edit" ? "edit" : null)
            }
          >
            <FontAwesomeIcon icon={faPenToSquare} />
            <span className="tooltip">Edit a Memory</span>
          </button>
        </div>
      )}
      {activeView === "tags" && (
        <div className="side-bar-bottom">
          <button
            className={`side-bar-btn ${showTagPopup.type === "add" ? "side-bar-active" : ""}`}
            onClick={() => setShowTagPopup({ value: true, type: "add" })}
          >
            <FontAwesomeIcon icon={faPlus} />
            <span className="tooltip">New Tag</span>
          </button>
        </div>
      )}
    </div>
  );
};

export default SideBar;
