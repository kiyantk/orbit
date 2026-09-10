import React, { useRef, useState, useEffect, useCallback } from "react";
import "./TimelineOverlay.css";

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
const LABEL_HEIGHT = 16;
const MIN_LABEL_GAP = 4;
const SLOT = LABEL_HEIGHT + MIN_LABEL_GAP;
const HALF = LABEL_HEIGHT / 2;
const PILL_HEIGHT = 28;
const PILL_HALF = PILL_HEIGHT / 2;
const SCROLL_HINT_MS = 1200;

export default function TimelineOverlay({
  itemsRef,
  totalCount,
  columnCount,
  rowHeight,
  gridRef,
  scrollTop,
  totalHeight,
  monthData,
  gridHeight,
  sortOrder = "desc",
}) {
  const [sections, setSections] = useState([]);
  const [yearGroups, setYearGroups] = useState([]);
  const [totalPhotos, setTotalPhotos] = useState(0);
  const [hovered, setHovered] = useState(false);
  const [scrollHinted, setScrollHinted] = useState(false);
  const [currentYear, setCurrentYear] = useState(null);

  const railRef = useRef(null);
  const pillRef = useRef(null);
  const hoverLineRef = useRef(null);
  const isDraggingRef = useRef(false);
  const scrollHintTimer = useRef(null);
  const sectionsRef = useRef([]);
  const totalPhotosRef = useRef(0);
  const hoveredRef = useRef(false);

  // Keep refs in sync
  useEffect(() => {
    sectionsRef.current = sections;
  }, [sections]);
  useEffect(() => {
    totalPhotosRef.current = totalPhotos;
  }, [totalPhotos]);

  // ── Direct DOM pill update — zero setState ────────────────────────────────
  const updatePillDirect = useCallback((y, label) => {
    if (!pillRef.current) return;
    pillRef.current.style.top = `${y}px`;
    const span = pillRef.current.querySelector("span");
    if (span) span.textContent = label;
  }, []);

  // ── Build sections ────────────────────────────────────────────────────────
  useEffect(() => {
    let raw = [];
    if (monthData?.length) {
      raw = monthData.map((m) => ({
        key: `${m.year}-${String(m.month).padStart(2, "0")}`,
        count: m.total,
        firstIndex: null,
      }));
    } else {
      const monthMap = new Map();
      for (const [idxStr, item] of Object.entries(itemsRef.current)) {
        const idx = Number(idxStr);
        let key = null;
        if (item.create_date_local) key = item.create_date_local.slice(0, 7);
        else if (item.create_date) {
          const d = new Date(item.create_date * 1000);
          key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
        }
        if (!key) continue;
        const ex = monthMap.get(key);
        if (!ex) monthMap.set(key, { key, count: 1, firstIndex: idx });
        else {
          if (idx < ex.firstIndex) ex.firstIndex = idx;
          ex.count++;
        }
      }
      raw = [...monthMap.values()].sort((a, b) =>
        sortOrder === "asc"
          ? a.key.localeCompare(b.key)
          : b.key.localeCompare(a.key),
      );
    }

    const keyToMin = new Map();
    for (const [idxStr, item] of Object.entries(itemsRef.current)) {
      const idx = Number(idxStr);
      let key = null;
      if (item.create_date_local) key = item.create_date_local.slice(0, 7);
      else if (item.create_date) {
        const d = new Date(item.create_date * 1000);
        key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      }
      if (!key) continue;
      if (!keyToMin.has(key) || idx < keyToMin.get(key)) keyToMin.set(key, idx);
    }

    let cumulative = 0;
    const built = raw.map((s) => {
      const section = {
        ...s,
        firstIndex: keyToMin.get(s.key) ?? null,
        photosBefore: cumulative,
      };
      cumulative += s.count;
      return section;
    });

    const years = [];
    let lastYear = null;
    built.forEach((s) => {
      const yr = Number(s.key.slice(0, 4));
      if (yr !== lastYear) {
        years.push({ year: yr, photosBefore: s.photosBefore });
        lastYear = yr;
      }
    });

    setSections(built);
    setYearGroups(years);
    setTotalPhotos(cumulative);
  }, [monthData, totalCount]);

  // ── Re-resolve firstIndex as more pages load ──────────────────────────────
  useEffect(() => {
    if (!sections.length) return;
    if (sections.every((s) => s.firstIndex !== null)) return;
    setSections((prev) => {
      if (prev.every((s) => s.firstIndex !== null)) return prev;
      let changed = false;
      const next = prev.map((s) => {
        if (s.firstIndex !== null) return s;
        let minIdx = null;
        for (const [idxStr, item] of Object.entries(itemsRef.current)) {
          const idx = Number(idxStr);
          let key = null;
          if (item.create_date_local) key = item.create_date_local.slice(0, 7);
          else if (item.create_date) {
            const d = new Date(item.create_date * 1000);
            key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
          }
          if (key !== s.key) continue;
          if (minIdx === null || idx < minIdx) minIdx = idx;
        }
        if (minIdx !== null) {
          changed = true;
          return { ...s, firstIndex: minIdx };
        }
        return s;
      });
      return changed ? next : prev;
    });
  }, [totalCount, sections]);

  // ── Current year from scroll ──────────────────────────────────────────────
  useEffect(() => {
    if (!sections.length || totalHeight <= 0) return;
    const firstVisible = Math.floor(scrollTop / rowHeight) * columnCount;
    let yr = yearGroups[0]?.year ?? null;
    for (const s of sections) {
      if (s.firstIndex !== null && s.firstIndex <= firstVisible)
        yr = Number(s.key.slice(0, 4));
    }
    setCurrentYear(yr);
  }, [scrollTop, sections, yearGroups, rowHeight, columnCount, totalHeight]);

  // ── Shared section-lookup (pure function, no deps) ────────────────────────
  const getSectionAtFrac = (frac) => {
    const secs = sectionsRef.current;
    const total = totalPhotosRef.current;
    if (!secs.length || total === 0) return null;
    if (frac >= 1) return secs[secs.length - 1];
    const target = frac * total;
    for (const s of secs) {
      if (target < s.photosBefore + s.count) return s;
    }
    return secs[secs.length - 1];
  };

  const labelForFrac = (frac) => {
    const s = getSectionAtFrac(frac);
    if (!s) return "";
    const [yr, mo] = s.key.split("-");
    return `${MONTHS[Number(mo) - 1]} ${yr}`;
  };

  const getSectionForVisibleIndex = useCallback((index) => {
    if (!sectionsRef.current.length) return null;

    let result = sectionsRef.current[0];

    for (const s of sectionsRef.current) {
      if (s.firstIndex !== null && s.firstIndex <= index) {
        result = s;
      } else {
        break;
      }
    }

    return result;
  }, []);

  // ── Scroll hint ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (!sectionsRef.current.length || totalHeight <= 0 || gridHeight <= 0)
      return;
    if (hoveredRef.current) return; // mouse owns the pill

    const maxScroll = totalHeight - gridHeight;
    const frac = Math.max(
      0,
      Math.min(1, Math.round(scrollTop) / Math.round(maxScroll)),
    );
    const s = getSectionAtFrac(frac);
    if (!s) return;

    const [yr, mo] = s.key.split("-");
    const label = `${MONTHS[Number(mo) - 1]} ${yr}`;
    const pillY = Math.max(
      PILL_HALF,
      Math.min(gridHeight - PILL_HALF, frac * gridHeight),
    );

    updatePillDirect(pillY, label);

    setScrollHinted(true);
    clearTimeout(scrollHintTimer.current);
    scrollHintTimer.current = setTimeout(
      () => setScrollHinted(false),
      SCROLL_HINT_MS,
    );
    return () => clearTimeout(scrollHintTimer.current);
  }, [scrollTop, totalHeight, gridHeight, updatePillDirect]);

  // ── Fraction → scroll ─────────────────────────────────────────────────────
  const scrollToFraction = useCallback(
    (frac) => {
      if (!gridRef.current) return;

      const tgt = getSectionAtFrac(frac);

      let index;

      index = Math.floor(frac * totalCount);

      gridRef.current.scrollToCell({
        rowIndex: Math.floor(index / columnCount),
        columnIndex: index % columnCount,
      });
    },
    [columnCount, totalCount, gridRef],
  );

  const fractionFromY = useCallback((clientY) => {
    if (!railRef.current) return 0;
    const rect = railRef.current.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
  }, []);

  // ── Mouse handlers ────────────────────────────────────────────────────────
  const handleMouseMove = useCallback(
    (e) => {
      if (!railRef.current) return;
      const rect = railRef.current.getBoundingClientRect();
      const y = Math.max(0, Math.min(gridHeight - 1, e.clientY - rect.top));
      const frac = y / Math.max(gridHeight - 1, 1);
      const pillY = Math.max(PILL_HALF, Math.min(gridHeight - PILL_HALF, y));

      // Direct DOM writes — no setState, no render
      updatePillDirect(pillY, labelForFrac(frac));
      if (hoverLineRef.current) hoverLineRef.current.style.top = `${y}px`;

      if (isDraggingRef.current) scrollToFraction(frac);
    },
    [gridHeight, scrollToFraction, updatePillDirect],
  );

  const handleMouseDown = useCallback(
    (e) => {
      // Keep the explorer's drag-select handler from treating a timeline scrub
      // as the start of a grid selection.
      e.stopPropagation();
      e.preventDefault();
      isDraggingRef.current = true;
      scrollToFraction(fractionFromY(e.clientY));
    },
    [fractionFromY, scrollToFraction],
  );

  const handleClick = useCallback(
    (e) => {
      e.stopPropagation();
      scrollToFraction(fractionFromY(e.clientY));
    },
    [fractionFromY, scrollToFraction],
  );

  useEffect(() => {
    const onMove = (e) => {
      if (isDraggingRef.current) scrollToFraction(fractionFromY(e.clientY));
    };
    const onUp = () => {
      isDraggingRef.current = false;
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [fractionFromY, scrollToFraction]);

  // ── Visible year labels ───────────────────────────────────────────────────
  const visibleYearGroups = useCallback(() => {
    if (yearGroups.length < 2 || !gridHeight) return [];

    const idealTop = (yg) =>
      (yg.photosBefore / Math.max(totalPhotos, 1)) * gridHeight;

    if (yearGroups.length === 2) {
      return [
        { ...yearGroups[0], top: HALF },
        {
          ...yearGroups[yearGroups.length - 1],
          top: Math.min(
            idealTop(yearGroups[yearGroups.length - 1]),
            gridHeight - HALF,
          ),
        },
      ];
    }

    const first = { ...yearGroups[0], top: HALF };
    const lastYg = yearGroups[yearGroups.length - 1];
    const lastIdeal = Math.min(idealTop(lastYg), gridHeight - HALF);
    const last = { ...lastYg, top: lastIdeal };

    const middle = yearGroups.slice(1, -1);

    const forwardSet = new Set();
    let nextMinTop = HALF + SLOT;
    for (const yg of middle) {
      const top = Math.max(idealTop(yg), nextMinTop);
      if (top > lastIdeal - SLOT) break;
      forwardSet.add(yg.year);
      nextMinTop = top + SLOT;
    }

    const backwardSet = new Set();
    let prevMaxTop = lastIdeal - SLOT;
    for (let i = middle.length - 1; i >= 0; i--) {
      const yg = middle[i];
      const top = Math.min(idealTop(yg), prevMaxTop);
      if (top < HALF + SLOT) break;
      backwardSet.add(yg.year);
      prevMaxTop = top - SLOT;
    }

    const placed = [first];
    let minTop = HALF + SLOT;
    for (const yg of middle) {
      if (!forwardSet.has(yg.year) || !backwardSet.has(yg.year)) continue;
      const top = Math.max(idealTop(yg), minTop);
      placed.push({ ...yg, top });
      minTop = top + SLOT;
    }
    placed.push(last);
    return placed;
  }, [yearGroups, totalPhotos, gridHeight]);

  if (yearGroups.length < 2) return null;

  const labels = visibleYearGroups();
  const pillVisible = hovered || scrollHinted;

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <>
      <div
        ref={railRef}
        className="tl-rail"
        style={{ height: gridHeight }}
        onMouseMove={handleMouseMove}
        onMouseEnter={() => {
          hoveredRef.current = true;
          setHovered(true);
        }}
        onMouseLeave={() => {
          hoveredRef.current = false;
          if (!isDraggingRef.current) setHovered(false);
        }}
        onMouseDown={handleMouseDown}
        onClick={handleClick}
      >
        {labels.map((yg) => (
          <div key={yg.year} className="tl-year" style={{ top: yg.top }}>
            <span
              className={`tl-year-label ${yg.year === currentYear ? "active" : "inactive"}`}
            >
              {yg.year}
            </span>
          </div>
        ))}

        {/* Hover line — shown/hidden via CSS, moved via direct DOM ref */}
        <div
          ref={hoverLineRef}
          className="tl-hover-line"
          style={{ display: hovered ? "block" : "none", top: 0 }}
        />
      </div>

      {/* Pill — visibility via CSS class, position+label via direct DOM ref */}
      <div
        ref={pillRef}
        className={`tl-pill ${pillVisible ? "visible" : "hidden"}`}
        style={{ top: 0 }}
      >
        <span />
      </div>
    </>
  );
}
