import React, { useState } from "react";
import Popup from "./Popup";

const HeicPopup = ({ missingFiles, onClose }) => {
  const [status, setStatus] = useState("");
  const isFinished = status === "Thumbnails applied successfully!";

  // Generate script & JSON via Electron
  const handleGetScript = async () => {
    try {
      setStatus("Generating Python script & JSON...");
      const result = await window.electron.ipcRenderer.invoke(
        "generate-heic-script",
        missingFiles,
      );
      if (result.success) {
        setStatus("Script & JSON ready! Check your app's data folder.");
      } else {
        setStatus(`Error: ${result.error}`);
      }
    } catch (err) {
      console.error(err);
      setStatus("Failed to generate script & JSON.");
    }
  };

  // Apply thumbnails to database
  const handleApplyToDatabase = async () => {
    try {
      setStatus("Applying thumbnails to database...");
      const result = await window.electron.ipcRenderer.invoke(
        "apply-heic-thumbnails",
        missingFiles,
      );
      if (result.success) {
        setStatus("Thumbnails applied successfully!");
      } else {
        setStatus(`Error: ${result.error}`);
      }
    } catch (err) {
      console.error(err);
      setStatus("Failed to apply thumbnails.");
    }
  };

  // Cleanup when closing popup
  const handleClose = async () => {
    try {
      await window.electron.ipcRenderer.invoke("cleanup-heic-temp");
    } catch (err) {
      console.error("Cleanup failed:", err);
    }
    onClose();
  };

  return (
    <Popup
      title="Generate HEIC Thumbnails"
      width="60%"
      contentWidth="90%"
      bodyStyle={{ placeItems: "center" }}
      actions={[
        {
          label: isFinished ? "Close" : "Cancel",
          kind: "secondary",
          onClick: handleClose,
        },
      ]}
    >
      <p>
        Orbit can help you generate thumbnails for <strong>HEIC</strong> images.
        Creating them directly inside Orbit would be too slow, so we provide a
        small Python script you can run locally to generate them much faster.
        <br />
        <br />
        <strong>Before you start:</strong> Make sure you have{" "}
        <strong>Python 3</strong> installed, then run this command in a terminal
        to install the required libraries:
        <br />
        <code>pip install Pillow pillow-heif</code>
        <br />
        <br />
        <strong>Steps:</strong>
      </p>
      <ol style={{ textAlign: "left", margin: "0 auto", maxWidth: "500px" }}>
        <li>
          Click <em>Get Script & JSON</em> to generate a helper script and a
          JSON file listing the missing HEIC files.
        </li>
        <li>
          Run the script with Python — it will create thumbnails and place them
          in a <code>/thumbs</code> folder.
        </li>
        <li>
          Copy the generated thumbnails from <code>/thumbs</code> into your
          Orbit <code>/thumbnails</code> folder.
        </li>
        <li>
          Back in Orbit, click <em>Apply to database</em> to link the new
          thumbnails.
        </li>
      </ol>
      <br />
      <p>
        <em>Note:</em> Your original HEIC files are never modified — only small
        JPEG thumbnails are created.
      </p>

      <div style={{ display: "flex", gap: "10px", marginTop: "15px" }}>
        <button
          className="welcome-popup-select-folders-btn welcome-popup-select-folders-btn-margin"
          onClick={handleGetScript}
        >
          Get Script & JSON
        </button>
        <button
          className="welcome-popup-select-folders-btn welcome-popup-select-folders-btn-margin"
          onClick={handleApplyToDatabase}
          disabled={missingFiles.length === 0}
        >
          Apply to database
        </button>
      </div>

      {status && (
        <div className="welcome-popup-status" style={{ marginTop: "10px" }}>
          <span>{status}</span>
        </div>
      )}

      <span style={{ fontSize: "12px" }}>
        {isFinished
          ? "You can now safely close this window"
          : "Pressing cancel deletes the script & JSON"}
      </span>
    </Popup>
  );
};

export default HeicPopup;
