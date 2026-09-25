import { faArrowRight } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { Grid } from "react-virtualized";
import { SnackbarProvider, enqueueSnackbar } from "notistack";
import Popup from "./Popup";
import "react-virtualized/styles.css";

const MEMORY_CARD_SIZE = 200;
const MEMORY_LIST_CARD_HEIGHT = 92;
const MEMORY_GRID_GAP = 16;
const MEMORY_CONTENT_PADDING = 20;
const MEMORY_SCROLLBAR_GUTTER = 20;

const ThumbnailStrip = React.memo(({ thumbnails = [] }) => (
  <div className="memory-thumbs">
    {thumbnails.map((t) => (
      <img
        key={t.id}
        src={`orbit://thumbs/${t.id}_thumb.jpg`}
        draggable={false}
        alt=""
        onError={(e) => (e.currentTarget.style.display = "none")}
      />
    ))}
  </div>
));

const useFitTitles = (deps) => {
  const ref = useRef(null);

  useEffect(() => {
    const container = ref.current;
    if (!container) return;

    const fitTitles = () => {
      const grid = container.querySelector(".memories-grid.grid-layout");
      if (!grid) return;

      const titles = grid.querySelectorAll(".memory-text .title");
      titles.forEach((el) => {
        // Reset so measurements are not tainted by a previous pass.
        el.style.fontSize = "";

        const MAX_PX = 18;
        const MIN_PX = 14;
        const STEP = 0.5;

        // Fast path: if the title fits at the maximum size, use it directly
        // and skip the binary search entirely.
        el.style.fontSize = `${MAX_PX}px`;
        if (el.scrollWidth <= el.offsetWidth) {
          // Already set — nothing more to do for this element.
          return;
        }

        let lo = MIN_PX,
          hi = MAX_PX - STEP,
          best = MIN_PX;

        while (lo <= hi) {
          const mid = parseFloat(((lo + hi) / 2).toFixed(1));
          el.style.fontSize = `${mid}px`;

          // scrollWidth > offsetWidth  →  text overflows (too big)
          if (el.scrollWidth <= el.offsetWidth) {
            best = mid;
            lo = mid + STEP;
          } else {
            hi = mid - STEP;
          }
        }

        el.style.fontSize = `${best}px`;
      });
    };

    // Run once immediately after layout.
    fitTitles();

    // Re-run whenever the container is resized (e.g. window resize,
    // sidebar collapse, layout change).
    const ro = new ResizeObserver(fitTitles);
    ro.observe(container);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return ref;
};

const fitMemoryTitle = (card) => {
  const title = card?.querySelector(".memory-text .title");
  if (!title) return;

  const MAX_PX = 18;
  const MIN_PX = 14;
  const STEP = 0.5;
  title.style.fontSize = `${MAX_PX}px`;
  if (title.scrollWidth <= title.offsetWidth) return;

  let lo = MIN_PX;
  let hi = MAX_PX - STEP;
  let best = MIN_PX;
  while (lo <= hi) {
    const mid = parseFloat(((lo + hi) / 2).toFixed(1));
    title.style.fontSize = `${mid}px`;
    if (title.scrollWidth <= title.offsetWidth) {
      best = mid;
      lo = mid + STEP;
    } else {
      hi = mid - STEP;
    }
  }
  title.style.fontSize = `${best}px`;
};

const MemoryBox = React.memo(({ memoryLayout, title, children, ...props }) => {
  const cardRef = useRef(null);

  useEffect(() => {
    const card = cardRef.current;
    if (!card || memoryLayout !== "grid") return;

    fitMemoryTitle(card);
    const observer = new ResizeObserver(() => fitMemoryTitle(card));
    observer.observe(card);
    return () => observer.disconnect();
  }, [memoryLayout, title]);

  return <div {...props} ref={cardRef}>{children}</div>;
});

const VirtualizedMemoryGrid = ({ memoryLayout, items, width, height, renderItem }) => {
  const contentWidth = Math.max(0, width - MEMORY_CONTENT_PADDING * 2);
  const columnCount = useMemo(() => {
    if (memoryLayout === "list") return 1;
    return Math.max(1, Math.floor((contentWidth + MEMORY_GRID_GAP) / (MEMORY_CARD_SIZE + MEMORY_GRID_GAP)));
  }, [contentWidth, memoryLayout]);
  const rowCount = Math.ceil(items.length / columnCount);
  const cardHeight = memoryLayout === "grid" ? MEMORY_CARD_SIZE : MEMORY_LIST_CARD_HEIGHT;
  const rowHeight = useCallback(
    ({ index }) => (
      index === rowCount - 1
        ? cardHeight + MEMORY_CONTENT_PADDING * 2
        : cardHeight + MEMORY_GRID_GAP
    ),
    [cardHeight, rowCount],
  );
  const gridWidth = columnCount * MEMORY_CARD_SIZE + (columnCount - 1) * MEMORY_GRID_GAP;
  const horizontalOffset = memoryLayout === "grid"
    ? MEMORY_CONTENT_PADDING + Math.max(0, Math.floor((contentWidth - gridWidth) / 2))
    : MEMORY_CONTENT_PADDING;
  const cellRenderer = useCallback(
    ({ columnIndex, rowIndex, key, style }) => {
      const index = rowIndex * columnCount + columnIndex;
      if (index >= items.length) return null;
      return renderItem(items[index], index, key, {
        ...style,
        top: style.top + MEMORY_CONTENT_PADDING,
        left: memoryLayout === "grid" ? horizontalOffset + columnIndex * (MEMORY_CARD_SIZE + MEMORY_GRID_GAP) : horizontalOffset,
        width: memoryLayout === "grid" ? MEMORY_CARD_SIZE : Math.max(0, contentWidth - MEMORY_SCROLLBAR_GUTTER),
        height: cardHeight,
      });
    },
    [cardHeight, columnCount, contentWidth, horizontalOffset, items, memoryLayout, renderItem],
  );

  if (!width || !height) return null;
  return (
    <div className={`memory-virtualizer ${memoryLayout}-layout`}>
      <Grid
        width={width}
        height={height}
        columnCount={columnCount}
        columnWidth={memoryLayout === "grid" ? MEMORY_CARD_SIZE + MEMORY_GRID_GAP : width}
        rowCount={rowCount}
        rowHeight={rowHeight}
        cellRenderer={cellRenderer}
        overscanRowCount={2}
        overscanColumnCount={1}
        style={{ outline: "none", overflowX: "hidden" }}
      />
    </div>
  );
};

const MemoriesView = ({
  switchMemoryMode,
  memoryMode,
  onAddMedia,
  onViewMemory,
  memoryLayout,
  onCountChange,
}) => {
  const [selectedTab, setSelectedTab] = useState("Years");
  const [years, setYears] = useState([]);
  const [months, setMonths] = useState([]);
  const [trips, setTrips] = useState([]);
  const [vacations, setVacations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [customMemories, setCustomMemories] = useState([]);
  const [onThisDay, setOnThisDay] = useState([]);

  const currentMemoryCount =
    selectedTab === "All"
      ? customMemories.length + years.length + months.length + trips.length
      : selectedTab === "Years"
        ? years.length
        : selectedTab === "Months"
          ? months.length
          : selectedTab === "Vacations"
            ? vacations.length
            : selectedTab === "Trips"
              ? trips.length
              : selectedTab === "On This Day"
                ? onThisDay.length
                : customMemories.length;

  useEffect(() => {
    onCountChange?.({ total: currentMemoryCount, filtered: currentMemoryCount });
  }, [currentMemoryCount, onCountChange]);

  // All drag state lives in a single ref — no stale closure issues
  const drag = useRef({ active: false, fromIndex: null, toIndex: null });
  const [dragIndex, setDragIndex] = useState(null);
  // dropEdge: { index, edge: 'top' | 'bottom' } — which card + which side to show the indicator
  const [dropEdge, setDropEdge] = useState(null);

  // --- ADD MEMORY POPUP STATE ---
  const [showAddMemory, setShowAddMemory] = useState(false);
  const [newMemory, setNewMemory] = useState({
    title: "",
    description: "",
    color: "#ffffff",
    quickAddQuery: "",
    existing: null,
  });

  const gridRef = useRef(null);
  const [gridSize, setGridSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const container = gridRef.current;
    if (!container) return;

    const resize = ([entry]) => {
      const { width, height } = entry.contentRect;
      setGridSize({
        width: width + MEMORY_CONTENT_PADDING * 2,
        height: height + MEMORY_CONTENT_PADDING * 2,
      });
    };
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  const getMemoryBoxStyle = (thumbnails = []) => {
    if (memoryLayout !== "grid") return {};

    const thumb = thumbnails?.[0];

    if (!thumb) {
      return {
        background: "#2a2a2a",
      };
    }

    return {
      backgroundImage: `url(orbit://thumbs/${thumb.id}_thumb.jpg)`,
      backgroundSize: "cover",
      backgroundPosition: "center",
      backgroundRepeat: "no-repeat",
    };
  };

  useEffect(() => {
    setSelectedTab("Custom");
    setNewMemory({
      title: "",
      description: "",
      color: "#ffffff",
      quickAddQuery: "",
      existing: null,
    });
    if (memoryMode === "new") setShowAddMemory(true);
    if (memoryMode === "edit") {
      setShowAddMemory(false);
      enqueueSnackbar(`Click on a memory to edit it`);
    }
  }, [memoryMode]);

  // --- FETCHING DATA ---
  useEffect(() => {
    setLoading(true);
    setYears([]);
    setMonths([]);
    setTrips([]);
    setVacations([]);
    setCustomMemories([]);
    setOnThisDay([]);
    if (selectedTab === "All") fetchAll();
    if (selectedTab === "Years") fetchYears();
    if (selectedTab === "Months") fetchMonths();
    if (selectedTab === "Vacations") fetchVacations();
    if (selectedTab === "Trips") fetchTrips();
    if (selectedTab === "Custom") fetchCustomMemories();
    if (selectedTab === "On This Day") fetchOnThisDay();
  }, [selectedTab]);

  const fetchAll = async () => {
    try {
      setLoading(true);
      const [yearRows, monthRows, tripRows, memoryRows] = await Promise.all([
        window.electron.ipcRenderer.invoke("fetch-years"),
        window.electron.ipcRenderer.invoke("fetch-months"),
        window.electron.ipcRenderer.invoke("fetch-trips", {
          minTripPhotos: 10,
        }),
        window.electron.ipcRenderer.invoke("fetch-memories"),
      ]);
      const convertedTrips = await convertTripCountries(tripRows);
      setYears(yearRows);
      setMonths(monthRows);
      setTrips(convertedTrips);
      setCustomMemories(memoryRows);
      setLoading(false);
    } catch (err) {
      console.error("Failed to fetch all memories:", err);
    }
  };

  const fetchYears = async () => {
    try {
      setLoading(true);
      const rows = await window.electron.ipcRenderer.invoke("fetch-years");
      setYears(rows);
      setLoading(false);
    } catch (err) {
      console.error("Failed to fetch years:", err);
    }
  };

  const fetchMonths = async () => {
    try {
      setLoading(true);
      const rows = await window.electron.ipcRenderer.invoke("fetch-months");
      setMonths(rows);
      setLoading(false);
    } catch (err) {
      console.error("Failed to fetch months:", err);
    }
  };

  const fetchCustomMemories = async () => {
    try {
      setLoading(true);
      const rows = await window.electron.ipcRenderer.invoke("fetch-memories");
      setCustomMemories(rows);
      setLoading(false);
    } catch (err) {
      console.error("Failed to fetch custom memories:", err);
    }
  };

  const fetchOnThisDay = async () => {
    try {
      setLoading(true);
      const rows =
        await window.electron.ipcRenderer.invoke("fetch-on-this-day");
      setOnThisDay(rows);
      setLoading(false);
    } catch (err) {
      console.error("Failed to fetch on this day:", err);
      setLoading(false);
    }
  };

  const convertTripCountries = async (trips) => {
    return Promise.all(
      trips.map(async (t) => {
        const names = await Promise.all(
          t.countries.map((code) =>
            window.electron.ipcRenderer.invoke("get-country-name", code),
          ),
        );
        return {
          ...t,
          title: names.join(" – ") + ` ${new Date(t.start).getFullYear()}`,
        };
      }),
    );
  };

  const fetchVacations = async () => {
    setLoading(true);
    let rows = await window.electron.ipcRenderer.invoke("fetch-trips");
    rows = await convertTripCountries(rows);
    setVacations(rows);
    setLoading(false);
  };

  const fetchTrips = async () => {
    setLoading(true);
    let rows = await window.electron.ipcRenderer.invoke("fetch-trips", {
      minTripPhotos: 10,
    });
    rows = await convertTripCountries(rows);
    setTrips(rows);
    setLoading(false);
  };

  // --- DRAG: whole card is the handle ---
  const handleCardMouseDown = useCallback((e, index) => {
    if (e.button !== 0) return;

    const startX = e.clientX;
    const startY = e.clientY;
    let didDrag = false;

    const onMouseMove = (ev) => {
      const dist = Math.sqrt(
        Math.pow(ev.clientX - startX, 2) + Math.pow(ev.clientY - startY, 2),
      );

      if (!didDrag) {
        if (dist < 6) return;
        didDrag = true;
        drag.current.active = true;
        drag.current.fromIndex = index;
        drag.current.toIndex = index;
        setDragIndex(index);
        setDropEdge(null);
      }

      // Find which card the cursor is over and which half
      const grid = document.querySelector(".memory-virtualizer");
      if (!grid) return;
      const cards = Array.from(grid.querySelectorAll("[data-memory-index]"))
        .sort((left, right) => Number(left.dataset.memoryIndex) - Number(right.dataset.memoryIndex));
      if (!cards.length) return;

      let toIndex = Number(cards[cards.length - 1].dataset.memoryIndex);
      let edge = "bottom";

      for (let i = 0; i < cards.length; i++) {
        const rect = cards[i].getBoundingClientRect();
        if (ev.clientY < rect.top + rect.height / 2) {
          toIndex = Number(cards[i].dataset.memoryIndex);
          edge = "top";
          break;
        } else if (ev.clientY < rect.bottom) {
          toIndex = Number(cards[i].dataset.memoryIndex);
          edge = "bottom";
          break;
        }
      }

      const insertAt = edge === "top" ? toIndex : toIndex + 1;
      const maxInsert = Number(cards[cards.length - 1].dataset.memoryIndex);
      const clampedInsert = Math.min(insertAt, maxInsert);

      drag.current.toIndex = clampedInsert;

      if (edge === "top") {
        setDropEdge({ index: toIndex, edge: "top" });
      } else {
        setDropEdge({ index: toIndex, edge: "bottom" });
      }
    };

    const onMouseUp = () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);

      if (didDrag) {
        const from = drag.current.fromIndex;
        const to = drag.current.toIndex;
        if (from !== null && to !== null && from !== to) {
          setCustomMemories((prev) => {
            const next = [...prev];
            const [moved] = next.splice(from, 1);
            // After splicing `from` out, indices >= from shift down by 1.
            // So if we're inserting after the original `from`, adjust by -1.
            const adjustedTo = to > from ? to - 1 : to;
            next.splice(adjustedTo, 0, moved);
            const order = next.map((m, i) => ({
              id: m.id,
              sort_order: next.length - i,
            }));
            window.electron.ipcRenderer.invoke("memory:reorder", { order });
            return next;
          });
        }
      }

      drag.current = { active: false, fromIndex: null, toIndex: null };
      setDragIndex(null);
      setDropEdge(null);
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }, []);

  // --- MEMORY BOX RENDERING ---
  const renderYearBoxes = () => (
    <VirtualizedMemoryGrid memoryLayout={memoryLayout} items={years} {...gridSize}
      renderItem={(y, _index, key, style) => (
        <MemoryBox key={key} memoryLayout={memoryLayout} title={y.year}
          className="memory-box" style={{ ...style, ...getMemoryBoxStyle(y.thumbnails) }}
          onClick={() => onViewMemory(y.ids)}>
          <div className="memory-text">
            <div className="title">{y.year}</div>
            <div className="description">All media from {y.year}</div>
          </div>
          <ThumbnailStrip thumbnails={y.thumbnails} />
          <div className="memory-count">{y.total} items</div>
        </MemoryBox>
      )}
    />
  );

  const renderMonthBoxes = () => (
    <VirtualizedMemoryGrid memoryLayout={memoryLayout} items={months} {...gridSize}
      renderItem={(m, _index, key, style) => {
        const date = new Date(`${m.year}-${m.month}-01`);
        const label = date.toLocaleString("en-US", {
          month: "long",
          year: "numeric",
        });
        return (
          <MemoryBox key={key} memoryLayout={memoryLayout} title={label}
            className="memory-box" style={{ ...style, ...getMemoryBoxStyle(m.thumbnails) }}
            onClick={() => onViewMemory(m.ids)}>
            <div className="memory-text">
              <div className="title">{label}</div>
              <div className="description">All media from {label}</div>
            </div>
            <ThumbnailStrip thumbnails={m.thumbnails} />
            <div className="memory-count">{m.total} items</div>
          </MemoryBox>
        );
      }}
    />
  );

  const renderVacationBoxes = () => (
    <VirtualizedMemoryGrid memoryLayout={memoryLayout} items={vacations} {...gridSize}
      renderItem={(t, _index, key, style) => (
        <MemoryBox key={key} memoryLayout={memoryLayout} title={t.title}
          className="memory-box" style={{ ...style, ...getMemoryBoxStyle(t.thumbnails) }}
          onClick={() => onViewMemory(t.ids)}>
          <div className="memory-text">
            <div className="title">{t.title}</div>
            <div className="description">
              {t.start.slice(0, 10)} <FontAwesomeIcon icon={faArrowRight} />{" "}
              {t.end.slice(0, 10)}
            </div>
          </div>
          <ThumbnailStrip thumbnails={t.thumbnails} />
          <div className="memory-count">{t.total} items</div>
        </MemoryBox>
      )}
    />
  );

  const renderTripBoxes = () => (
    <VirtualizedMemoryGrid memoryLayout={memoryLayout} items={trips} {...gridSize}
      renderItem={(t, _index, key, style) => (
        <MemoryBox key={key} memoryLayout={memoryLayout} title={t.title}
          className="memory-box" style={{ ...style, ...getMemoryBoxStyle(t.thumbnails) }}
          onClick={() => onViewMemory(t.ids)}>
          <div className="memory-text">
            <div className="title">{t.title}</div>
            <div className="description">
              {t.start.slice(0, 10)} <FontAwesomeIcon icon={faArrowRight} />{" "}
              {t.end.slice(0, 10)}
            </div>
          </div>
          <ThumbnailStrip thumbnails={t.thumbnails} />
          <div className="memory-count">{t.total} items</div>
        </MemoryBox>
      )}
    />
  );

  const renderCustomMemories = () => (
    <VirtualizedMemoryGrid memoryLayout={memoryLayout} items={customMemories} {...gridSize}
      renderItem={(m, index, key, style) => {
        const isDragging = dragIndex === index;
        const dropClass =
          dropEdge &&
          dropEdge.index === index &&
          dragIndex !== null &&
          dragIndex !== index
            ? dropEdge.edge === "top"
              ? " memory-box--drop-top"
              : " memory-box--drop-bottom"
            : "";

        return (
          <MemoryBox
            key={key}
            memoryLayout={memoryLayout}
            title={m.title}
            data-memory-index={index}
            className={`memory-box${isDragging ? " memory-box--dragging" : ""}${dropClass}`}
            style={{
              ...style,
              ...getMemoryBoxStyle(m.thumbnails),
              cursor: dragIndex === index ? "grabbing" : "pointer",
            }}
            onMouseDown={(e) => handleCardMouseDown(e, index)}
            onClick={() => {
              if (drag.current.active) return;
              const mediaIds = JSON.parse(m.media_ids || "[]");
              if (memoryMode !== "edit" && mediaIds.length > 0) {
                onViewMemory(mediaIds);
                return;
              } else if (memoryMode !== "edit") {
                return;
              }
              setNewMemory({
                id: m.id,
                title: m.title,
                description: m.description,
                color: m.color,
                existing: mediaIds,
              });
              setShowAddMemory(true);
            }}
          >
            <div
              className="memory-color"
              style={{ backgroundColor: m.color }}
            ></div>
            <div className="memory-text">
              <div className="title">{m.title}</div>
              <div className="description">{m.description}</div>
            </div>
            <ThumbnailStrip thumbnails={m.thumbnails} />
            <div className="memory-count">{m.total} items</div>
          </MemoryBox>
        );
      }}
    />
  );

  const renderOnThisDay = () => {
    const today = new Date();
    const todayLabel = today.toLocaleDateString("en-US", {
      month: "long",
      day: "numeric",
    });

    if (onThisDay.length === 0) {
      return (
        <div className="memories-empty">
          <p>No memories found for {todayLabel} in previous years.</p>
        </div>
      );
    }

    return (
      <VirtualizedMemoryGrid memoryLayout={memoryLayout} items={onThisDay} {...gridSize}
        renderItem={(entry, _index, key, style) => {
          const yearsAgo = today.getFullYear() - entry.year;
          const yearsAgoLabel =
            yearsAgo === 1 ? "1 year ago" : `${yearsAgo} years ago`;

          return (
            <MemoryBox
              key={key}
              memoryLayout={memoryLayout}
              title={entry.year}
              className="memory-box"
              style={{ ...style, ...getMemoryBoxStyle(entry.thumbnails) }}
              onClick={() => onViewMemory(entry.ids)}
            >
              <div className="memory-text">
                <div className="title">{entry.year}</div>
                <div className="description">
                  {yearsAgoLabel} · {todayLabel}
                </div>
              </div>
              <ThumbnailStrip thumbnails={entry.thumbnails} />
              <div className="memory-count">{entry.total} items</div>
            </MemoryBox>
          );
        }}
      />
    );
  };

  const renderAllBoxes = () => {
    const items = [
      ...customMemories.map((m) => ({
        type: "custom",
        data: m,
        ts: m.created * 1000,
      })),
      ...years.map((y) => ({
        type: "year",
        data: y,
        ts: new Date(`${y.year}-12-01`).getTime(),
      })),
      ...months.map((m) => ({
        type: "month",
        data: m,
        ts: new Date(`${m.year}-${m.month}-01`).getTime(),
      })),
      ...trips.map((t) => ({
        type: "trip",
        data: t,
        ts: new Date(t.start).getTime(),
      })),
    ].sort((a, b) => b.ts - a.ts);

    return (
      <div
        className={`memories-grid ${memoryLayout === "grid" ? "grid-layout" : "list-layout"}`}
      >
        {items.map((item) => {
          if (item.type === "custom") {
            const m = item.data;
            return (
              <div
                key={`custom-${m.id}`}
                className="memory-box"
                style={getMemoryBoxStyle(m.thumbnails)}
                onClick={() => {
                  const mediaIds = JSON.parse(m.media_ids || "[]");
                  if (memoryMode !== "edit" && mediaIds.length > 0) {
                    onViewMemory(mediaIds);
                    return;
                  } else if (memoryMode !== "edit") return;
                  setNewMemory({
                    id: m.id,
                    title: m.title,
                    description: m.description,
                    color: m.color,
                    existing: mediaIds,
                  });
                  setShowAddMemory(true);
                }}
              >
                <div
                  className="memory-color"
                  style={{ backgroundColor: m.color }}
                ></div>
                <div className="memory-text">
                  <div className="title">{m.title}</div>
                  <div className="description">{m.description}</div>
                </div>
                <ThumbnailStrip thumbnails={m.thumbnails} />
                <div className="memory-count">{m.total} items</div>
              </div>
            );
          }
          if (item.type === "year") {
            const y = item.data;
            return (
              <div
                key={`year-${y.year}`}
                className="memory-box"
                style={getMemoryBoxStyle(y.thumbnails)}
                onClick={() => onViewMemory(y.ids)}
              >
                <div className="memory-text">
                  <div className="title">{y.year}</div>
                  <div className="description">All media from {y.year}</div>
                </div>
                <ThumbnailStrip thumbnails={y.thumbnails} />
                <div className="memory-count">{y.total} items</div>
              </div>
            );
          }
          if (item.type === "month") {
            const m = item.data;
            const date = new Date(`${m.year}-${m.month}-01`);
            const label = date.toLocaleString("en-US", {
              month: "long",
              year: "numeric",
            });
            return (
              <div
                key={`month-${m.year}-${m.month}`}
                className="memory-box"
                style={getMemoryBoxStyle(m.thumbnails)}
                onClick={() => onViewMemory(m.ids)}
              >
                <div className="memory-text">
                  <div className="title">{label}</div>
                  <div className="description">All media from {label}</div>
                </div>
                <ThumbnailStrip thumbnails={m.thumbnails} />
                <div className="memory-count">{m.total} items</div>
              </div>
            );
          }
          if (item.type === "trip") {
            const t = item.data;
            return (
              <div
                key={`trip-${t.id}`}
                className="memory-box"
                style={getMemoryBoxStyle(t.thumbnails)}
                onClick={() => onViewMemory(t.ids)}
              >
                <div className="memory-text">
                  <div className="title">{t.title}</div>
                  <div className="description">
                    {t.start.slice(0, 10)}{" "}
                    <FontAwesomeIcon icon={faArrowRight} /> {t.end.slice(0, 10)}
                  </div>
                </div>
                <ThumbnailStrip thumbnails={t.thumbnails} />
                <div className="memory-count">{t.total} items</div>
              </div>
            );
          }
          return null;
        })}
      </div>
    );
  };

  const renderVirtualizedAllBoxes = () => {
    const items = [
      ...customMemories.map((data) => ({ type: "custom", data, ts: data.created * 1000 })),
      ...years.map((data) => ({ type: "year", data, ts: new Date(`${data.year}-12-01`).getTime() })),
      ...months.map((data) => ({ type: "month", data, ts: new Date(`${data.year}-${data.month}-01`).getTime() })),
      ...trips.map((data) => ({ type: "trip", data, ts: new Date(data.start).getTime() })),
    ].sort((left, right) => right.ts - left.ts);

    return (
      <VirtualizedMemoryGrid memoryLayout={memoryLayout} items={items} {...gridSize}
        renderItem={(item, _index, key, style) => {
          const { data } = item;
          const isCustom = item.type === "custom";
          const title = item.type === "month"
            ? new Date(`${data.year}-${data.month}-01`).toLocaleString("en-US", { month: "long", year: "numeric" })
            : item.type === "year" ? data.year : data.title;
          const description = item.type === "year"
            ? `All media from ${data.year}`
            : item.type === "month"
              ? `All media from ${title}`
              : item.type === "trip"
                ? <>{data.start.slice(0, 10)} <FontAwesomeIcon icon={faArrowRight} /> {data.end.slice(0, 10)}</>
                : data.description;
          const openItem = () => {
            if (!isCustom) return onViewMemory(data.ids);
            const mediaIds = JSON.parse(data.media_ids || "[]");
            if (memoryMode !== "edit" && mediaIds.length > 0) return onViewMemory(mediaIds);
            if (memoryMode !== "edit") return;
            setNewMemory({ id: data.id, title: data.title, description: data.description, color: data.color, existing: mediaIds });
            setShowAddMemory(true);
          };

          return (
            <MemoryBox key={key} memoryLayout={memoryLayout} title={title} className="memory-box"
              style={{ ...style, ...getMemoryBoxStyle(data.thumbnails) }} onClick={openItem}>
              {isCustom && <div className="memory-color" style={{ backgroundColor: data.color }} />}
              <div className="memory-text">
                <div className="title">{title}</div>
                <div className="description">{description}</div>
              </div>
              <ThumbnailStrip thumbnails={data.thumbnails} />
              <div className="memory-count">{data.total} items</div>
            </MemoryBox>
          );
        }}
      />
    );
  };

  // --- HANDLE SAVE MEMORY ---
  const handleSaveMemory = async () => {
    try {
      if (memoryMode === "edit") {
        await window.electron.ipcRenderer.invoke("update-memory", newMemory);
      } else {
        await window.electron.ipcRenderer.invoke("add-memory", newMemory);
      }
      setShowAddMemory(false);
      switchMemoryMode(null);
      fetchCustomMemories();
    } catch (err) {
      console.error("Failed to save memory:", err);
    }
  };

  const handleDeleteMemory = async () => {
    if (!newMemory.id) return;
    try {
      await window.electron.ipcRenderer.invoke("delete-memory", {
        id: newMemory.id,
      });
      setShowAddMemory(false);
      switchMemoryMode(null);
      fetchCustomMemories();
    } catch (err) {
      console.error("Failed to delete memory:", err);
    }
  };

  return (
    <div className="memories-view">
      <div className="memories-main">
        <div className="settings-list">
          <ul>
            {[
              "All",
              "On This Day",
              "Custom",
              "Years",
              "Months",
              "Vacations",
              "Trips",
            ].map((tab) => (
              <li
                key={tab}
                className={`settings-list-item ${selectedTab === tab ? "settings-list-active" : ""} ${
                  memoryMode !== null && tab !== "Custom"
                    ? "settings-list-disabled"
                    : ""
                }`}
                onClick={() => {
                  if (memoryMode === null) setSelectedTab(tab);
                }}
              >
                <span>{tab}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="memories-content" ref={gridRef}>
          {loading && (
            <div className="memories-loading">
              <div className="loader"></div>
            </div>
          )}
          {!loading && selectedTab === "All" && renderVirtualizedAllBoxes()}
          {!loading && selectedTab === "Years" && renderYearBoxes()}
          {!loading && selectedTab === "Months" && renderMonthBoxes()}
          {!loading && selectedTab === "Custom" && renderCustomMemories()}
          {!loading && selectedTab === "Vacations" && renderVacationBoxes()}
          {!loading && selectedTab === "Trips" && renderTripBoxes()}
          {!loading && selectedTab === "On This Day" && renderOnThisDay()}
        </div>
      </div>

      {/* --- ADD MEMORY POPUP --- */}
      {showAddMemory && (
        <Popup
          title="Add New Memory"
          actions={[
            {
              label: "Cancel",
              kind: "secondary",
              onClick: () => {
                setShowAddMemory(false);
                switchMemoryMode(null);
              },
            },
            ...(memoryMode === "edit"
              ? [
                  {
                    label: "Delete",
                    kind: "danger",
                    onClick: handleDeleteMemory,
                    style: { borderRadius: "0px" },
                  },
                  {
                    label: "Select Media",
                    kind: "primary",
                    onClick: () => {
                      setShowAddMemory(false);
                      switchMemoryMode(null);
                      onAddMedia(newMemory);
                    },
                    style: { borderRadius: "0px" },
                  },
                ]
              : []),
            {
              label: memoryMode === "edit" ? "Save Changes" : "Add Memory",
              kind: "primary",
              onClick: handleSaveMemory,
            },
          ]}
        >
          <input
            type="text"
            placeholder="Title"
            className="input"
            maxLength={20}
            value={newMemory.title}
            onChange={(e) =>
              setNewMemory({ ...newMemory, title: e.target.value })
            }
          />
          <input
            placeholder="Description (short)"
            className="input"
            maxLength={20}
            value={newMemory.description}
            onChange={(e) =>
              setNewMemory({ ...newMemory, description: e.target.value })
            }
          />
          <div className="color-picker">
            <label>Color</label>
            <input
              type="color"
              value={newMemory.color}
              onChange={(e) =>
                setNewMemory({ ...newMemory, color: e.target.value })
              }
            />
          </div>

          {memoryMode !== "edit" && (
            <div className="quick-add-ui">
              <label>Quick Add</label>
              <div className="filter-row">
                <span>Start Date:</span>
                <input
                  type="date"
                  className="date-input"
                  value={newMemory.startDate || ""}
                  onChange={(e) =>
                    setNewMemory({ ...newMemory, startDate: e.target.value })
                  }
                />
              </div>
              <div className="filter-row">
                <span>End Date:</span>
                <input
                  type="date"
                  className="date-input"
                  value={newMemory.endDate || ""}
                  onChange={(e) =>
                    setNewMemory({ ...newMemory, endDate: e.target.value })
                  }
                />
              </div>
              <div className="filter-row">
                <span>ID from:</span>
                <input
                  type="number"
                  className="input"
                  value={newMemory.mediaFrom || ""}
                  onChange={(e) =>
                    setNewMemory({ ...newMemory, mediaFrom: e.target.value })
                  }
                />
              </div>
              <div className="filter-row">
                <span>ID to:</span>
                <input
                  type="number"
                  className="input"
                  value={newMemory.mediaTo || ""}
                  onChange={(e) =>
                    setNewMemory({ ...newMemory, mediaTo: e.target.value })
                  }
                />
              </div>
              <div className="filter-row">
                <span>Path starts with:</span>
                <input
                  type="text"
                  className="input"
                  placeholder="/photos/vacation/"
                  value={newMemory.pathStartsWith || ""}
                  onChange={(e) =>
                    setNewMemory({
                      ...newMemory,
                      pathStartsWith: e.target.value,
                    })
                  }
                />
              </div>
              <div className="memory-hint">
                You can manually add photo's after creating the memory
              </div>
            </div>
          )}
        </Popup>
      )}

      <SnackbarProvider maxSnack={1} />
    </div>
  );
};

export default MemoriesView;
