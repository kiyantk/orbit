import React, { useState, useEffect } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faPhotoFilm,
  faMagnifyingGlass,
  faLocationDot,
  faPanorama,
  faUserGroup,
  faTag,
} from "@fortawesome/free-solid-svg-icons";

const COUNT_VIEWS = new Set(["explore", "map", "memories", "places", "people", "tags"]);
const VIEW_ICONS = {
  explore: faPhotoFilm,
  map: faLocationDot,
  memories: faPanorama,
  places: faLocationDot,
  people: faUserGroup,
  tags: faTag,
};

const BottomBar = ({ explorerScale, filteredCount, activeView, viewCount }) => {

  const [photoCount, setPhotoCount] = useState(0);
  const fetchPhotoCount = async () => {
    try {
      if (window.electron.ipcRenderer) {
        const count = await window.electron.ipcRenderer.invoke("get-indexed-files-count");
        setPhotoCount(count);
      }
    } catch (err) {
      console.error("Failed to fetch photo count:", err);
    }
  };
// Fetch photo count
  useEffect(() => {
    fetchPhotoCount();

    // Optional: refresh count every 10s
    const interval = setInterval(fetchPhotoCount, 10000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    fetchPhotoCount();
  }, [filteredCount]);

  const count = activeView === "explore"
    ? { total: photoCount, filtered: filteredCount }
    : viewCount;
  const hasCount = COUNT_VIEWS.has(activeView) && count && Number.isFinite(count.total);
  const hasFilteredCount =
    hasCount &&
    Number.isFinite(count.filtered) &&
    count.filtered !== count.total;
  const countIcon = VIEW_ICONS[activeView];

  return (
    <div className="bottom-bar">
      <div className="bottom-bar-left">
        {hasCount && (
          <div className="bottom-bar-media-counter">
            <FontAwesomeIcon icon={countIcon} />
            <span>{count.total} {hasFilteredCount ? `(${count.filtered})` : ""}</span>
          </div>
        )}
      </div>

      <div className="bottom-bar-right">
        { activeView === "explore" && Number(explorerScale) !== 1 ? (
          <div className="bottom-bar-scale-counter">
            <FontAwesomeIcon icon={faMagnifyingGlass} />
            <span>{Number(explorerScale * 100).toFixed(0) + '%'}</span>
          </div>
        ) : ('') }
      </div>
    </div>
  );
};

export default BottomBar;
