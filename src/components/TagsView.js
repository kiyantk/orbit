import React, { useState, useEffect } from "react";
import "./TagsView.css";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faEye,
  faSquarePlus,
  faTags,
  faTrash,
  faPen,
} from "@fortawesome/free-solid-svg-icons";
import TagPill from "./TagPill";
import Popup from "./Popup";
import ConfirmPopup from "./ConfirmPopup";

const TagsView = ({ onViewTag, onAddMedia, showPopup, setShowPopup }) => {
  const [tags, setTags] = useState([]);
  const [editingTag, setEditingTag] = useState(null); // track if editing
  const [tagData, setTagData] = useState({
    name: "",
    description: "",
    color: "#d3d3d3",
  });
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [newTag, setNewTag] = useState({
    name: "",
    description: "",
    color: "#d3d3d3",
  });

  useEffect(() => {
    window.electron.ipcRenderer.invoke("tags:get-all").then(setTags);
  }, []);

  useEffect(() => {
    if (!showPopup) return;
    if (showPopup.type === "add") {
      setEditingTag(null);
      setNewTag({ name: "", description: "", color: "#d3d3d3" });
    }
  }, [showPopup]);

  const handleSaveTag = async () => {
    if (!newTag.name.trim()) return;

    const payload = {
      ...newTag,
      id: editingTag?.id || null,
      media_ids: editingTag?.media_ids || [], // preserve existing media links
    };

    await window.electron.ipcRenderer.invoke("tags:save", payload);

    // Refresh list
    const updated = await window.electron.ipcRenderer.invoke("tags:get-all");
    setTags(updated);

    // reset state
    setNewTag({ name: "", description: "", color: "#d3d3d3" });
    setEditingTag(null);
    setShowPopup({ value: false, type: "" });
  };

  const handleDeleteTag = async (id) => {
    await window.electron.ipcRenderer.invoke("tags:delete", id);
    const updated = await window.electron.ipcRenderer.invoke("tags:get-all");
    setTags(updated);
    setConfirmDelete(null);
  };

  const handleEditTag = (tag) => {
    setEditingTag(tag); // remember which tag is being edited
    setNewTag({
      // prefill form with its data
      name: tag.name,
      description: tag.description,
      color: tag.color,
    });
    setShowPopup({ value: true, type: "edit" }); // open the modal
  };

  return (
    <div className="tags-view">
      {/* Table */}
      <table className="tags-table">
        <thead>
          <tr>
            <th>Tag</th>
            <th>Description</th>
            <th>Media Count</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {tags.map((tag) => (
            <tr key={tag.id}>
              <td>
                <TagPill tag={tag} />
              </td>
              <td className="tag-description" title={tag.description}>
                {tag.description}
              </td>
              <td>{tag.media_ids.length}</td>
              <td className="actions">
                <button
                  className="btn btn-primary"
                  onClick={() => onViewTag(tag)}
                >
                  <FontAwesomeIcon icon={faEye} />
                </button>

                <button
                  className="btn btn-primary"
                  onClick={() => onAddMedia(tag)}
                >
                  <FontAwesomeIcon icon={faSquarePlus} />
                </button>
                <button
                  onClick={() => handleEditTag(tag)}
                  className="btn btn-primary"
                >
                  <FontAwesomeIcon icon={faPen} />
                </button>
                <button
                  onClick={() => setConfirmDelete(tag)}
                  className="btn btn-danger"
                >
                  <FontAwesomeIcon icon={faTrash} />
                </button>
              </td>
            </tr>
          ))}
          {tags.length === 0 && (
            <tr>
              <td colSpan="4" className="no-tags">
                No tags created yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {/* Create/Edit Popup */}
      {showPopup && showPopup.value && (
        <Popup
          title={editingTag ? "Edit Tag" : "Create New Tag"}
          actions={[
            {
              label: "Cancel",
              kind: "secondary",
              onClick: () => {
                setShowPopup(false);
                setEditingTag(null);
              },
            },
            {
              label: editingTag ? "Save" : "Create",
              kind: "primary",
              onClick: handleSaveTag,
            },
          ]}
        >
          <input
            type="text"
            placeholder="Name"
            className="input"
            maxLength={30}
            value={newTag.name}
            onChange={(e) => setNewTag({ ...newTag, name: e.target.value })}
          />
          <textarea
            placeholder="Description"
            className="textarea"
            maxLength={100}
            value={newTag.description}
            onChange={(e) =>
              setNewTag({ ...newTag, description: e.target.value })
            }
          />
          <div className="color-picker">
            <label>Color:</label>
            <input
              type="color"
              value={newTag.color}
              onChange={(e) => setNewTag({ ...newTag, color: e.target.value })}
            />
          </div>
          <div className="tag-preview">
            <span className="tag-preview-label">Preview:</span>
            <TagPill
              tag={{
                name: newTag.name || "Example Tag",
                color: newTag.color,
                description: newTag.description,
              }}
            />
          </div>
        </Popup>
      )}

      {confirmDelete && (
        <ConfirmPopup
          title="Delete Tag"
          message={
            <>
              Are you sure you want to delete tag{" "}
              <strong>{confirmDelete.name}</strong>?
            </>
          }
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => handleDeleteTag(confirmDelete.id)}
        />
      )}
    </div>
  );
};

export default TagsView;
