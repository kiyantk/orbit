import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faArrowRight } from "@fortawesome/free-solid-svg-icons";
import TagPill from "./TagPill";
import ConfirmPopup from "./ConfirmPopup";

const ContextMenu = ({
  x,
  y,
  item,
  onClose,
  revealFromContextMenu,
  onRemoveItem,
  onFindSimilar,
  activePersonId,
  onPersonAction,
  selectedItemIds = [],
}) => {
  const menuRef = useRef(null);
  const mainMenuRef = useRef(null);
  const [showTags, setShowTags] = useState(false);
  const [showPerson, setShowPerson] = useState(false);
  const [tags, setTags] = useState([]);
  const [showRemoveConfirm, setShowRemoveConfirm] = useState(false);
  const [hasEmbedding, setHasEmbedding] = useState(false);
  const [position, setPosition] = useState({ left: x, top: y });
  const [mainMenuHeight, setMainMenuHeight] = useState(0);
  const itemIds = selectedItemIds.length ? selectedItemIds : [item.id];
  const isMultiSelection = itemIds.length > 1;

  useLayoutEffect(() => {
    const updatePosition = () => {
      const menu = menuRef.current;
      if (!menu) return;

      const margin = 8;
      const left = Math.max(
        margin,
        Math.min(x, window.innerWidth - menu.offsetWidth - margin),
      );
      const top = Math.max(
        margin,
        Math.min(y, window.innerHeight - menu.offsetHeight - margin),
      );

      setPosition((current) =>
        current.left === left && current.top === top ? current : { left, top },
      );
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    return () => window.removeEventListener("resize", updatePosition);
  }, [x, y, showTags, showPerson]);

  useLayoutEffect(() => {
    const menu = mainMenuRef.current;
    if (!menu) return undefined;

    const updateHeight = () => {
      const nextHeight = menu.offsetHeight;
      setMainMenuHeight((current) =>
        current === nextHeight ? current : nextHeight,
      );
    };

    updateHeight();
    const observer = new ResizeObserver(updateHeight);
    observer.observe(menu);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [onClose]);

  useEffect(() => {
    window.electron.ipcRenderer
      .invoke("embedding:has-embedding", item.id)
      .then(setHasEmbedding);
  }, [item.id]);

  // Load tags when submenu opens
  useEffect(() => {
    if (showTags) {
      window.electron.ipcRenderer.invoke("tags:get-all").then((res) => {
        setTags(res || []);
      });
    }
  }, [showTags]);

  // A tag is checked only when every selected item has it. Turning on a
  // partially assigned tag fills in the missing assignments; turning it off
  // removes it from the complete selection.
  const handleTagToggle = async (tag) => {
    const taggedIds = new Set(tag.media_ids || []);
    const isTaggedForAll = itemIds.every((id) => taggedIds.has(id));
    const idsToUpdate = isTaggedForAll
      ? itemIds
      : itemIds.filter((id) => !taggedIds.has(id));
    const channel = isTaggedForAll ? "tag:remove-item" : "tag:add-item";

    await Promise.all(idsToUpdate.map((mediaId) =>
      window.electron.ipcRenderer.invoke(channel, { tagId: tag.id, mediaId }),
    ));

    setTags((prev) => prev.map((t) => {
      if (t.id !== tag.id) return t;
      const mediaIds = new Set(t.media_ids || []);
      idsToUpdate.forEach((id) => {
        if (isTaggedForAll) mediaIds.delete(id);
        else mediaIds.add(id);
      });
      return { ...t, media_ids: [...mediaIds] };
    }));
  };

  const revealFromCtx = () => {
    revealFromContextMenu(item);
    onClose();
  };

  return (
    <div
      ref={menuRef}
      style={{
        position: "fixed",
        top: position.top,
        left: position.left,
        backgroundColor: "#1c1a22",
        color: "white",
        border: "1px solid #3a3645",
        borderRadius: 6,
        zIndex: 2000,
        boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
        display: "flex",
        userSelect: "none",
      }}
      onMouseLeave={() => { setShowTags(false); setShowPerson(false); }}
    >
      {/* Main context menu */}
      <div
        ref={mainMenuRef}
        style={{
          minWidth: 150,
          padding: "6px 0px 24px 0px",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div
          style={{
            padding: "6px 12px",
            cursor: isMultiSelection ? "default" : "pointer",
            whiteSpace: "nowrap",
            textAlign: "left",
            opacity: isMultiSelection ? 0.4 : 1,
          }}
          className={isMultiSelection ? "" : "context-menu-item"}
          onMouseEnter={() => { setShowTags(false); setShowPerson(false); }}
          onClick={() => !isMultiSelection && revealFromCtx()}
        >
          Reveal in all
        </div>
        <div
          style={{
            padding: "6px 12px",
            cursor: hasEmbedding && !isMultiSelection ? "pointer" : "default",
            whiteSpace: "nowrap",
            textAlign: "left",
            opacity: hasEmbedding && !isMultiSelection ? 1 : 0.4,
          }}
          className={hasEmbedding && !isMultiSelection ? "context-menu-item" : ""}
          onMouseEnter={() => { setShowTags(false); setShowPerson(false); }}
          onClick={() => {
            if (!hasEmbedding || isMultiSelection) return;
            onFindSimilar(item);
            onClose();
          }}
        >
          Find similar
        </div>
        <div
          style={{
            padding: "6px 12px",
            cursor: "pointer",
            whiteSpace: "nowrap",
            textAlign: "left",
            backgroundColor: showTags ? "#2d2a35" : "transparent",
          }}
          className="context-menu-item"
          onMouseEnter={() => { setShowTags(true); setShowPerson(false); }}
        >
          Add Tag{" "}
          <FontAwesomeIcon style={{ float: "right" }} icon={faArrowRight} />
        </div>
        <div
          style={{
            padding: "6px 12px",
            cursor: "pointer",
            whiteSpace: "nowrap",
            textAlign: "left",
            backgroundColor: showPerson ? "#2d2a35" : "transparent",
          }}
          className="context-menu-item"
          onMouseEnter={() => { setShowPerson(true); setShowTags(false); }}
        >
          Person <FontAwesomeIcon style={{ float: "right" }} icon={faArrowRight} />
        </div>
        <div
          style={{
            padding: "6px 12px",
            cursor: "pointer",
            whiteSpace: "nowrap",
            textAlign: "left",
            color: "#ff6b6b",
          }}
          className="context-menu-item"
          onMouseEnter={() => { setShowTags(false); setShowPerson(false); }}
          onClick={() => setShowRemoveConfirm(true)}
        >
          Remove
        </div>
        <span className="context-menu-filename">
          {isMultiSelection ? `${itemIds.length} items selected` : item.filename}
        </span>
      </div>

      {/* Tag submenu */}
      {showTags && (
        <div
          className="context-menu-submenu"
          style={{
            minWidth: 200,
            height: mainMenuHeight || undefined,
            maxHeight: mainMenuHeight || 200,
            boxSizing: "border-box",
            overflowY: "auto",
            backgroundColor: "#2d2a35",
            borderLeft: "1px solid #3a3645",
            padding: "6px 0",
          }}
        >
          {tags.length === 0 && (
            <div style={{ padding: "6px 12px", opacity: 0.6 }}>
              No tags found
            </div>
          )}
          {tags.map((tag) => {
            const isTagged = itemIds.every((id) =>
              Array.isArray(tag.media_ids) && tag.media_ids.includes(id),
            );

            return (
              <label
                key={tag.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "4px 12px",
                  cursor: "pointer",
                }}
              >
                <input
                  type="checkbox"
                  checked={isTagged}
                  onChange={() => handleTagToggle(tag)}
                />
                <TagPill tag={tag} style={{ marginRight: 4 }} />
              </label>
            );
          })}
        </div>
      )}

      {showPerson && (
        <div
          className="context-menu-submenu"
          style={{
            minWidth: 190,
            backgroundColor: "#2d2a35",
            borderLeft: "1px solid #3a3645",
            padding: "6px 0",
          }}
        >
          <div className="context-menu-item" style={{ padding: "6px 12px", opacity: isMultiSelection ? 0.4 : 1, cursor: isMultiSelection ? "default" : "pointer" }} onClick={() => !isMultiSelection && onPersonAction("add-to-person", item, itemIds)}>
            Add to person
          </div>
          {activePersonId && (
            <>
              <div className="context-menu-item" style={{ padding: "6px 12px" }} onClick={() => onPersonAction("separate", item, itemIds)}>
                Separate from person
              </div>
              <div className="context-menu-item" style={{ padding: "6px 12px", opacity: isMultiSelection ? 0.4 : 1, cursor: isMultiSelection ? "default" : "pointer" }} onClick={() => !isMultiSelection && onPersonAction("set-avatar", item, itemIds)}>
                Set as avatar
              </div>
              <div className="context-menu-item" style={{ padding: "6px 12px" }} onClick={() => onPersonAction("not-same-person", item, itemIds)}>
                Not the same person
              </div>
            </>
          )}
          {activePersonId && (
            <div className="context-menu-item" style={{ padding: "6px 12px", color: "#ff9a9a" }} onClick={() => onPersonAction("hide-not-face", item, itemIds)}>
              Hide / Not a face
            </div>
          )}
        </div>
      )}

      {showRemoveConfirm && (
        <ConfirmPopup
          title="Remove item"
          message={
            <>
              Are you sure you want to remove
              <br />
              <strong>{isMultiSelection ? `${itemIds.length} selected items` : item.filename}</strong>
              <br />
              from the index?
              <br />
              <br />
              This does not delete the original file.
              <br />
              This action cannot be undone.
            </>
          }
          confirmButtonStyle={{ backgroundColor: "rgb(166 49 49)" }}
          onCancel={() => setShowRemoveConfirm(false)}
          onConfirm={() => {
            onRemoveItem(itemIds);
            setShowRemoveConfirm(false);
            onClose();
          }}
        />
      )}
    </div>
  );
};

export default ContextMenu;
