import React, { useState, useEffect, useRef, useCallback } from "react";
import { Grid } from "react-virtualized";
import "react-virtualized/styles.css";

// ─── Subdivision CSV loader ───────────────────────────────────────────────────
let subdivisionMap = null;

async function loadSubdivisions() {
  if (subdivisionMap) return subdivisionMap;
  try {
    const raw = await window.electron.ipcRenderer.invoke(
      "read-file",
      "public/subdivisions.csv",
    );
    subdivisionMap = new Map();
    for (const line of raw.split(/\r?\n/)) {
      const parts = line.split(";");
      if (parts.length < 2) continue;
      const key = parts[0].replace(".", "-").trim().toUpperCase();
      const name = parts[1].trim();
      if (key && name) subdivisionMap.set(key, name);
    }
  } catch (err) {
    console.warn("Could not load subdivisions.csv:", err);
    subdivisionMap = new Map();
  }
  return subdivisionMap;
}

function resolveSubdivisionName(country, code, map) {
  if (!map || !country || !code) return code;
  const key = `${country.toUpperCase()}-${code.toUpperCase()}`;
  return map.get(key) || code;
}

// ─── Country name helper ──────────────────────────────────────────────────────
const countryNameCache = new Map();
async function getCountryName(code) {
  if (!code) return code;
  if (countryNameCache.has(code)) return countryNameCache.get(code);
  try {
    const name = await window.electron.ipcRenderer.invoke(
      "get-country-name",
      code,
    );
    countryNameCache.set(code, name || code);
    return name || code;
  } catch {
    return code;
  }
}

// ─── Grid layout constants ────────────────────────────────────────────────────
const CARD_MIN_WIDTH = 180;
const CARD_HEIGHT = 220;
const GRID_GAP = 12;

function getColumnCount(containerWidth) {
  return Math.max(
    1,
    Math.floor((containerWidth + GRID_GAP) / (CARD_MIN_WIDTH + GRID_GAP)),
  );
}

function getCellWidth(containerWidth, columnCount) {
  return Math.floor(
    (containerWidth - GRID_GAP * (columnCount - 1)) / columnCount,
  );
}

function formatCountSubtitle(item, mode) {
  switch (mode) {
    case "last_visit":
      if (!item.lastVisit) return "—";
      return new Date(item.lastVisit * 1000).toLocaleDateString();

    case "count":
    default:
      return `${item.count.toLocaleString()} items`;
  }
}

// ─── Title auto-fit ───────────────────────────────────────────────────────────
function fitCardTitle(el) {
  if (!el) return;
  const nameEl = el.querySelector(".place-card__name");
  if (!nameEl) return;

  const MAX_PX = 16;
  const MIN_PX = 10;
  const STEP = 0.5;

  nameEl.style.fontSize = `${MAX_PX}px`;
  if (nameEl.scrollWidth <= nameEl.offsetWidth) return;

  let lo = MIN_PX,
    hi = MAX_PX - STEP,
    best = MIN_PX;

  while (lo <= hi) {
    const mid = parseFloat(((lo + hi) / 2).toFixed(1));
    nameEl.style.fontSize = `${mid}px`;

    if (nameEl.scrollWidth <= nameEl.offsetWidth) {
      best = mid;
      lo = mid + STEP;
    } else {
      hi = mid - STEP;
    }
  }

  nameEl.style.fontSize = `${best}px`;
}

// ─── PlaceCard ────────────────────────────────────────────────────────────────
const PlaceCard = React.memo(
  ({ name, subtitle, count, countSubtitle, thumbnail, onClick, style }) => {
    const cardRef = useRef(null);
    const thumbUrl = thumbnail
      ? `orbit://thumbs/${thumbnail.id}_thumb.jpg`
      : null;

    useEffect(() => {
      const el = cardRef.current;
      if (!el) return;

      fitCardTitle(el);

      const ro = new ResizeObserver(() => fitCardTitle(el));
      ro.observe(el);

      return () => ro.disconnect();
    }, [name]);

    return (
      <div className="place-card" ref={cardRef} onClick={onClick} style={style}>
        <div
          className="place-card__bg"
          style={
            thumbUrl
              ? { backgroundImage: `url(${thumbUrl})` }
              : { background: "#1e1e1e" }
          }
        />
        <div className="place-card__overlay" />
        <div className="place-card__body">
          <div className="place-card__name">{name}</div>
          {subtitle && <div className="place-card__sub">{subtitle}</div>}
          <div className="place-card__count">{countSubtitle}</div>
        </div>
      </div>
    );
  },
);

// ─── PlacesView ───────────────────────────────────────────────────────────────
const TABS = ["Countries", "Regions", "Cities"];

