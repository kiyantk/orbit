import React, {
  useEffect,
  useRef,
  useState,
  useCallback,
  useMemo,
  useDeferredValue
} from "react";

const GAP = 0;
const MAX_WIDTH = 400;
const BASE_TILE = 42;

// How many extra rows to render above/below the viewport (render buffer)
const OVERSCAN_ROWS = 3;

// ─── Layout computation ───────────────────────────────────────────────────────
function computeLayout(scale, containerWidth, totalCount) {
  const width = Math.min(containerWidth, MAX_WIDTH);
  const tileSize = Math.max(14, BASE_TILE * (scale / 0.4));
  const step = tileSize + GAP;
  const cols = Math.max(1, Math.floor(width / step));
  const totalRows = Math.ceil(totalCount / cols);
  const totalHeight = totalRows * step;
  return { width, tileSize, step, cols, totalRows, totalHeight };
}

// ─── Single tile ─────────────────────────────────────────────────────────────
// Memoized so only tiles whose src changes re-render.
const Tile = React.memo(({ item, size, onClick }) => {
  const src = item?.thumbnail_path
    ? `orbit://thumbs/${item.id}_thumb_64.jpg`
    : null;

  return (
    <div
      onClick={onClick}
      style={{
        width: size,
        height: size,
        flexShrink: 0,
        cursor: "pointer",
        overflow: "hidden",
        backgroundColor: src
          ? undefined
          : item
            ? "var(--color-surface-base)"
            : "var(--color-surface-sunken)",
        userSelect: "none",
      }}
    >
      {src && (
        <img
          key={item.id}
          src={src}
          width={size}
          height={size}
          draggable={false}
          style={{ display: "block", width: "100%", height: "100%", objectFit: "cover" }}
          // Don't decode on the main thread; browser handles async
          decoding="async"
          loading="lazy"
        />
      )}
    </div>
  );
});

// ─── Row of tiles ────────────────────────────────────────────────────────────
const TileRow = React.memo(({ rowIndex, cols, items, itemOffset, totalCount, tileSize, step, onClickItem }) => {
  const startIndex = rowIndex * cols;
  const tiles = [];

  for (let col = 0; col < cols; col++) {
    const index = startIndex + col;
    if (index >= totalCount) break;
    const item = items[index - itemOffset];

    tiles.push(
      <Tile
        key={index}
        item={item}
        size={tileSize}
        onClick={item?.id ? () => onClickItem(item) : undefined}
      />
    );
  }

  return (
    <div
      style={{
        position: "absolute",
        top: rowIndex * step,
        left: 0,
        display: "flex",
        gap: GAP,
      }}
    >
      {tiles}
    </div>
  );
});

function useDebounced(value, delay = 120) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

// ─── Component ────────────────────────────────────────────────────────────────
const OverviewMosaic = ({
  scale,
  fetchItems,
  containerWidth,
  containerHeight,
  scrollTop: controlledScrollTop,
  onSelectItem,
  totalCount,
  onMosaicScroll
}) => {
  const scrollRef = useRef(null);
  const [scrollTop, setScrollTop] = useState(controlledScrollTop ?? 0);
  const ticking = useRef(false);

  const debouncedScale = useDebounced(scale, 120);
const deferredWidth = useDeferredValue(containerWidth);

const layout = useMemo(
  () => computeLayout(debouncedScale, deferredWidth, totalCount),
  [debouncedScale, deferredWidth, totalCount]
);

  // Sync externally controlled scrollTop
  useEffect(() => {
    if (controlledScrollTop != null && scrollRef.current) {
      scrollRef.current.scrollTop = controlledScrollTop;
    }
  }, [controlledScrollTop]);

  // Passive scroll handler — use RAF to throttle state updates to one per frame
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const onScroll = () => {
      if (!ticking.current) {
        ticking.current = true;
        requestAnimationFrame(() => {
          setScrollTop(el.scrollTop);
          onMosaicScroll?.(el.scrollTop);
          ticking.current = false;
        });
      }
    };

    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // Click handler with IPC fetch
  const handleClickItem = useCallback(async (item) => {
    if (!item?.id) return;
    try {
      const res = await window.electron.ipcRenderer.invoke("get-item-by-id", item.id);
      if (res?.success && res.item) {
        onSelectItem?.(res.item);
      } else {
        console.warn("Failed to resolve item", res?.error);
      }
    } catch (err) {
      console.error("IPC fetch failed:", err);
    }
  }, [onSelectItem]);

  const { width, tileSize, step, cols, totalRows, totalHeight } = layout;

  // Which rows are visible (+ overscan buffer)
  const firstVisibleRow = Math.max(0, Math.floor(scrollTop / step) - OVERSCAN_ROWS);
  const lastVisibleRow = Math.min(
    totalRows - 1,
    Math.ceil((scrollTop + containerHeight) / step) + OVERSCAN_ROWS
  );

    const startIndex = firstVisibleRow * cols;
  const endIndex = (lastVisibleRow + 1) * cols;
  const visibleItems = fetchItems(startIndex, endIndex);

  const visibleRows = [];
  for (let row = firstVisibleRow; row <= lastVisibleRow; row++) {
    const rowStart = row * cols - startIndex; // offset into visibleItems slice
    visibleRows.push(
      <TileRow
        key={row}
        rowIndex={row}
        cols={cols}
        items={visibleItems}
        itemOffset={startIndex}   // ← add this so TileRow indexes correctly
        totalCount={totalCount}
        tileSize={tileSize}
        step={step}
        onClickItem={handleClickItem}
      />
    );
  }

  return (
    <div
      ref={scrollRef}
      style={{
        width: "100%",
        height: "100%",
        overflowY: "auto",
        // Promote to its own compositor layer — scroll happens off main thread
        willChange: "scroll-position",
        position: "relative",
      }}
    >
      <div style={{ display: "flex", justifyContent: "center" }}>
        <div
          style={{
            width: "100%",
            maxWidth: MAX_WIDTH,
            // Full scroll height so the scrollbar is correct
            height: totalHeight,
            position: "relative",
          }}
        >
          {visibleRows}
        </div>
      </div>
    </div>
  );
};

export default OverviewMosaic;
