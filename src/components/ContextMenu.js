import React, { useEffect, useRef, useState } from "react";
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
}) => {
  const menuRef = useRef(null);
  const [showTags, setShowTags] = useState(false);
  const [tags, setTags] = useState([]);
  const [showRemoveConfirm, setShowRemoveConfirm] = useState(false);
  const [hasEmbedding, setHasEmbedding] = useState(false);

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

  // Toggle tag assignment for current item
  const handleTagToggle = async (tag) => {
    const isTagged = Array.isArray(tag.media_ids)
      ? tag.media_ids.includes(item.id)
      : false;

    if (isTagged) {
      // Untag
      await window.electron.ipcRenderer.invoke("tag:remove-item", {
        tagId: tag.id,
        mediaId: item.id,
      });
      setTags((prev) =>
        prev.map((t) =>
          t.id === tag.id
            ? { ...t, media_ids: t.media_ids.filter((id) => id !== item.id) }
            : t,
        ),
      );
    } else {
      // Tag
      await window.electron.ipcRenderer.invoke("tag:add-item", {
        tagId: tag.id,
        mediaId: item.id,
      });
      setTags((prev) =>
        prev.map((t) =>
          t.id === tag.id
            ? { ...t, media_ids: [...(t.media_ids || []), item.id] }
            : t,
        ),
      );
    }
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
        top: y,
        left: x,
        height: "200px",
        backgroundColor: "#1c1a22",
        color: "white",
        border: "1px solid #3a3645",
        borderRadius: 6,
        zIndex: 2000,
        boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
        display: "flex",
        userSelect: "none",
      }}
      onMouseLeave={() => setShowTags(false)}
    >
      {/* Main context menu */}
      <div
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
            cursor: "pointer",
            whiteSpace: "nowrap",
            textAlign: "left",
          }}
          className="context-menu-item"
          onMouseEnter={() => setShowTags(false)}
          onClick={() => revealFromCtx()}
        >
          Reveal in all
        </div>
        <div
          style={{
            padding: "6px 12px",
            cursor: hasEmbedding ? "pointer" : "default",
            whiteSpace: "nowrap",
            textAlign: "left",
            opacity: hasEmbedding ? 1 : 0.4,
          }}
          className={hasEmbedding ? "context-menu-item" : ""}
          onMouseEnter={() => setShowTags(false)}
          onClick={() => {
            if (!hasEmbedding) return;
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
          onMouseEnter={() => setShowTags(true)}
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
            color: "rgb(166 49 49)",
          }}
          className="context-menu-item"
          onMouseEnter={() => setShowTags(false)}
          onClick={() => setShowRemoveConfirm(true)}
        >
          Remove
        </div>
        <span className="context-menu-filename">{item.filename}</span>
      </div>

      {/* Tag submenu */}
      {showTags && (
        <div
          style={{
            minWidth: 200,
            maxHeight: 200,
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
            const isTagged = Array.isArray(tag.media_ids)
              ? tag.media_ids.includes(item.id)
              : false;

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

      {showRemoveConfirm && (
        <ConfirmPopup
          title="Remove item"
          message={
            <>
              Are you sure you want to remove
              <br />
              <strong>{item.filename}</strong>
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
            onRemoveItem(item.id);
            setShowRemoveConfirm(false);
            onClose();
          }}
        />
      )}
    </div>
  );
};

export default ContextMenu;
