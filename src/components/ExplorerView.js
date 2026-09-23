// ExplorerView.jsx
import React, { useEffect, useState, useCallback, useRef } from "react";
import { Grid, AutoSizer, InfiniteLoader } from "react-virtualized";
import "./ExplorerView.css";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faArrowRight,
  faVideo,
  faXmark,
} from "@fortawesome/free-solid-svg-icons";
import ContextMenu from "./ContextMenu";
import Popup from "./Popup";
import { SnackbarProvider, enqueueSnackbar } from "notistack";
import TimelineOverlay from "./TimelineOverlay";
import OverviewMosaic from "./OverviewMosaic";

// ─── Constants ───────────────────────────────────────────────────────────────
const BASE_COLUMN_WIDTH = 130;
const BASE_ROW_HEIGHT = 130;
const GUTTER = 10;
const PAGE_SIZE = 200;
const DRAG_THRESHOLD = 6;

// ─── Helpers ─────────────────────────────────────────────────────────────────
function formatLocalDateString(str) {
  if (!str) return "";
  const [datePart, timePart] = str.split(" ");
  if (!datePart) return "";
  const [year, month, day] = datePart.split("-");
  return `${day}-${month}-${year}${timePart ? " " + timePart : ""}`;
}

function formatTimestamp(timestamp) {
  if (!timestamp) return "";
  const date = new Date(timestamp * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return [
    `${pad(date.getDate())}-${pad(date.getMonth() + 1)}-${date.getFullYear()}`,
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`,
  ].join(" ");
}

const FacePickerPopup = ({ selection, busy, onCancel, onSelect }) => (
  <Popup
    title="Select a face"
    width={620}
    contentWidth="92%"
    actions={[{ label: "Cancel", kind: "secondary", onClick: onCancel, disabled: busy }]}
  >
    <p className="person-picker-description">Choose the face bounding box to update.</p>
    <div className="person-face-picker">
      <img src={`http://localhost:54055/files/${encodeURIComponent(selection.item.path)}`} alt="Choose a face" />
      {selection.faces.map((face, index) => (
        <button
          key={face.faceId}
          type="button"
          className="person-face-picker-box"
          style={{
            left: `${Number(face.boxLeft) * 100}%`,
            top: `${Number(face.boxTop) * 100}%`,
            width: `${Number(face.boxWidth) * 100}%`,
            height: `${Number(face.boxHeight) * 100}%`,
          }}
          onClick={() => onSelect(face)}
          disabled={busy}
          aria-label={`Select face ${index + 1}`}
        >
          <span>Face {index + 1}</span>
        </button>
      ))}
      {busy && <div className="person-face-picker-busy"><div className="loader" /></div>}
    </div>
  </Popup>
);

const PersonPickerPopup = ({ selection, busy, onCancel, onSelect }) => {
  const [query, setQuery] = useState("");
  const matchingPeople = selection.people.filter((person, index) => (
    person.id !== selection.excludePersonId &&
    (person.name || `Person ${index + 1}`).toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
  ));
  return (
    <Popup
      title={selection.title || "Add to person"}
      width={500}
      contentWidth="92%"
      actions={[{ label: "Cancel", kind: "secondary", onClick: onCancel, disabled: busy }]}
    >
      <p className="person-picker-description">Choose the person to add the selected face to.</p>
      <input
        className="settings-content-input"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search people..."
        autoFocus
      />
      <div className="person-target-list">
        {matchingPeople.map((person, index) => (
          <button key={person.id} type="button" onClick={() => onSelect(person)} disabled={busy}>
            {person.hidden ? "Hidden — " : ""}{person.name || `Person ${index + 1}`}
          </button>
        ))}
        {!matchingPeople.length && <span>No people match your search.</span>}
        {busy && <div className="person-picker-busy"><div className="loader" /></div>}
      </div>
    </Popup>
  );
};

const Cell = React.memo(
  ({
    columnIndex,
    rowIndex,
    style,
    item,
    totalCount,
    noGutters,
    scale,
    rowHeight,
    explorerMode,
    addModeSelected,
    removeModeSelected,
    selectedItemIds,
    currentSettings,
    folderStatuses,
    dragJustFinishedRef,
    handleAddModeClick,
    handleRemoveModeClick,
    handleClick,
    handleMouseEnter,
    handleMouseLeave,
    handleSelect,
    handleContextMenu,
    getItemName,
    columnCount,
    key,
  }) => {
    const index = rowIndex * columnCount + columnIndex;
    if (!totalCount || index >= totalCount) return null;

    const cellStyle = { ...style, padding: noGutters ? 0 : 8 };

    if (!item) {
      return (
        <div key={key} style={style}>
          <div
            className="thumb-skeleton"
            style={{ height: rowHeight - 16, borderRadius: noGutters ? 0 : 6 }}
          />
        </div>
      );
    }

    const folderAvailable = folderStatuses[item.folder_path] ?? true;
    const thumbSrc = item.thumbnail_path
      ? `orbit://thumbs/${item.id}_thumb.jpg`
      : null;
    const useUnavailableThumbnail =
      currentSettings?.unavailableBehaviour === "thumbnail";
    const isNoGutterNoText = noGutters && currentSettings?.itemText === "none";
    const hideText = scale <= 0.5 || currentSettings?.itemText === "none";

    const isInAddMode =
      explorerMode?.enabled &&
      (explorerMode.type === "tag" || explorerMode.type === "memory");
    const isInRemoveMode =
      explorerMode?.enabled && explorerMode.type === "remove";

    const cellClass = [
      "thumb-cell",
      isNoGutterNoText ? "thumb-no-gutter" : "",
      isInAddMode && addModeSelected.has(item.id)
        ? "thumb-selected-addmode"
        : isInRemoveMode && removeModeSelected.has(item.id)
          ? "thumb-selected-removemode"
          : selectedItemIds.has(item.id)
            ? "thumb-selected"
            : "thumb-item",
    ]
      .filter(Boolean)
      .join(" ");

    const handleCellClick = (e) => {
      // Suppress click if it was a drag operation
      if (dragJustFinishedRef.current) {
        dragJustFinishedRef.current = false;
        return;
      }
      if (isInAddMode) handleAddModeClick(item);
      else if (isInRemoveMode) handleRemoveModeClick(item);
      else handleClick(e, item);
    };

    return (
      <div
        style={cellStyle}
        className={cellClass}
        onMouseEnter={() => handleMouseEnter(item)}
        onMouseLeave={() => handleMouseLeave(item)}
        onClick={handleCellClick}
        onDoubleClick={() => folderAvailable && handleSelect(item, "double")}
        onContextMenu={(e) => {
          e.preventDefault();
          handleContextMenu(e, item);
        }}
      >
        <div
          className="thumb-card"
          title={`${item.filename}\n${formatLocalDateString(item.create_date_local) || formatTimestamp(item.create_date) || formatTimestamp(item.created) || ""}`}
          style={{
            width: "100%",
            height: scale <= 0.5 || isNoGutterNoText ? "100%" : rowHeight - 36,
            borderRadius: noGutters ? 0 : 6,
          }}
        >
          {thumbSrc ? (
            <img
              alt={item.filename}
              src={thumbSrc}
              className="thumb-img"
              style={{
                objectFit: noGutters ? "cover" : "contain",
                borderRadius: noGutters ? 0 : 6,
              }}
              onError={(e) => {
                e.currentTarget.onerror = null;
                e.currentTarget.src = "";
              }}
              draggable={false}
            />
          ) : (
            <div className="thumb-no-image">No preview</div>
          )}

          {item.file_type === "video" && scale > 0.6 && (
            <div className="thumb-video-indicator">
              <FontAwesomeIcon icon={faVideo} />
            </div>
          )}

          {!folderAvailable && !useUnavailableThumbnail && (
            <div className="thumb-video-unavailable">Unavailable</div>
          )}
        </div>

        <div
          className={`thumb-filename${!folderAvailable ? " thumb-filename-unavailable" : ""}${hideText ? " thumb-hidden" : ""}`}
          title={getItemName(item)}
          style={{
            marginTop: 4,
            fontSize: 12,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {getItemName(item)}
        </div>
      </div>
    );
  },
);

// ─── Component ───────────────────────────────────────────────────────────────
const ExplorerView = ({
  currentSettings,
  folderStatuses,
  openSettings,
  onSelect,
  onTagAssign,
  onScale,
  filters,
  filteredCountUpdated,
  scrollPosition,
  setScrollPosition,
  actionPanelType,
  resetFilters,
  itemDeleted,
  explorerMode,
  setExplorerMode,
  explorerScale,
  onFindSimilar,
  explorerLoading,
  itemToReveal,
  setItemToReveal,
  onPersonItemsRemoved,
  activePersonId,
  onActivePersonChange,
}) => {
  const [totalCount, setTotalCount] = useState(null);
  const [containerWidth, setContainerWidth] = useState(1200);
  const [scale, setScale] = useState(Number(explorerScale) || 1);
  const [selectedItem, setSelectedItem] = useState(null);
  const [selectedItemIds, setSelectedItemIds] = useState(new Set());
  const [addModeSelected, setAddModeSelected] = useState(new Set());
  const [removeModeSelected, setRemoveModeSelected] = useState(new Set());
  const [contextMenu, setContextMenu] = useState(null);
  const [facePicker, setFacePicker] = useState(null);
  const [personPicker, setPersonPicker] = useState(null);
  const [faceActionBusy, setFaceActionBusy] = useState(false);
  const [noGutters, setNoGutters] = useState(false);
  const [, forceUpdate] = useState(0);
  const [currentScrollTop, setCurrentScrollTop] = useState(0);
  const [monthData, setMonthData] = useState(null);
  const [actualScrollHeight, setActualScrollHeight] = useState(0);
  const overviewIndexRef = useRef([]);
  const overviewRequestId = useRef(0);
  const scrollAnchorRef = useRef({ itemIndex: 0, offsetWithinRow: 0 });
  const visualScaleRef = useRef(scale);
  const scaleDebounceTimer = useRef(null);
  const gridOuterRef = useRef(null);
  const mosaicScrollTopRef = useRef(0);
  const fetchGeneration = useRef(0);

  // ─── Drag-select state ────────────────────────────────────────────────────
  const [dragContentRect, setDragContentRect] = useState(null); // { left, top, width, height } in content coords (drives visual)

  const itemsRef = useRef([]);
  const idToIndex = useRef(new Map());
  const loadingPages = useRef(new Set());
  const gridRef = useRef(null);
  const nodeRef = useRef(null);
  const anchorIndexRef = useRef(0);
  const isRestoringScrollRef = useRef(false);
  const prefetchTimer = useRef(null);
  const loadMoreTimeout = useRef(null);
  const selectedItemRef = useRef(null);
  const onSelectRef = useRef(null);
  const itemDeletedRef = useRef(null);

  useEffect(() => {
    selectedItemRef.current = selectedItem;
  }, [selectedItem]);

  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);

  useEffect(() => {
    itemDeletedRef.current = itemDeleted;
  }, [itemDeleted]);

  // ─── Drag-select refs ─────────────────────────────────────────────────────
  const dragStartRef = useRef(null); // { x, y } viewport coords at mousedown
  const dragScrollTopRef = useRef(0); // live scrollTop during drag
  const dragStartScrollTop = useRef(0); // scrollTop captured at mousedown
  const dragPreExisting = useRef(new Set()); // selection snapshot before drag started
  const dragSelectionModeRef = useRef(null); // "add" or "remove"
  const isDraggingRef = useRef(false);
  const dragRectRef = useRef(null); // mirrors dragRect without triggering re-renders mid-drag
  const lastMouseY = useRef(0);
  const dragPendingRef = useRef(null); // { x, y, selection snapshot, mode } while waiting to confirm drag
  const dragJustFinishedRef = useRef(false);

  // ─── Derived layout values ────────────────────────────────────────────────
  const columnWidth = BASE_COLUMN_WIDTH * scale;
  const rowHeight = BASE_ROW_HEIGHT * scale;
  const gutterSize = noGutters ? 0 : GUTTER;
  const columnCount = Math.max(
    1,
    Math.floor(containerWidth / (columnWidth + gutterSize)),
  );
  const rowCount = totalCount ? Math.ceil(totalCount / columnCount) : 0;
  const gridHeight = Math.max(400, window.innerHeight - 71);
  const totalHeight = rowCount * rowHeight;
  const isOverviewMode = scale < 0.4;

  // Cell size including gutter (what react-window uses as stride)
  const cellStride = columnWidth + gutterSize;
  const rowStride = rowHeight; // react-window rowHeight already accounts for the cell height

  // ─── Item text label ──────────────────────────────────────────────────────
  const getItemName = useCallback(
    (item) => {
      const mode = currentSettings?.itemText ?? "filename";
      if (mode === "none") return undefined;
      if (mode === "datetime") {
        if (item.create_date_local)
          return formatLocalDateString(item.create_date_local);
        if (item.create_date) return formatTimestamp(item.create_date);
        const earliest = [item.created, item.modified].filter(Boolean);
        if (earliest.length) return formatTimestamp(Math.min(...earliest));
        return undefined;
      }
      return item.filename;
    },
    [currentSettings?.itemText],
  );

  // ─── Item store helpers ───────────────────────────────────────────────────
  const addItems = useCallback((rows, offset) => {
    rows.forEach((row, i) => {
      const idx = offset + i;
      itemsRef.current[offset + i] = row;
      idToIndex.current.set(row.id, idx);
    });
    forceUpdate((x) => x + 1);
  }, []);

  // ─── Data fetching ────────────────────────────────────────────────────────
const fetchPageForIndex = useCallback(
  async (index, isFirst = false, generation) => {
    const pageIndex = Math.floor(index / PAGE_SIZE);
    if (loadingPages.current.has(pageIndex)) return;
    loadingPages.current.add(pageIndex);

    const offset = isFirst ? 0 : pageIndex * PAGE_SIZE;
    try {
      const res = await window.electron.ipcRenderer.invoke("fetch-files", {
        offset,
        limit: PAGE_SIZE,
        filters: filters || {},
        settings: currentSettings || {},
      });
      // Discard if a newer filter set has since been applied
      if (generation !== fetchGeneration.current) return;
      if (res?.success) addItems(res.rows, offset);
    } catch (err) {
      console.error("fetchPage error", err);
    } finally {
      loadingPages.current.delete(pageIndex);
    }
  },
  [filters, currentSettings, addItems],
);

const fetchTotalCount = useCallback(async (generation) => {
  try {
    const count = await window.electron.ipcRenderer.invoke(
      "get-filtered-files-count",
      { filters, settings: currentSettings || {} },
    );
    if (generation !== fetchGeneration.current) return;
    const n = Number(count) || 0;
    setTotalCount(n);
    filteredCountUpdated(n || null);
  } catch (err) {
    console.error("fetchTotalCount error", err);
  }
}, [filters, currentSettings, filteredCountUpdated]);

  const refreshExplorerForPeopleAction = useCallback(() => {
    const generation = ++fetchGeneration.current;
    itemsRef.current = {};
    idToIndex.current = new Map();
    loadingPages.current.clear();
    setTotalCount(null);
    fetchTotalCount(generation);
    fetchPageForIndex(0, true, generation);
  }, [fetchPageForIndex, fetchTotalCount]);

  const removePersonItemFromGrid = useCallback((itemId) => {
    const index = idToIndex.current.get(itemId);
    if (index == null) return;
    delete itemsRef.current[index];
    idToIndex.current.delete(itemId);
    setTotalCount((current) => current == null ? current : Math.max(0, current - 1));
    if (selectedItemRef.current?.id === itemId) {
      setSelectedItem(null);
      onSelectRef.current(null, "single");
    }
    forceUpdate((current) => current + 1);
  }, []);

  const reconcileActivePerson = useCallback(async (removedItemIds = []) => {
    if (!activePersonId) return;
    const removedIds = new Set(removedItemIds);
    const remainingIds = (filters?.ids || [])
      .filter((id) => !removedIds.has(id));
    const result = await window.electron.ipcRenderer.invoke(
      "people:resolve-person-for-files",
      { fileIds: remainingIds, preferredPersonId: activePersonId },
    );
    if (result?.success) onActivePersonChange(result.personId);
  }, [activePersonId, filters?.ids, onActivePersonChange]);

  const runFaceAction = useCallback(async (action, face, targetPersonId = null, optimisticItemId = null) => {
    setFaceActionBusy(true);
    if (optimisticItemId != null) removePersonItemFromGrid(optimisticItemId);
    try {
      const result = await window.electron.ipcRenderer.invoke("people:face-action", {
        action,
        faceId: face.faceId,
        targetPersonId,
      });
      if (!result?.success) throw new Error(result?.error || "Unable to update this face.");
      setFacePicker(null);
      setPersonPicker(null);
      if (optimisticItemId != null) {
        onPersonItemsRemoved([optimisticItemId]);
        await reconcileActivePerson([optimisticItemId]);
      }
      refreshExplorerForPeopleAction();
    } catch (error) {
      enqueueSnackbar(error.message || "Unable to update this face.", { variant: "error" });
      if (optimisticItemId != null) refreshExplorerForPeopleAction();
    } finally {
      setFaceActionBusy(false);
    }
  }, [onPersonItemsRemoved, reconcileActivePerson, refreshExplorerForPeopleAction, removePersonItemFromGrid]);

  const runFaceActions = useCallback(async (action, faces, targetPersonId = null, removedItemIds = []) => {
    setFaceActionBusy(true);
    try {
      for (const face of faces) {
        const result = await window.electron.ipcRenderer.invoke("people:face-action", {
          action,
          faceId: face.faceId,
          targetPersonId,
        });
        if (!result?.success) {
          throw new Error(result?.error || "Unable to update selected faces.");
        }
      }
      setFacePicker(null);
      setPersonPicker(null);
      if (removedItemIds.length) {
        removedItemIds.forEach(removePersonItemFromGrid);
        onPersonItemsRemoved(removedItemIds);
        await reconcileActivePerson(removedItemIds);
      }
      refreshExplorerForPeopleAction();
    } catch (error) {
      enqueueSnackbar(error.message || "Unable to update selected faces.", { variant: "error" });
    } finally {
      setFaceActionBusy(false);
    }
  }, [onPersonItemsRemoved, reconcileActivePerson, refreshExplorerForPeopleAction, removePersonItemFromGrid]);

  const openPersonPickerForFace = useCallback(async (
    face,
    excludePersonId = null,
    title = "Add to person",
    removedItemId = null,
  ) => {
    setFaceActionBusy(true);
    try {
      const peopleResult = await window.electron.ipcRenderer.invoke("people:list");
      const people = peopleResult?.success ? peopleResult.data ?? [] : [];
      setFacePicker(null);
      setPersonPicker({ face, people, excludePersonId, title, removedItemId });
    } catch (error) {
      enqueueSnackbar("Unable to load people.", { variant: "error" });
    } finally {
      setFaceActionBusy(false);
    }
  }, []);

  const openPersonFacePicker = useCallback(async (action, item, selectedIds = [item.id]) => {
    setContextMenu(null);
    const personId = (action === "separate" || action === "set-avatar" || action === "hide-not-face" || action === "not-same-person") ? activePersonId : null;
    try {
      const results = await Promise.all(selectedIds.map((fileId) =>
        window.electron.ipcRenderer.invoke("people:list-faces", { fileId, personId }),
      ));
      const faces = results.flatMap((result) => result?.success ? result.data ?? [] : []);
      if (!faces.length) {
        enqueueSnackbar("No matching detected face was found in this item.", { variant: "warning" });
        return;
      }
      if (selectedIds.length > 1) {
        if (action === "not-same-person") {
          setFaceActionBusy(true);
          try {
            const peopleResult = await window.electron.ipcRenderer.invoke("people:list");
            const people = peopleResult?.success ? peopleResult.data ?? [] : [];
            setPersonPicker({
              targetFaces: faces,
              people,
              excludePersonId: activePersonId,
              title: "Not the same person",
              removedItemIds: selectedIds,
            });
          } finally {
            setFaceActionBusy(false);
          }
        } else {
          await runFaceActions(action, faces, activePersonId, selectedIds);
        }
        return;
      }
      if (faces.length === 1 && action !== "add-to-person") {
        if (action === "not-same-person") {
          await openPersonPickerForFace(
            faces[0],
            activePersonId,
            "Not the same person",
            item.id,
          );
        } else {
          await runFaceAction(
            action,
            faces[0],
            activePersonId,
            action === "separate" || action === "hide-not-face" ? item.id : null,
          );
        }
        return;
      }
      setFacePicker({ action, item, faces, activePersonId });
    } catch (error) {
      enqueueSnackbar("Unable to load faces for this item.", { variant: "error" });
    }
  }, [activePersonId, openPersonPickerForFace, runFaceAction, runFaceActions]);

  const selectFaceForPersonAction = useCallback(async (face) => {
    if (!facePicker) return;
    if (facePicker.action === "add-to-person" || facePicker.action === "not-same-person") {
      await openPersonPickerForFace(
        face,
        facePicker.action === "not-same-person" ? facePicker.activePersonId : null,
        facePicker.action === "not-same-person" ? "Not the same person" : "Add to person",
        facePicker.action === "not-same-person" ? facePicker.item.id : null,
      );
      return;
    }
    const removesOnlyFaceInItem =
      (facePicker.action === "separate" || facePicker.action === "hide-not-face") &&
      facePicker.faces.length === 1;
    await runFaceAction(
      facePicker.action,
      face,
      facePicker.activePersonId,
      removesOnlyFaceInItem ? facePicker.item.id : null,
    );
  }, [facePicker, openPersonPickerForFace, runFaceAction]);

  const fetchAllIds = useCallback(async () => {
    const res = await window.electron.ipcRenderer.invoke("fetch-files", {
      offset: 0,
      limit: totalCount,
      filters: filters || {},
      settings: currentSettings || {},
      idsOnly: true,
    });
    return res?.rows?.map((r) => r.id) ?? [];
  }, [filters, currentSettings, totalCount]);

  // ─── InfiniteLoader callback (debounced) ──────────────────────────────────
  const isItemLoaded = (index) => !!itemsRef.current[index];

  const loadMoreItems = useCallback(
  (startIndex, stopIndex) => {
    if (loadMoreTimeout.current) clearTimeout(loadMoreTimeout.current);
    const generation = fetchGeneration.current; // capture at scheduling time
    return new Promise((resolve) => {
      loadMoreTimeout.current = setTimeout(() => {
        const startPage = Math.floor(startIndex / PAGE_SIZE);
        const endPage = Math.floor(stopIndex / PAGE_SIZE);
        const promises = [];
        for (let p = startPage; p <= endPage; p++) {
          promises.push(fetchPageForIndex(p * PAGE_SIZE, false, generation));
        }
        Promise.all(promises).then(resolve);
      }, 50);
    });
  },
  [fetchPageForIndex],
);

  // ─── Tags ─────────────────────────────────────────────────────────────────
  const getTags = useCallback(async () => {
    const res = await window.electron.ipcRenderer.invoke("tags:get-all");
    const freshTags = res || [];
    return freshTags;
  }, []);

  const tagCurrentlySelected = useCallback(
    async (item) => {
      const freshTags = await getTags();
      const tag = freshTags?.[0];
      if (!tag) return;

      const isTagged =
        Array.isArray(tag.media_ids) && tag.media_ids.includes(item.id);
      if (isTagged) {
        await window.electron.ipcRenderer.invoke("tag:remove-item", {
          tagId: tag.id,
          mediaId: item.id,
        });
        enqueueSnackbar(`Removed tag '${tag.name}' from selected item`);
      } else {
        await window.electron.ipcRenderer.invoke("tag:add-item", {
          tagId: tag.id,
          mediaId: item.id,
        });
        enqueueSnackbar(`Added tag '${tag.name}' to selected item`);
      }

      await getTags();
      onTagAssign(item);
    },
    [getTags, onTagAssign],
  );

  // ─── Selection helpers ────────────────────────────────────────────────────
  const handleSelect = useCallback(
    (item, type) => {
      onSelect(item, type);
      setSelectedItem(item);
      setSelectedItemIds(item ? new Set([item.id]) : new Set());
    },
    [onSelect],
  );

  const handleClick = useCallback(
    (e, item) => {
      // if (!folderStatuses[item.folder_path]) return;
      if (e.shiftKey) {
        window.electron.ipcRenderer.invoke("open-in-default-viewer", item.path);
      } else if (e.ctrlKey) {
        const next = new Set(selectedItemIds);
        if (next.has(item.id)) {
          next.delete(item.id);
          if (!next.size) {
            setSelectedItem(null);
            onSelect(null, "single");
          }
        } else {
          next.add(item.id);
          setSelectedItem(item);
          onSelect(item, "single");
        }
        setSelectedItemIds(next);
      } else {
        handleSelect(item, "single");
      }
    },
    [handleSelect, onSelect, selectedItemIds],
  );

  const handleContextMenu = useCallback((e, item) => {
    let itemIds;
    if (selectedItemIds.has(item.id)) {
      itemIds = [...selectedItemIds];
    } else {
      itemIds = [item.id];
      setSelectedItemIds(new Set(itemIds));
      setSelectedItem(item);
      onSelect(item, "single");
    }
    setContextMenu({ x: e.clientX, y: e.clientY, item, itemIds });
  }, [onSelect, selectedItemIds]);

  const handleAddModeClick = useCallback((item) => {
    setAddModeSelected((prev) => {
      const next = new Set(prev);
      next.has(item.id) ? next.delete(item.id) : next.add(item.id);
      return next;
    });
  }, []);

  const handleRemoveModeClick = useCallback((item) => {
    setRemoveModeSelected((prev) => {
      const next = new Set(prev);
      next.has(item.id) ? next.delete(item.id) : next.add(item.id);
      return next;
    });
  }, []);

  const handleRemoveItem = useCallback(async (itemId) => {
    try {
      const ids = Array.isArray(itemId) ? itemId : [itemId];
      await window.electron.ipcRenderer.invoke("remove-item-from-index", ids);
    } catch (err) {
      console.error("Failed to remove item:", err);
    }
  }, []);

  // ─── HEIC prefetch ────────────────────────────────────────────────────────
  const handleMouseEnter = useCallback(
    (item) => {
      if (
        !currentSettings?.preloadHeic ||
        item.extension !== ".heic" ||
        !folderStatuses[item.folder_path]
      )
        return;
      prefetchTimer.current = setTimeout(() => {
        fetch(
          `http://localhost:54055/prefetch-heic/${encodeURIComponent(item.path)}`,
        ).catch(() => {});
      }, 300);
    },
    [currentSettings?.preloadHeic, folderStatuses],
  );

  const handleMouseLeave = useCallback(
    (item) => {
      if (!currentSettings?.preloadHeic) return;
      clearTimeout(prefetchTimer.current);
      if (item?.extension === ".heic") {
        fetch(
          `http://localhost:54055/cancel-heic/${encodeURIComponent(item.path)}`,
        ).catch(() => {});
      }
    },
    [currentSettings?.preloadHeic],
  );

  // ─── Scroll handling ──────────────────────────────────────────────────────
  const handleScroll = useCallback(
    ({ scrollTop, scrollUpdateWasRequested }) => {
      // Keep drag scroll tracker in sync
      dragScrollTopRef.current = scrollTop;
      setCurrentScrollTop(scrollTop);

      if (scrollUpdateWasRequested || isRestoringScrollRef.current) return;
      const topRow = Math.floor(scrollTop / rowHeight);
      const offsetWithinRow = scrollTop - topRow * rowHeight;
      scrollAnchorRef.current = {
        itemIndex: topRow * columnCount,
        offsetWithinRow,
      };
      if (scrollTop !== 0) setScrollPosition(scrollTop);
    },
    [rowHeight, columnCount, setScrollPosition],
  );

  // ─── Drag-select: compute which indices are within a rect ─────────────────
  /**
   * Given a selection rectangle in grid-content coordinates (i.e. scrollTop already
   * factored in), return all item indices that intersect it.
   *
   * rect: { left, top, right, bottom } — in grid-content space
   */
  const getIndicesInRect = useCallback(
    (rect) => {
      if (!totalCount) return [];
      const { left, top, right, bottom } = rect;

      // Which columns are touched?
      const colStart = Math.max(0, Math.floor(left / cellStride));
      const colEnd = Math.min(
        columnCount - 1,
        Math.floor((right - 1) / cellStride),
      );

      // Which rows are touched?
      const rowStart = Math.max(0, Math.floor(top / rowStride));
      const rowEnd = Math.min(
        Math.ceil(totalCount / columnCount) - 1,
        Math.floor((bottom - 1) / rowStride),
      );

      const indices = [];
      for (let r = rowStart; r <= rowEnd; r++) {
        for (let c = colStart; c <= colEnd; c++) {
          const idx = r * columnCount + c;
          if (idx < totalCount) indices.push(idx);
        }
      }
      return indices;
    },
    [totalCount, columnCount, cellStride, rowStride],
  );

  // ─── Drag-select: apply rect to selection ────────────────────────────────
  const applyDragRect = useCallback(
    (viewportRect) => {
      if (!nodeRef.current) return;

      const gridEl = nodeRef.current.querySelector(".explorer-grid");
      const gridBounds = (gridEl ?? nodeRef.current).getBoundingClientRect();

      const gridOriginX = gridBounds.left;
      const gridOriginY = gridBounds.top;

      // Convert the two viewport anchor points to container-relative coords.
      // x1/y1 is where the drag started, x2/y2 is the current mouse position.
      const relStartX = viewportRect.x1 - gridOriginX;
      const relStartY = viewportRect.y1 - gridOriginY;
      const relCurX = viewportRect.x2 - gridOriginX;
      const relCurY = viewportRect.y2 - gridOriginY;

      // Convert both points to content-space using their respective scrollTops.
      // The start point is anchored to the scrollTop captured at mousedown; the
      // current point uses live scrollTop. Scrolling therefore expands/contracts
      // the content rect naturally without flickering previously-covered rows.
      const startContentY = relStartY + dragStartScrollTop.current;
      const curContentY = relCurY + dragScrollTopRef.current;

      const contentRect = {
        left: Math.min(relStartX, relCurX),
        top: Math.min(startContentY, curContentY),
        right: Math.max(relStartX, relCurX),
        bottom: Math.max(startContentY, curContentY),
      };

      // Update the visual overlay in content-space coords
      setDragContentRect({
        left: contentRect.left,
        top: contentRect.top,
        width: contentRect.right - contentRect.left,
        height: contentRect.bottom - contentRect.top,
      });

      const indices = getIndicesInRect(contentRect);

      // XOR semantics:
      //   Items in rect that were NOT pre-selected  → select them
      //   Items in rect that WERE pre-selected      → deselect them
      //   Items outside rect                        → restore pre-existing state
      const setSelection =
        dragSelectionModeRef.current === "remove"
          ? setRemoveModeSelected
          : setAddModeSelected;
      setSelection(() => {
        const next = new Set(dragPreExisting.current);
        indices.forEach((idx) => {
          const item = itemsRef.current[idx];
          if (!item) return;
          if (dragPreExisting.current.has(item.id)) {
            next.delete(item.id);
          } else {
            next.add(item.id);
          }
        });
        return next;
      });
    },
    [getIndicesInRect],
  );

  // ─── Drag-select mouse handlers ───────────────────────────────────────────
  const getDragSelectionMode = useCallback(() => {
    if (!explorerMode?.enabled) return null;
    if (explorerMode.type === "tag" || explorerMode.type === "memory") {
      return "add";
    }
    if (explorerMode.type === "remove") return "remove";
    return null;
  }, [explorerMode]);

  const handleGridMouseDown = useCallback(
    (e) => {
      const selectionMode = getDragSelectionMode();
      if (!selectionMode) return;
      if (e.button !== 0) return;

      e.preventDefault();
      dragPendingRef.current = {
        x: e.clientX,
        y: e.clientY,
        scrollTop: dragScrollTopRef.current,
        selection: new Set(
          selectionMode === "remove" ? removeModeSelected : addModeSelected,
        ),
        selectionMode,
      };
    },
    [getDragSelectionMode, addModeSelected, removeModeSelected],
  );

  // Global mousemove / mouseup during drag (attached to window)
  useEffect(() => {
    const onMouseMove = (e) => {
      // Confirm pending drag once mouse moves enough
      if (dragPendingRef.current && !isDraggingRef.current) {
        const dx = e.clientX - dragPendingRef.current.x;
        const dy = e.clientY - dragPendingRef.current.y;
        if (Math.sqrt(dx * dx + dy * dy) > DRAG_THRESHOLD) {
          // Commit the drag
          isDraggingRef.current = true;
          dragStartRef.current = {
            x: dragPendingRef.current.x,
            y: dragPendingRef.current.y,
          };
          dragStartScrollTop.current = dragPendingRef.current.scrollTop;
          dragPreExisting.current = dragPendingRef.current.selection;
          dragSelectionModeRef.current = dragPendingRef.current.selectionMode;
          dragPendingRef.current = null;
        }
      }

      if (!isDraggingRef.current || !dragStartRef.current) return;

      const rect = {
        x1: dragStartRef.current.x,
        y1: dragStartRef.current.y,
        x2: e.clientX,
        y2: e.clientY,
      };
      dragRectRef.current = rect;
      applyDragRect(rect);
    };

    const onMouseUp = () => {
      dragPendingRef.current = null;
      if (!isDraggingRef.current) return;
      dragJustFinishedRef.current = true;
      isDraggingRef.current = false;
      dragStartRef.current = null;
      dragRectRef.current = null;
      dragSelectionModeRef.current = null;
      setDragContentRect(null);
      // Clear the flag after the click event that may follow this mouseup has fired.
      // If mouseup landed on empty space, no click fires and the flag would persist
      // forever — eating the very next cell click. setTimeout(0) ensures it resets
      // regardless of whether a click event follows.
      setTimeout(() => {
        dragJustFinishedRef.current = false;
      }, 0);
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [applyDragRect]);

  // Re-apply rect when scroll changes while dragging (handles scroll-during-drag)
  useEffect(() => {
    // This effect watches dragScrollTopRef changes via handleScroll.
    // We hook into the Grid's onScroll indirectly — applyDragRect uses dragScrollTopRef
    // directly, so calling it on each scroll event covers us.
    // The actual wiring is: handleScroll updates dragScrollTopRef, then we need to
    // re-apply. We do this by registering a scroll listener on the grid outer element.
    const gridOuter = nodeRef.current?.querySelector(".explorer-grid");
    if (!gridOuter) return;

    const onScroll = () => {
      if (isDraggingRef.current && dragRectRef.current) {
        applyDragRect(dragRectRef.current);
      }
    };

    gridOuter.addEventListener("scroll", onScroll, { passive: true });
    return () => gridOuter.removeEventListener("scroll", onScroll);
  }, [applyDragRect, totalCount]); // re-bind when grid mounts or totalCount changes

  useEffect(() => {
    const EDGE_SIZE = 60; // px from edge that triggers scroll
    const MAX_SPEED = 12; // px per frame at the very edge
    let rafId = null;

    const tick = () => {
      if (isDraggingRef.current) {
        const gridOuter = nodeRef.current?.querySelector(
          "#explorer-grid-outer",
        );
        if (gridOuter) {
          const bounds = gridOuter.getBoundingClientRect();
          const mouseY = lastMouseY.current;
          const distFromTop = mouseY - bounds.top;
          const distFromBottom = bounds.bottom - mouseY;
          let speed = 0;
          if (distFromTop < EDGE_SIZE) {
            speed = -MAX_SPEED * (1 - Math.max(0, distFromTop) / EDGE_SIZE);
          } else if (distFromBottom < EDGE_SIZE) {
            speed = MAX_SPEED * (1 - Math.max(0, distFromBottom) / EDGE_SIZE);
          }
          if (speed !== 0) {
            const gridEl = nodeRef.current?.querySelector(".explorer-grid");
            const maxScrollTop = Math.max(
              0,
              (gridEl?.scrollHeight || 0) - (gridEl?.clientHeight || 0),
            );
            const newScrollTop = Math.min(
              maxScrollTop,
              Math.max(0, dragScrollTopRef.current + speed),
            );

            // scrollToCell can leave the grid at a different offset than the
            // requested value. That desynchronises the selection rectangle from
            // the grid; scroll to the exact, clamped pixel offset instead.
            gridRef.current?.scrollToPosition({ scrollTop: newScrollTop });
            dragScrollTopRef.current = newScrollTop;
            if (dragRectRef.current) applyDragRect(dragRectRef.current);
          }
        }
      }
      rafId = requestAnimationFrame(tick); // always keep the loop alive
    };

    const onMouseMove = (e) => {
      lastMouseY.current = e.clientY;
    };

    window.addEventListener("mousemove", onMouseMove);
    rafId = requestAnimationFrame(tick);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      cancelAnimationFrame(rafId);
    };
  }, [applyDragRect]);

  // ─── Reveal item (from context menu) ────────────────────────────────────
  const revealFromContextMenu = useCallback(
    (item) => {
      resetFilters();
      setItemToReveal(item);
    },
    [resetFilters],
  );

  // ─── Container ref / resize ───────────────────────────────────────────────
  const containerRef = useCallback((node) => {
    nodeRef.current = node;
    if (node) setContainerWidth(node.offsetWidth - 10);
  }, []);

  // ─── Effects ──────────────────────────────────────────────────────────────

  // Settings init
  useEffect(() => {
    window.electron.ipcRenderer
      .invoke("get-indexed-files-count")
      .then((count) => {
        setTotalCount(Number(count || 0));
      });
    if (currentSettings) setNoGutters(currentSettings.noGutters);
  }, [currentSettings]);

  // Container resize
  useEffect(() => {
    const updateWidth = () => {
      if (nodeRef.current) setContainerWidth(nodeRef.current.offsetWidth - 10);
    };
    updateWidth();
    window.addEventListener("resize", updateWidth);
    return () => window.removeEventListener("resize", updateWidth);
  }, []);

  // Ctrl+scroll zoom
  useEffect(() => {
    const handleWheel = (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();

      const next = Math.min(
        3,
        Math.max(0.1, visualScaleRef.current + (e.deltaY < 0 ? 0.1 : -0.1)),
      );
      visualScaleRef.current = next;

      // Instant visual feedback via CSS transform — zero re-renders
      const gridOuter = nodeRef.current?.querySelector("#explorer-grid-outer");
      if (gridOuter) {
        gridOuter.style.setProperty("--thumb-scale", next / scale);
      }

      // Debounce: commit real scale only after the user pauses
      clearTimeout(scaleDebounceTimer.current);
      scaleDebounceTimer.current = setTimeout(() => {
        const committed = Number(visualScaleRef.current.toFixed(2));
        onScale(committed);
        setScale(committed);
        // Remove the override — real layout is now correct
        if (gridOuter) gridOuter.style.removeProperty("--thumb-scale");
      }, 200);
    };

    window.addEventListener("wheel", handleWheel, { passive: false });
    return () => window.removeEventListener("wheel", handleWheel);
  }, [onScale, scale]);

  // Filter change: reset + fetch
useEffect(() => {
  // Invalidate all in-flight requests from the previous filter
  const generation = ++fetchGeneration.current;

  itemsRef.current = {};
  idToIndex.current = new Map();
  loadingPages.current.clear();
  setTotalCount(null);

  fetchTotalCount(generation);
  const t = setTimeout(() => fetchPageForIndex(0, true, generation), 0);
  return () => clearTimeout(t);
}, [filters, fetchPageForIndex, fetchTotalCount]);

  // A selection belongs to the current result set. Keeping it after a filter
  // change could remove records that are no longer represented by totalCount.
  useEffect(() => {
    setRemoveModeSelected(new Set());
    setSelectedItem(null);
    setSelectedItemIds(new Set());
  }, [filters]);

  // Reset scroll on filter change
  useEffect(() => {
    setScrollPosition(0);
  }, [filters, setScrollPosition]);

  useEffect(() => {
    if (scrollPosition === 0 && gridRef.current) {
      gridRef.current.scrollToPosition({ scrollTop: 0 });
    }
  }, [scrollPosition]);

  useEffect(() => {
    if (!currentSettings?.explorerDateScroll) return;
    setMonthData(null);
    window.electron.ipcRenderer
      .invoke("fetch-timeline-months", {
        filters: filters || {},
        sortOrder: filters?.sortOrder ?? "desc",
        settings: {
          hideScreenshotsAndScreenRecordings:
            !!currentSettings?.hideScreenshotsAndScreenRecordings,
          hiddenFolders: currentSettings?.hiddenFolders || [],
        },
      })
      .then((data) => {
        if (data?.length) setMonthData(data);
      });
  }, [
    filters,
    currentSettings?.explorerDateScroll,
    currentSettings?.hideScreenshotsAndScreenRecordings,
    currentSettings?.hiddenFolders,
  ]);

  useEffect(() => {
    const update = () => {
      const container =
        gridRef.current?._scrollingContainer ||
        gridRef.current?.Grid?._scrollingContainer;

      if (container) {
        setActualScrollHeight(container.scrollHeight);
      }
    };

    update();

    const t = setTimeout(update, 500);
    return () => clearTimeout(t);
  }, [columnCount, rowHeight, totalCount]);

  // Restore scroll on mount
  useEffect(() => {
    const timer = setTimeout(() => {
      if (gridRef.current && scrollPosition) {
        const row = Math.floor(scrollPosition / rowHeight);
        const col = 0;

        gridRef.current.scrollToCell({
          rowIndex: row,
          columnIndex: col,
        });
      }
    }, 100);
    return () => clearTimeout(timer);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-anchor scroll when scale/column count changes
  useEffect(() => {
    if (!gridRef.current || totalCount == null) return;
    isRestoringScrollRef.current = true;

    requestAnimationFrame(() => {
      gridRef.current?.recomputeGridSize();

      const { itemIndex, offsetWithinRow } = scrollAnchorRef.current;

      let targetScrollTop;

      if (scale >= 0.4 && mosaicScrollTopRef.current > 0) {
        targetScrollTop = mosaicScrollTopRef.current;
        mosaicScrollTopRef.current = 0; // consume it
      } else {
        const { itemIndex, offsetWithinRow } = scrollAnchorRef.current;
        const newRow = Math.floor(itemIndex / columnCount);
        targetScrollTop = newRow * rowHeight + offsetWithinRow;
      }

      gridRef.current?.scrollToPosition({ scrollTop: targetScrollTop });

      requestAnimationFrame(() => {
        isRestoringScrollRef.current = false;
      });
    });
  }, [scale, rowHeight, columnCount, totalCount]);

  const handleMosaicScroll = useCallback(
    (mosaicScrollTop) => {
      mosaicScrollTopRef.current = mosaicScrollTop;

      // Compute mosaic layout to reverse-map to item index
      const tileSize = Math.max(14, 42 * (scale / 0.4));
      const mosaicCols = Math.max(
        1,
        Math.floor(Math.min(containerWidth, 400) / tileSize),
      );
      const topRow = Math.floor(mosaicScrollTop / tileSize);

      scrollAnchorRef.current = {
        itemIndex: topRow * mosaicCols,
        offsetWithinRow: mosaicScrollTop - topRow * tileSize,
      };
    },
    [scale, containerWidth],
  );

  useEffect(() => {
    const requestId = ++overviewRequestId.current;

    (async () => {
      const res = await window.electron.ipcRenderer.invoke(
        "fetch-file-overview",
        { filters: filters || {}, settings: currentSettings || {} },
      );

      if (requestId !== overviewRequestId.current) return;

      overviewIndexRef.current = res?.rows || [];
      forceUpdate((x) => x + 1); // IMPORTANT: ref change won't re-render
    })();
  }, [totalCount, filters, currentSettings]);

  // IPC: item removed
  useEffect(() => {
    const handleItemRemoved = ({ ids }) => {
      const idSet = new Set(Array.isArray(ids) ? ids : [ids]);
      let removedVisibleCount = 0;

      idSet.forEach((id) => {
        const index = idToIndex.current.get(id);
        if (index == null) return;
        delete itemsRef.current[index];
        idToIndex.current.delete(id);
        removedVisibleCount += 1;
      });

      setTotalCount((prev) =>
        prev == null ? prev : Math.max(0, prev - removedVisibleCount),
      );
      setRemoveModeSelected((prev) => {
        const next = new Set(prev);
        idSet.forEach((id) => next.delete(id));
        return next;
      });
      setSelectedItemIds((prev) => {
        const next = new Set(prev);
        idSet.forEach((id) => next.delete(id));
        return next;
      });

      // Rebuild idToIndex
      const rebuilt = new Map();
      Object.entries(itemsRef.current).forEach(([idx, item]) => {
        rebuilt.set(item.id, Number(idx));
      });
      idToIndex.current = rebuilt;

      if (idSet.has(selectedItemRef.current?.id)) {
        setSelectedItem(null);
        onSelectRef.current(null, "single");
      }
      itemDeletedRef.current();
    };

    return window.electron.ipcRenderer.on("item-removed", handleItemRemoved);
  }, []);

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = async (e) => {
      if (actionPanelType && !((e.key === "a" || e.key === "A") && e.ctrlKey))
        return;
      const tag = document.activeElement?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;

      const isAddMode =
        explorerMode?.enabled &&
        (explorerMode.type === "tag" || explorerMode.type === "memory");

      // Ctrl+A: select all / deselect all in add mode
      if ((e.key === "a" || e.key === "A") && e.ctrlKey) {
        if (!isAddMode) return;
        e.preventDefault();
        if (addModeSelected.size === totalCount) {
          setAddModeSelected(new Set());
        } else {
          const ids = await fetchAllIds();
          // Merge with the existing selection so Ctrl+A across different
          // filter states is additive rather than destructive.
          setAddModeSelected((prev) => new Set([...prev, ...ids]));
        }
        return;
      }

      if (e.key === "Escape") {
        e.preventDefault();
        setSelectedItem(null);
        setSelectedItemIds(new Set());
        onSelect(null, "single");
        return;
      }
      
      if (!selectedItem) return;
      const idx = idToIndex.current.get(selectedItem.id);
      if (idx == null) return;

      if (e.key === "t" || e.key === "T") {
        tagCurrentlySelected(itemsRef.current[idx]);
        return;
      }

      const deltas = {
        ArrowRight: 1,
        ArrowLeft: -1,
        ArrowDown: columnCount,
        ArrowUp: -columnCount,
      };
      const delta = deltas[e.key];
      if (!delta) return;

      e.preventDefault();
      const nextIndex = idx + delta;
      if (nextIndex < 0 || nextIndex >= totalCount) return;

      const nextItem = itemsRef.current[nextIndex];
      if (nextItem) {
        handleSelect(nextItem, "single");
      }
      gridRef.current?.scrollToCell({
        rowIndex: Math.floor(nextIndex / columnCount),
        columnIndex: nextIndex % columnCount,
      });
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    selectedItem,
    totalCount,
    explorerMode,
    addModeSelected,
    fetchAllIds,
    onSelect,
    columnCount,
    tagCurrentlySelected,
    actionPanelType,
    handleSelect,
  ]);

  // Explorer mode: pre-populate add selection
  useEffect(() => {
    if (!explorerMode?.enabled) {
      setAddModeSelected(new Set());
      setRemoveModeSelected(new Set());
      return;
    }
    if (explorerMode.existing?.length) {
      setAddModeSelected(new Set(explorerMode.existing));
    }
  }, [explorerMode?.enabled, explorerMode?.value]);

  // Reveal item after filter reset
  useEffect(() => {
    if (!itemToReveal) return;
    let cancelled = false;

    const revealItem = async (item) => {
      const itemIndex = await window.electron.ipcRenderer.invoke(
        "get-index-of-item",
        { itemId: item.media_id, settings: currentSettings || {} },
      );
      if (cancelled) return;
      if (itemIndex == null) {
        enqueueSnackbar("This item is hidden by the current Explorer settings.");
        setSelectedItem(null);
        onSelect(null, "single");
        setItemToReveal(null);
        return;
      }

      const pageIndex = Math.floor(itemIndex / PAGE_SIZE);
      const res = await window.electron.ipcRenderer.invoke("fetch-files", {
        offset: pageIndex * PAGE_SIZE,
        limit: PAGE_SIZE,
        filters: { sortBy: "media_id", sortOrder: "desc" },
        settings: currentSettings,
      });
      if (!res?.success || cancelled) return;
      addItems(res.rows, pageIndex * PAGE_SIZE);

      // Wait for grid
      for (let i = 0; i < 20; i++) {
        if (cancelled) return;
        if (gridRef.current) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      if (!gridRef.current || cancelled) return;

      const col = Math.max(
        1,
        Math.floor(containerWidth / (columnWidth + gutterSize)),
      );
      gridRef.current.scrollToCell({
        rowIndex: Math.floor(itemIndex / col),
        columnIndex: itemIndex % col,
      });

      const revealedItem = itemsRef.current[itemIndex];
      if (revealedItem && !cancelled) {
        handleSelect(revealedItem, "single");
        setItemToReveal(null);
      }
    };

    revealItem(itemToReveal);
    return () => {
      cancelled = true;
    };
  }, [
    itemToReveal,
    containerWidth,
    columnWidth,
    gutterSize,
    currentSettings,
    addItems,
    handleSelect,
  ]);

  // ─── Drag selection rectangle overlay ────────────────────────────────────
  // Rendered as a child of the grid outer div (position: absolute in content space).
  const DragSelectOverlay = () => {
    if (!dragContentRect) return null;
    const { left, top, width, height } = dragContentRect;
    if (width < 4 && height < 4) return null;

    // Shift by -scrollTop so the rect visually tracks its content-space position
    const visualTop = top - dragScrollTopRef.current;

    return (
      <div
        style={{
          position: "absolute",
          left,
          top: visualTop,
          width,
          height,
          border: "1px solid rgba(53, 109, 241, 0.37)",
          backgroundColor: "rgba(112, 174, 251, 0.35)",
          borderRadius: 3,
          pointerEvents: "none",
          zIndex: 10,
        }}
      />
    );
  };

  // ─── Empty / loading states ───────────────────────────────────────────────
  const hasActiveFilters = filters
    ? Object.values(filters).some((v) => v !== "" && v != null)
    : false;

  if (totalCount === 0 && !hasActiveFilters) {
    return (
      <div className="explorer-view empty" style={{ padding: 40 }}>
        <h2>No indexed files</h2>
        <br />
        <p>
          You don't have any indexed photos or videos yet.
          <br />
          <br />
          Please add at least one folder with images or videos in{" "}
          <strong>
            Settings{" "}
            <FontAwesomeIcon
              className="explorer-arrow-right"
              icon={faArrowRight}
            />{" "}
            Media
          </strong>{" "}
          to see them here.
        </p>
        <br />
        <button
          className="welcome-popup-select-folders-btn"
          onClick={openSettings}
        >
          Open Settings
        </button>
      </div>
    );
  }

  if (totalCount === 0 && hasActiveFilters) {
    return (
      <div className="explorer-view empty" style={{ padding: 40 }}>
        <h2>No results</h2>
        <br />
        <p>Try adjusting your filters or search terms.</p>
      </div>
    );
  }

  if (totalCount === null) {
    return <div style={{ alignSelf: "center" }} className="loader" />;
  }

  // ─── Render ───────────────────────────────────────────────────────────────
  const isAddMode =
    explorerMode?.enabled &&
    (explorerMode.type === "tag" || explorerMode.type === "memory");
  const isRemoveMode = explorerMode?.enabled && explorerMode.type === "remove";
  const canShowDateScroll =
    scale >= 0.4 &&
    (!filters ||
      !filters.sortBy ||
      (filters &&
        filters.sortBy &&
        (filters.sortBy === "media_id" ||
          filters.sortBy === "create_date_local" ||
          filters.sortBy === "created"))) &&
    (!filters || filters.searchBy !== "smart") &&
    (!filters || !filters._smartSearch);

  return (
    <div
      className="explorer-view"
      ref={containerRef}
      style={{ height: "100%", width: "100%" }}
      onMouseDown={handleGridMouseDown}
    >
      <div
        className="explorer-main"
        style={{ height: "100%", padding: "12px 0px" }}
      >
        <InfiniteLoader
          isRowLoaded={({ index }) => isItemLoaded(index)}
          loadMoreRows={({ startIndex, stopIndex }) =>
            loadMoreItems(startIndex, stopIndex)
          }
          rowCount={totalCount}
        >
          {({ onRowsRendered, registerChild }) => (
            <div
              id="explorer-grid-outer"
              ref={gridOuterRef}
              style={{ position: "relative" }}
            >
              {scale < 0.4 ? (
                <OverviewMosaic
                  scale={scale}
                  fetchItems={(startIndex, endIndex) =>
                    overviewIndexRef.current.slice(startIndex, endIndex)
                  }
                  totalCount={totalCount}
                  containerWidth={containerWidth}
                  containerHeight={gridHeight}
                  scrollTop={currentScrollTop}
                  onSelectItem={(item) => handleSelect(item, "single")}
                  onMosaicScroll={handleMosaicScroll}
                />
              ) : (
                <Grid
                  ref={(grid) => {
                    registerChild(grid);
                    gridRef.current = grid;
                  }}
                  columnCount={columnCount}
                  columnWidth={columnWidth + gutterSize}
                  height={gridHeight}
                  rowCount={rowCount}
                  rowHeight={rowHeight}
                  width={containerWidth}
                  onScroll={handleScroll}
                  className="explorer-grid"
                  cellRenderer={({ columnIndex, rowIndex, style, key }) => (
                    <Cell
                      key={key}
                      columnIndex={columnIndex}
                      rowIndex={rowIndex}
                      style={style}
                      item={
                        itemsRef.current[rowIndex * columnCount + columnIndex]
                      }
                      totalCount={totalCount}
                      noGutters={noGutters}
                      scale={scale}
                      rowHeight={rowHeight}
                      explorerMode={explorerMode}
                      addModeSelected={addModeSelected}
                      removeModeSelected={removeModeSelected}
                      selectedItemIds={selectedItemIds}
                      currentSettings={currentSettings}
                      folderStatuses={folderStatuses}
                      dragJustFinishedRef={dragJustFinishedRef}
                      columnCount={columnCount}
                      handleAddModeClick={handleAddModeClick}
                      handleRemoveModeClick={handleRemoveModeClick}
                      handleClick={handleClick}
                      handleMouseEnter={handleMouseEnter}
                      handleMouseLeave={handleMouseLeave}
                      handleSelect={handleSelect}
                      handleContextMenu={handleContextMenu}
                      getItemName={getItemName}
                    />
                  )}
                  onSectionRendered={({
                    rowStartIndex,
                    rowStopIndex,
                    columnStartIndex,
                    columnStopIndex,
                  }) => {
                    const startIndex =
                      rowStartIndex * columnCount + columnStartIndex;
                    const stopIndex =
                      rowStopIndex * columnCount + columnStopIndex;

                    onRowsRendered({
                      startIndex,
                      stopIndex,
                    });
                  }}
                />
              )}
              <DragSelectOverlay />

              {currentSettings?.explorerDateScroll && canShowDateScroll && (
                <TimelineOverlay
                  itemsRef={itemsRef}
                  totalCount={totalCount}
                  columnCount={columnCount}
                  rowHeight={rowHeight}
                  gridRef={gridRef}
                  scrollTop={currentScrollTop}
                  totalHeight={actualScrollHeight}
                  monthData={monthData}
                  gridHeight={gridHeight}
                  sortOrder={filters?.sortOrder ?? "desc"}
                />
              )}
            </div>
          )}
        </InfiniteLoader>
      </div>

      {/* ── Remove Mode Banner ── */}
      {isRemoveMode && (
        <FloatingBanner>
          <span>Remove Mode Enabled</span>
          <BannerButton
            onClick={async () => {
              await handleRemoveItem(Array.from(removeModeSelected));
              setExplorerMode({ enabled: false, value: null, type: "" });
              setRemoveModeSelected(new Set());
            }}
          >
            Remove Selected ({removeModeSelected.size})
          </BannerButton>
          <BannerButton
            onClick={() => {
              setExplorerMode({ enabled: false, value: null, type: "" });
              setRemoveModeSelected(new Set());
            }}
          >
            <FontAwesomeIcon icon={faXmark} />
          </BannerButton>
        </FloatingBanner>
      )}

      {/* ── Add Mode Banner ── */}
      {isAddMode && (
        <FloatingBanner>
          <BannerButton
            onClick={() => {
              setExplorerMode({ enabled: false, value: null, type: "" });
              const invoke =
                explorerMode.type === "tag"
                  ? "tag:set-items"
                  : "memory:set-items";
              const key = explorerMode.type === "tag" ? "tagId" : "memoryId";
              window.electron.ipcRenderer.invoke(invoke, {
                [key]: explorerMode.value,
                mediaIds: Array.from(addModeSelected),
              });
            }}
          >
            Save {explorerMode.type} ({addModeSelected.size} items)
          </BannerButton>
          <BannerButton
            onClick={() =>
              setExplorerMode({ enabled: false, value: null, type: "" })
            }
          >
            <FontAwesomeIcon icon={faXmark} />
          </BannerButton>
        </FloatingBanner>
      )}

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          item={contextMenu.item}
          onClose={() => setContextMenu(null)}
          revealFromContextMenu={revealFromContextMenu}
          onRemoveItem={handleRemoveItem}
          onFindSimilar={onFindSimilar}
          activePersonId={activePersonId}
          onPersonAction={openPersonFacePicker}
          selectedItemIds={contextMenu.itemIds}
        />
      )}

      {facePicker && (
        <FacePickerPopup
          selection={facePicker}
          busy={faceActionBusy}
          onCancel={() => setFacePicker(null)}
          onSelect={selectFaceForPersonAction}
        />
      )}

      {personPicker && (
        <PersonPickerPopup
          selection={personPicker}
          busy={faceActionBusy}
          onCancel={() => setPersonPicker(null)}
          onSelect={(person) => personPicker.targetFaces
            ? runFaceActions(
              "add-to-person",
              personPicker.targetFaces,
              person.id,
              personPicker.removedItemIds,
            )
            : runFaceAction(
              "add-to-person",
              personPicker.face,
              person.id,
              personPicker.removedItemId,
            )}
        />
      )}

      {explorerLoading && (
        <div className="explorer-loading-overlay">
          <div className="loader"></div>
        </div>
      )}

      <SnackbarProvider />
    </div>
  );
};

// ─── Small presentational helpers ────────────────────────────────────────────
const bannerStyle = {
  position: "fixed",
  bottom: 40,
  right: 20,
  padding: "10px 15px",
  backgroundColor: "#15131a",
  color: "white",
  border: "1px solid #484050",
  borderRadius: 6,
  zIndex: 1000,
  display: "flex",
  alignItems: "center",
  gap: 10,
  boxShadow: "0 2px 8px rgba(0,0,0,0.3)",
};

const btnStyle = {
  padding: "6px 12px",
  backgroundColor: "#484050",
  border: "none",
  color: "white",
  borderRadius: 4,
  cursor: "pointer",
};

const FloatingBanner = ({ children }) => (
  <div style={bannerStyle}>{children}</div>
);
const BannerButton = ({ children, onClick }) => (
  <button style={btnStyle} onClick={onClick}>
    {children}
  </button>
);

export default ExplorerView;
