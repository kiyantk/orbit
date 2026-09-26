import React from "react";
import Popup from "./Popup";

const ConfirmPopup = ({
  title = "Are you sure?",
  message,
  subMessage,
  confirmLabel = "Yes",
  cancelLabel = "No",
  danger = true,
  confirmButtonStyle,
  onConfirm,
  onCancel,
}) => (
  <Popup
    title={title}
    width="50%"
    actions={[
      { label: cancelLabel, kind: "secondary", onClick: onCancel },
      {
        label: confirmLabel,
        kind: danger ? "danger" : "primary",
        onClick: onConfirm,
        style: confirmButtonStyle,
      },
    ]}
  >
    <span style={{ color: "var(--color-text-secondary)" }}>
      {message}
      {subMessage && (
        <>
          <br />
          <br />
          <strong>{subMessage}</strong>
        </>
      )}
    </span>
  </Popup>
);

export default ConfirmPopup;
