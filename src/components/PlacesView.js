import React, { useState, useEffect, useRef, useCallback } from "react";
import { Grid } from "react-virtualized";
import "react-virtualized/styles.css";

// ─── ISO 3166-2 region data loader ────────────────────────────────────────────
let iso3166Data = null;

async function loadIso3166Data() {
  if (iso3166Data) return iso3166Data;
  try {
    const raw = await window.electron.ipcRenderer.invoke(
      "read-file",
      "public/iso3166-2.json",
    );
    iso3166Data = JSON.parse(raw);
  } catch (err) {
    console.warn("Could not load iso3166-2.json:", err);
    iso3166Data = {};
  }
  return iso3166Data;
}

function normalizeCode(code) {
  return (code || "").trim().toUpperCase();
}

function getSubdivisionCode(country, code) {
  const countryCode = normalizeCode(country);
  const subdivisionCode = normalizeCode(code);
  if (!countryCode || !subdivisionCode) return code;
  return subdivisionCode.startsWith(countryCode + "-")
    ? subdivisionCode
    : countryCode + "-" + subdivisionCode;
}

function getSubdivision(data, country, code) {
  if (!data || !country || !code) return null;
  const countryCode = normalizeCode(country);
  const subdivisionCode = getSubdivisionCode(countryCode, code);
  return data[countryCode]?.[subdivisionCode] || null;
}

function getEnglishSubdivisionName(subdivision) {
  const localOtherName = subdivision?.localOtherName;
  if (typeof localOtherName !== "string") return subdivision?.name;

  const englishName = localOtherName
    .split(",")
    .map((entry) => entry.trim())
    .find((entry) => /\s*\(eng\)\s*$/i.test(entry));

  return englishName?.replace(/\s*\(eng\)\s*$/i, "") || subdivision.name;
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
async function getCountryLabel(code, preference) {
  return preference === "code" ? normalizeCode(code) : getCountryName(code);
}

function getRegionLabel(country, code, data, preference) {
  if (preference === "code") return getSubdivisionCode(country, code);

  const subdivision = getSubdivision(data, country, code);
  return preference === "local"
    ? subdivision?.name || code
    : getEnglishSubdivisionName(subdivision) || code;
}

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
  const [iso3166, setIso3166] = useState(null);
  const {
    placesSubtitles = "count",
    placesNameDisplay = "english",
    placesRegionNames = "english",
    placesCountryNames = "name",
  } = currentSettings;

  // NEW: container sizing
  const containerRef = useRef(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    loadIso3166Data().then(setIso3166);
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
  }, [
    selectedTab,
    iso3166,
    placesNameDisplay,
    placesRegionNames,
    placesCountryNames,
  ]);

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
          label: await getCountryLabel(row.country, placesCountryNames),
        })),
      );
      setItems(enriched);
    } finally {
      setLoading(false);
    }
  };

  const fetchRegions = async () => {
    if (!iso3166) return;
    setLoading(true);

    try {
      const res = await window.electron.ipcRenderer.invoke(
        "location:get-regions",
        currentSettings,
      );

      const enriched = await Promise.all(
        res.data.map(async (row) => {
          const regionName = getRegionLabel(
            row.country,
            row.subdivision,
            iso3166,
            placesRegionNames,
          );
          const countryName = await getCountryLabel(
            row.country,
            placesCountryNames,
          );

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
          let subtitle = await getCountryLabel(
            row.country,
            placesCountryNames,
          );

          if (row.subdivision && iso3166) {
            const regionName = getRegionLabel(
              row.country,
              row.subdivision,
              iso3166,
              placesRegionNames,
            );

            if (regionName) {
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
