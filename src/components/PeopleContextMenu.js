import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faArrowRight } from "@fortawesome/free-solid-svg-icons";

const PeopleContextMenu = ({ x, y, person, disabled, onClose, onRename, onSplit, onShowSimilar, onToggleHidden, onViewWith }) => {
  const menuRef = useRef(null);
  const [position, setPosition] = useState({ left: x, top: y });
  const [showViewWith, setShowViewWith] = useState(false);
  const viewDisabled = disabled || !person.fileIds?.length;

  useLayoutEffect(() => {
    const updatePosition = () => {
      const menu = menuRef.current;
      if (!menu) return;
      const margin = 8;
      setPosition({
        left: Math.max(margin, Math.min(x, window.innerWidth - menu.offsetWidth - margin)),
        top: Math.max(margin, Math.min(y, window.innerHeight - menu.offsetHeight - margin)),
      });
    };
    updatePosition();
    window.addEventListener("resize", updatePosition);
    return () => window.removeEventListener("resize", updatePosition);
  }, [x, y, showViewWith]);

  useEffect(() => {
    const closeOnOutsideClick = (event) => {
      if (menuRef.current && !menuRef.current.contains(event.target)) onClose();
    };
    document.addEventListener("mousedown", closeOnOutsideClick);
    return () => document.removeEventListener("mousedown", closeOnOutsideClick);
  }, [onClose]);

  return (
    <div
      ref={menuRef}
      className="people-context-menu"
      role="menu"
      style={{ left: position.left, top: position.top, width: "auto", padding: 0, display: "flex" }}
      onMouseLeave={() => setShowViewWith(false)}
    >
      <div style={{ minWidth: 180, maxWidth: 180, padding: "6px 0" }}>
        <button type="button" role="menuitem" onMouseEnter={() => setShowViewWith(false)} onClick={() => onRename(person)} disabled={disabled}>
          Rename person
        </button>
        <button type="button" role="menuitem" onMouseEnter={() => setShowViewWith(false)} onClick={() => onSplit(person)} disabled={disabled || Number(person.faceCount) < 2}>
          Split person
        </button>
        <button type="button" role="menuitem" onMouseEnter={() => setShowViewWith(false)} onClick={() => onShowSimilar(person)} disabled={disabled}>
          Show similar
        </button>
        <button
          type="button"
          role="menuitem"
          aria-haspopup="menu"
          aria-expanded={showViewWith}
          onMouseEnter={() => setShowViewWith(true)}
          disabled={viewDisabled}
          style={{
            background: showViewWith ? "#2d2a35" : "transparent",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          View with <FontAwesomeIcon icon={faArrowRight} />
        </button>
        <button type="button" role="menuitem" onMouseEnter={() => setShowViewWith(false)} onClick={() => onToggleHidden(person)} disabled={disabled}>
          {person.hidden ? "Unhide person" : "Hide person"}
        </button>
      </div>
      {showViewWith && (
        <div
          className="context-menu-submenu"
          role="menu"
          style={{ minWidth: 150, background: "#2d2a35", borderLeft: "1px solid #3a3645", padding: "6px 0" }}
        >
          {["Explorer", "Shuffle", "Map"].map((view) => (
            <button
              className="context-menu-item"
              key={view}
              type="button"
              role="menuitem"
              onClick={() => {
                onViewWith(person, view.toLowerCase());
                onClose();
              }}
            >
              {view}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

export default PeopleContextMenu;
