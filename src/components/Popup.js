import React from "react";

const KIND_CLASS = {
  primary: "settings-save-btn",
  danger: "settings-save-btn",
  secondary: "settings-cancel-btn",
};

const KIND_STYLE = {
  secondary: { backgroundColor: "var(--color-surface-raised)" },
  danger: { backgroundColor: "var(--color-danger-action)" },
};

const PopupButton = ({ label, onClick, disabled, kind = "primary", style }) => (
  <button
    className={KIND_CLASS[kind] || "settings-save-btn"}
    style={{ float: "none", ...KIND_STYLE[kind], ...style }}
    onClick={onClick}
    disabled={disabled}
  >
    {label}
  </button>
);

/**
 * Shared popup/modal shell.
 * Props:
 *  - title, titleIcon (optional logo image next to title)
 *  - width, height, minWidth, maxHeight — passed straight to the card style
 *  - contentWidth — width of the inner body column (default 400, matches old .welcome-popup-content)
 *  - actions — [{ label, onClick, disabled, kind: "primary" | "secondary" | "danger", style }]
 *  - footer — fully custom footer node, overrides `actions`
 */
const Popup = ({
  title,
  titleIcon,
  width = "40%",
  height,
  minWidth,
  maxHeight,
  contentWidth = "90%",
  children,
  actions,
  footer,
  bodyStyle,
}) => {
  const secondaryActions = (actions || []).filter((a) => a.kind === "secondary");
  const otherActions = (actions || []).filter((a) => a.kind !== "secondary");

  return (
    <div className="welcome-popup-overlay">
      <div className="welcome-popup" style={{ width, height, minWidth, maxHeight }}>
        <div className="welcome-popup-top">
          <div className="welcome-popup-inline">
            {titleIcon && <img className="welcome-popup-icon" src={titleIcon} alt="" />}
            <h2>{title}</h2>
          </div>
        </div>

        <div className="welcome-popup-content" style={{ width: contentWidth, ...bodyStyle }}>
          {children}
        </div>

        {(footer || actions) && (
          <div className="settings-bottom-bar popup-bottom-bar">
            {footer ? (
              footer
            ) : (
              <>
                <div className="popup-bottom-bar-left">
                  {secondaryActions.map((a, i) => (
                    <PopupButton key={i} {...a} />
                  ))}
                </div>
                <div className="popup-bottom-bar-right">
                  {otherActions.map((a, i) => (
                    <PopupButton key={i} {...a} />
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default Popup;