const PlacesView = ({ currentSettings, onViewPlace }) => {
  const [selectedTab, setSelectedTab] = useState("Countries");
  const [loading, setLoading] = useState(false);
  const [items, setItems] = useState([]);
  const [subdivisions, setSubdivisions] = useState(null);
  const {
    placesSubtitles = "count",
  } = currentSettings;

  // NEW: container sizing
  const containerRef = useRef(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    loadSubdivisions().then(setSubdivisions);
  }, []);

  // NEW: ResizeObserver instead of AutoSizer
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize({ width, height });
    });

    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    setItems([]);
    if (selectedTab === "Countries") fetchCountries();
    if (selectedTab === "Regions") fetchRegions();
    if (selectedTab === "Cities") fetchCities();
  }, [selectedTab, subdivisions]);

  const fetchCountries = async () => {
    setLoading(true);
    try {
      const res = await window.electron.ipcRenderer.invoke(
        "location:get-countries",
        currentSettings,
      );
      const enriched = await Promise.all(
        res.data.map(async (row) => ({
          ...row,
          label: await getCountryName(row.country),
        })),
      );
      setItems(enriched);
    } finally {
      setLoading(false);
    }
  };

  const fetchRegions = async () => {
    if (!subdivisions) return;
    setLoading(true);

    try {
      const res = await window.electron.ipcRenderer.invoke(
        "location:get-regions",
        currentSettings,
      );

      const enriched = await Promise.all(
        res.data.map(async (row) => {
          const regionName = resolveSubdivisionName(
            row.country,
            row.subdivision,
            subdivisions,
          );
          const countryName = await getCountryName(row.country);

          return {
            ...row,
            label: regionName,
            subtitle: countryName,
          };
        }),
      );

      setItems(enriched);
    } finally {
      setLoading(false);
    }
  };

  const fetchCities = async () => {
    setLoading(true);

    try {
      const res = await window.electron.ipcRenderer.invoke(
        "location:get-cities",
        currentSettings,
      );

      const enriched = await Promise.all(
        res.data.map(async (row) => {
          let subtitle = await getCountryName(row.country);

          if (row.subdivision && subdivisions) {
            const regionName = resolveSubdivisionName(
              row.country,
              row.subdivision,
              subdivisions,
            );

            if (regionName && regionName !== row.subdivision) {
              subtitle = `${regionName}, ${subtitle}`;
            }
          }

          return {
            ...row,
            label: row.city,
            subtitle,
          };
        }),
      );

      setItems(enriched);
    } finally {
      setLoading(false);
    }
  };

  const handleCardClick = useCallback(
    (item) => {
      if (item.ids?.length) onViewPlace(item.ids);
    },
    [onViewPlace],
  );

  const makeCellRenderer = useCallback(
    (columnCount, cellWidth) =>
      ({ columnIndex, rowIndex, key, style }) => {
        const index = rowIndex * columnCount + columnIndex;
        if (index >= items.length) return null;

        const item = items[index];

        const adjustedStyle = {
          ...style,
          left: columnIndex * (cellWidth + GRID_GAP),
          top: rowIndex * (CARD_HEIGHT + GRID_GAP),
          width: cellWidth,
          height: CARD_HEIGHT,
          padding: 0,
          boxSizing: "border-box",
        };

        return (
          <PlaceCard
            key={key}
            name={item.label}
            subtitle={item.subtitle}
            count={item.count}
            countSubtitle={formatCountSubtitle(item, placesSubtitles)}
            thumbnail={item.thumbnails?.[0] ?? null}
            onClick={() => handleCardClick(item)}
            style={adjustedStyle}
          />
        );
      },
    [items, handleCardClick],
  );

  // ─── Render ───────────────────────────────────────────────────────────────
  const columnCount = getColumnCount(size.width || 0);
  const cellWidth = getCellWidth(size.width || 0, columnCount);
  const rowCount = Math.ceil(items.length / columnCount);

  return (
    <div className="places-view">
      <div className="memories-main">
        <div className="settings-list">
          <ul>
            {TABS.map((tab) => (
              <li
                key={tab}
                className={`settings-list-item ${
                  selectedTab === tab ? "settings-list-active" : ""
                }`}
                onClick={() => setSelectedTab(tab)}
              >
                <span>{tab}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="memories-content places-content" ref={containerRef}>
          {loading && (
            <div className="memories-loading">
              <div className="loader" />
            </div>
          )}

          {!loading && items.length === 0 && (
            <div className="memories-empty">
              <p>No {selectedTab.toLowerCase()} with location data found.</p>
            </div>
          )}

          {!loading && items.length > 0 && size.width > 0 && (
            <Grid
              width={size.width}
              height={size.height}
              columnCount={columnCount}
              columnWidth={cellWidth + GRID_GAP}
              rowCount={rowCount}
              rowHeight={CARD_HEIGHT + GRID_GAP}
              cellRenderer={makeCellRenderer(columnCount, cellWidth)}
              overscanRowCount={2}
              overscanColumnCount={1}
              style={{ outline: "none", overflowX: "hidden" }}
            />
          )}
        </div>
      </div>
    </div>
  );
};

export default PlacesView;
