import { faCircle, faCircleCheck, faCircleXmark, faEye, faEyeSlash, faHardDrive, faXmark } from "@fortawesome/free-solid-svg-icons";
import React, { useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";

/**
 * Extracts the drive letter (Windows) or first path segment (Unix) from a folder path.
 * e.g. "D:/Photos/Vacation" → "D:"
 */
function getDriveLetter(folder) {
  const match = folder.match(/^([A-Za-z]:)/);
  return match ? match[1].toUpperCase() : null;
}

/**
 * Replaces the drive letter of a path with a custom one.
 * e.g. ("D:/Photos", "E:") → "E:/Photos"
 */
function applyDriveLetter(folder, customLetter) {
  if (!customLetter) return folder;
  const normalized = customLetter.replace(/:?$/, ":").toUpperCase();
  return folder.replace(/^[A-Za-z]:/, normalized);
}

const FolderList = ({
  folders,
  isDisabled,
  onRemoveFolder,
  folderStatuses,
  driveLetterMap = {},
  onSetDriveLetter,
  hiddenFolders = [],
  onToggleFolderVisibility,
  isOnboarding = false
}) => {
  // Track which folder row is in "edit drive letter" mode
  const [editingFolder, setEditingFolder] = useState(null);
  const [inputValue, setInputValue] = useState("");

  const handleDriveButtonClick = (folder) => {
    const existing = driveLetterMap[folder];
    if (existing) {
      // Already has a custom letter → remove it
      onSetDriveLetter(folder, null);
    } else {
      // Enter edit mode
      const current = getDriveLetter(folder) || "";
      setInputValue(current);
      setEditingFolder(folder);
    }
  };

  const commitDriveLetter = (folder) => {
    const trimmed = inputValue.trim().replace(/:?$/, "").toUpperCase();
    if (trimmed && /^[A-Z]$/.test(trimmed)) {
      onSetDriveLetter(folder, trimmed + ":");
    }
    setEditingFolder(null);
    setInputValue("");
  };

  const handleInputKeyDown = (e, folder) => {
    if (e.key === "Enter") commitDriveLetter(folder);
    if (e.key === "Escape") {
      setEditingFolder(null);
      setInputValue("");
    }
  };

  return (
    <div className="welcome-popup-selected-folders">
      <span className="welcome-popup-folders-label">Selected folders:</span>
      {folders.length > 0 ? (
        folders.map((folder, index) => {
          const customLetter = driveLetterMap[folder];
          const hasCustom = !!customLetter;
          const isHidden = hiddenFolders.includes(folder);
          const displayPath = hasCustom ? applyDriveLetter(folder, customLetter) : folder;
          const isAvailable = folderStatuses?.[displayPath];

          return (
            <div key={index} className="welcome-popup-folder-item">
              {/* Status icon */}
              <span className="welcome-popup-folder-status">
                {isAvailable === true && (
                  <span style={{ color: "var(--color-success)", marginRight: "6px" }} title="Folder available">
                    <FontAwesomeIcon icon={faCircleCheck} />
                  </span>
                )}
                {isAvailable === false && (
                  <span style={{ color: "var(--color-danger)", marginRight: "6px" }} title="Folder unavailable">
                    <FontAwesomeIcon icon={faCircleXmark} />
                  </span>
                )}
                {isAvailable === undefined && (
                  <span style={{ marginRight: "6px" }}>
                    <FontAwesomeIcon icon={faCircle} />
                  </span>
                )}
              </span>

              {/* Path (with custom drive letter applied if set) */}
              <span
                className="welcome-popup-folder-path"
                title={hasCustom ? `Original: ${folder}` : folder}
              >
                {displayPath}
              </span>

              {!isOnboarding && (
                <div>
                  {/* Drive letter edit input (inline, shown when editing) */}
                  {editingFolder === folder && (
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 4, marginLeft: 6 }}>
                      <input
                        autoFocus
                        maxLength={1}
                        value={inputValue.replace(":", "")}
                        onChange={(e) => setInputValue(e.target.value.toUpperCase())}
                        onKeyDown={(e) => handleInputKeyDown(e, folder)}
                        onBlur={() => commitDriveLetter(folder)}
                        placeholder="X"
                        style={{
                          width: 28,
                          textAlign: "center",
                          fontWeight: "bold",
                          textTransform: "uppercase",
                          background: "var(--color-surface-control)",
                          color: "var(--color-text-primary)",
                          border: "1px solid var(--color-border-default)",
                          borderRadius: 4,
                          padding: "2px 4px",
                        }}
                      />
                      <span style={{ color: "var(--color-text-muted)", fontSize: 12 }}>:</span>
                    </span>
                  )}

                  {/* Drive letter toggle button */}
                  {getDriveLetter(folder) && (
                    <button
                      className="welcome-popup-remove-folder welcome-popup-folder-action"
                      title={hasCustom ? `Remove custom drive letter (${customLetter})` : "Set custom drive letter"}
                      onClick={() => handleDriveButtonClick(folder)}
                      disabled={isDisabled}
                      style={{
                        marginRight: 4,
                        color: hasCustom ? "var(--color-text-primary)" : "var(--color-text-muted)",
                        fontWeight: hasCustom ? "bold" : "normal",
                        fontSize: 11,
                        minWidth: 28,
                        opacity: isDisabled ? 0.5 : 1,
                      }}
                    >
                      {hasCustom ? customLetter : <FontAwesomeIcon icon={faHardDrive} />}
                    </button>
                  )}

                  <button
                    className="welcome-popup-remove-folder welcome-popup-folder-action"
                    title={isHidden ? "Show source in grid" : "Hide source from grid"}
                    onClick={() => onToggleFolderVisibility?.(folder)}
                    disabled={isDisabled}
                    style={{
                      marginRight: 4,
                      color: isHidden ? "var(--color-text-muted)" : "var(--color-text-primary)",
                      fontSize: 11,
                      minWidth: 28,
                      opacity: isDisabled ? 0.5 : 1,
                    }}
                  >
                    <FontAwesomeIcon icon={isHidden ? faEyeSlash : faEye} />
                  </button>
              </div>
              )}

              {/* Remove folder button */}
              <button
                className="welcome-popup-remove-folder"
                onClick={() => onRemoveFolder(folder)}
                disabled={isDisabled}
              >
                <FontAwesomeIcon icon={faXmark} />
              </button>
            </div>
          );
        })
      ) : (
        <span>No folders selected</span>
      )}
    </div>
  );
};

export default FolderList;
