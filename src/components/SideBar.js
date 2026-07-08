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
} from "@fortawesome/free-solid-svg-icons";

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
}) => {
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
            <span className="tooltip">Sort</span>
          </button>
          <button
            className={`side-bar-btn ${actionPanelType === "filter" ? "side-bar-active" : ""}`}
            onClick={() => openActionPanel("filter")}
          >
            <FontAwesomeIcon icon={faFilter} />
            <span className="tooltip">Filter</span>
          </button>
          <button
            className={`side-bar-btn ${actionPanelType === "search" ? "side-bar-active" : ""}`}
            onClick={() => openActionPanel("search")}
          >
            <FontAwesomeIcon icon={faMagnifyingGlass} />
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
