import React, { useEffect, useLayoutEffect, useRef, useState } from "react";

const PeopleContextMenu = ({ x, y, person, disabled, onClose, onRename, onSplit, onShowSimilar, onToggleHidden }) => {
  const menuRef = useRef(null);
  const [position, setPosition] = useState({ left: x, top: y });

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
  }, [x, y]);

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
      style={{ left: position.left, top: position.top }}
    >
      <button type="button" role="menuitem" onClick={() => onRename(person)} disabled={disabled}>
        Rename person
      </button>
      <button type="button" role="menuitem" onClick={() => onSplit(person)} disabled={disabled || Number(person.faceCount) < 2}>
        Split person
      </button>
      <button type="button" role="menuitem" onClick={() => onShowSimilar(person)} disabled={disabled}>
        Show similar
      </button>
      <button type="button" role="menuitem" onClick={() => onToggleHidden(person)} disabled={disabled}>
        {person.hidden ? "Unhide person" : "Hide person"}
      </button>
    </div>
  );
};

export default PeopleContextMenu;
