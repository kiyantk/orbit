import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Grid } from "react-virtualized";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faArrowsRotate, faEyeSlash, faMagnifyingGlass, faUsers } from "@fortawesome/free-solid-svg-icons";
import ConfirmPopup from "./ConfirmPopup";
import PeopleContextMenu from "./PeopleContextMenu";
import Popup from "./Popup";
import "react-virtualized/styles.css";

const CARD_MIN_WIDTH = 156;
const CARD_HEIGHT = 210;
const GRID_GAP = 16;

function normaliseText(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase();
}

function columnCountFor(width) {
  return Math.max(1, Math.floor((width + GRID_GAP) / (CARD_MIN_WIDTH + GRID_GAP)));
}

function cellWidthFor(width, columns) {
  return Math.floor((width - GRID_GAP * (columns - 1)) / columns);
}

function FaceAvatar({ person, label }) {
  const [faceAvatar, setFaceAvatar] = useState(null);
  const boxWidth = Math.max(0.01, Number(person.boxWidth) || 0.01);
  const boxHeight = Math.max(0.01, Number(person.boxHeight) || 0.01);
  const centerX = Math.max(0, Math.min(1, (Number(person.boxLeft) || 0) + boxWidth / 2));
  const centerY = Math.max(0, Math.min(1, (Number(person.boxTop) || 0) + boxHeight / 2));
  const aspect = Math.max(0.1, Number(person.imageWidth) / Math.max(1, Number(person.imageHeight)) || 1);
  // Make the detected face fill most of the round crop, but leave enough room
  // around it for a pleasant People-grid thumbnail.
  const cropScale = 1 / Math.min(1, Math.max(boxWidth, boxHeight) * 1.55);
  const renderedHeight = 144 * cropScale;
  const renderedWidth = renderedHeight * aspect;
  const thumbnailStyle = {
    width: renderedWidth,
    height: renderedHeight,
    left: 72 - centerX * renderedWidth,
    top: 72 - centerY * renderedHeight,
  };

  useEffect(() => {
    let cancelled = false;
    setFaceAvatar(null);
    if (!person.coverFaceId) return undefined;
    window.electron.ipcRenderer
      .invoke("people:ensure-face-avatar", { faceId: person.coverFaceId })
      .then((result) => {
        if (!cancelled && result?.success && result.url) setFaceAvatar({ faceId: person.coverFaceId, url: result.url });
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [person.coverFaceId]);

  const faceAvatarUrl = faceAvatar?.faceId === person.coverFaceId ? faceAvatar.url : null;
  const sourceUrl = faceAvatarUrl || (person.coverFileId ? `orbit://thumbs/${person.coverFileId}_thumb.jpg` : null);
  const imageStyle = faceAvatarUrl
    ? { width: 144, height: 144, left: 0, top: 0, objectFit: "cover" }
    : thumbnailStyle;

  return (
    <div className="person-avatar" aria-hidden="true">
      {sourceUrl ? <img src={sourceUrl} alt="" draggable={false} style={imageStyle} onError={() => setFaceAvatar(null)} /> : <FontAwesomeIcon icon={faUsers} />}
      <span className="person-avatar-ring" />
      <span className="sr-only">{label}</span>
    </div>
  );
}

function FaceGridAvatar({ face, label, onSeparate, separating }) {
  const [faceAvatarUrl, setFaceAvatarUrl] = useState(null);
  const [thumbnailFailed, setThumbnailFailed] = useState(false);
  const boxWidth = Math.max(0.01, Number(face.boxWidth) || 0.01);
  const boxHeight = Math.max(0.01, Number(face.boxHeight) || 0.01);
  const centerX = Math.max(0, Math.min(1, (Number(face.boxLeft) || 0) + boxWidth / 2));
  const centerY = Math.max(0, Math.min(1, (Number(face.boxTop) || 0) + boxHeight / 2));
  const aspect = Math.max(0.1, Number(face.imageWidth) / Math.max(1, Number(face.imageHeight)) || 1);
  const cropScale = 1 / Math.min(1, Math.max(boxWidth, boxHeight) * 1.55);
  const thumbnailStyle = {
    width: `${100 * cropScale * aspect}%`,
    height: `${100 * cropScale}%`,
    left: `${50 - centerX * 100 * cropScale * aspect}%`,
    top: `${50 - centerY * 100 * cropScale}%`,
  };

  useEffect(() => {
    let cancelled = false;
    setFaceAvatarUrl(null);
    setThumbnailFailed(false);
    window.electron.ipcRenderer
      .invoke("people:ensure-face-avatar", { faceId: face.faceId })
      .then((result) => {
        if (!cancelled && result?.success && result.url) setFaceAvatarUrl(result.url);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [face.faceId]);

  const sourceUrl = faceAvatarUrl || (!thumbnailFailed && face.fileId ? `orbit://thumbs/${face.fileId}_thumb.jpg` : null);

  return (
    <button type="button" className="person-face-grid-avatar" onClick={onSeparate} disabled={separating} aria-label={label}>
      {sourceUrl
        ? <img
          className={faceAvatarUrl ? "person-face-grid-avatar-crop" : "person-face-grid-thumbnail"}
          src={sourceUrl}
          alt=""
          draggable={false}
          style={faceAvatarUrl ? undefined : thumbnailStyle}
          onError={() => {
            if (faceAvatarUrl) setFaceAvatarUrl(null);
            else setThumbnailFailed(true);
          }}
        />
        : <FontAwesomeIcon icon={faUsers} aria-hidden="true" />}
      <span className="person-face-grid-action">{separating ? "Separating..." : "Separate face"}</span>
    </button>
  );
}

function normalizeMinimumPhotos(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(1000, Math.max(1, Math.floor(parsed))) : 1;
}

const PeopleView = ({ currentSettings, onViewPerson, onCountChange }) => {
  const [people, setPeople] = useState([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [resource, setResource] = useState(null);
  const [regrouping, setRegrouping] = useState(false);
  const [regroupError, setRegroupError] = useState(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [suggestion, setSuggestion] = useState(null);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [decisionSaving, setDecisionSaving] = useState(false);
  const [reviewError, setReviewError] = useState(null);
  const [reviewImage, setReviewImage] = useState(null);
  const [reviewImageZoom, setReviewImageZoom] = useState(1);
  const [reviewImageOffset, setReviewImageOffset] = useState({ x: 0, y: 0 });
  const [bulkMode, setBulkMode] = useState(null);
  const [bulkTargetId, setBulkTargetId] = useState(null);
  const [bulkPersonIds, setBulkPersonIds] = useState([]);
  const [bulkConfirmation, setBulkConfirmation] = useState(null);
  const [bulkSaving, setBulkSaving] = useState(false);
  const [bulkError, setBulkError] = useState(null);
  const [contextMenu, setContextMenu] = useState(null);
  const [renamePerson, setRenamePerson] = useState(null);
  const [renameValue, setRenameValue] = useState("");
  const [splitPerson, setSplitPerson] = useState(null);
  const [personActionSaving, setPersonActionSaving] = useState(false);
  const [faceGridPerson, setFaceGridPerson] = useState(null);
  const [faceGridFaces, setFaceGridFaces] = useState([]);
  const [faceGridLoading, setFaceGridLoading] = useState(false);
  const [faceGridError, setFaceGridError] = useState(null);
  const [faceGridActionId, setFaceGridActionId] = useState(null);
  const containerRef = useRef(null);
  const faceGridRequestRef = useRef(0);
  const reviewImageDragRef = useRef(null);
  const reviewImageElementRef = useRef(null);
  const reviewFaceMaskId = useRef(`people-review-face-mask-${Math.random().toString(36).slice(2)}`).current;
  const [reviewImageLayout, setReviewImageLayout] = useState(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  const load = useCallback(async () => {
    try {
      const [peopleResult, status] = await Promise.all([
        window.electron.ipcRenderer.invoke("people:list"),
        window.electron.ipcRenderer.invoke("facial-recognition:get-status"),
      ]);
      if (peopleResult?.success) setPeople(peopleResult.data ?? []);
      if (status?.resource) setResource(status.resource);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, [load]);

  useEffect(() => {
    const refresh = () => load();
    const progress = window.electron.ipcRenderer.on("facial-recognition-progress", refresh);
    const resources = window.electron.ipcRenderer.on("resource-status", (next) => {
      if (next?.id === "facial-recognition") {
        setResource(next);
        if (next.state === "ready") load();
      }
    });
    return () => {
      progress?.();
      resources?.();
    };
  }, [load]);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return undefined;
    const observer = new ResizeObserver(([entry]) => setSize(entry.contentRect));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const peopleWithLabels = useMemo(() => people.map((person, index) => ({
    ...person,
    displayName: person.name || `Person ${index + 1}`,
  })), [people]);

  const minimumPhotos = normalizeMinimumPhotos(currentSettings?.peopleMinPhotos);
  const visiblePeople = useMemo(() => peopleWithLabels.filter((person) => (
    (currentSettings?.showHiddenPeople || !person.hidden) && Number(person.itemCount) >= minimumPhotos
  )), [currentSettings?.showHiddenPeople, minimumPhotos, peopleWithLabels]);

  const filteredPeople = useMemo(() => {
    const search = normaliseText(query.trim());
    if (!search) return visiblePeople;
    return visiblePeople.filter((person) => normaliseText(person.displayName).includes(search));
  }, [query, visiblePeople]);

  const suggestedPeople = useMemo(() => {
    if (!suggestion) return null;
    const byId = new Map(peopleWithLabels.map((person) => [person.id, person]));
    const first = byId.get(suggestion.leftPersonId);
    const second = byId.get(suggestion.rightPersonId);
    return first && second ? { first, second } : null;
  }, [peopleWithLabels, suggestion]);

  useEffect(() => {
    onCountChange?.({ total: visiblePeople.length, filtered: filteredPeople.length });
  }, [visiblePeople.length, filteredPeople.length, onCountChange]);

  const bulkTarget = useMemo(() => peopleWithLabels.find((person) => person.id === bulkTargetId) ?? null, [bulkTargetId, peopleWithLabels]);

  const cancelBulkMode = useCallback(() => {
    setBulkMode(null);
    setBulkTargetId(null);
    setBulkPersonIds([]);
    setBulkConfirmation(null);
    setBulkError(null);
  }, []);

  const startBulkMerge = useCallback(() => {
    setBulkMode("merge-target");
    setBulkTargetId(null);
    setBulkPersonIds([]);
    setBulkError(null);
  }, []);

  const startBulkHide = useCallback(() => {
    setBulkMode("hide");
    setBulkTargetId(null);
    setBulkPersonIds([]);
    setBulkError(null);
  }, []);

  const openFaceGrid = useCallback(async (person) => {
    const requestId = ++faceGridRequestRef.current;
    setFaceGridPerson(person);
    setFaceGridFaces([]);
    setFaceGridError(null);
    setFaceGridLoading(true);
    try {
      const result = await window.electron.ipcRenderer.invoke("people:list-person-faces", { personId: person.id });
      if (!result?.success) throw new Error(result?.error || "Unable to load this person's faces.");
      if (requestId === faceGridRequestRef.current) setFaceGridFaces(result.data ?? []);
    } catch (error) {
      if (requestId === faceGridRequestRef.current) setFaceGridError(error.message || "Unable to load this person's faces.");
    } finally {
      if (requestId === faceGridRequestRef.current) setFaceGridLoading(false);
    }
  }, []);

  const closeFaceGrid = useCallback(() => {
    faceGridRequestRef.current += 1;
    setFaceGridPerson(null);
    setFaceGridFaces([]);
    setFaceGridError(null);
    setFaceGridActionId(null);
  }, []);

  const handlePersonClick = useCallback((event, person) => {
    if (event.ctrlKey) {
      openFaceGrid(person);
      return;
    }
    if (!bulkMode) {
      if (person.fileIds?.length) onViewPerson(person);
      return;
    }
    if (bulkMode === "merge-target") {
      setBulkTargetId(person.id);
      setBulkMode("merge-select");
      return;
    }
    if (bulkMode === "merge-select" && person.id === bulkTargetId) return;
    setBulkPersonIds((current) => (
      current.includes(person.id)
        ? current.filter((personId) => personId !== person.id)
        : [...current, person.id]
    ));
  }, [bulkMode, bulkTargetId, onViewPerson, openFaceGrid]);

  const openBulkConfirmation = useCallback(() => {
    if (!bulkPersonIds.length) return;
    if (bulkMode === "merge-select" && !bulkTargetId) return;
    setBulkError(null);
    setBulkConfirmation({
      kind: bulkMode === "hide" ? "hide" : "merge",
      personIds: bulkPersonIds,
      targetPersonId: bulkTargetId,
    });
  }, [bulkMode, bulkPersonIds, bulkTargetId]);

  const saveBulkDecision = useCallback(async () => {
    if (!bulkConfirmation) return;
    setBulkSaving(true);
    setBulkError(null);
    try {
      const result = await window.electron.ipcRenderer.invoke("people:bulk-decision", bulkConfirmation);
      if (!result?.success) throw new Error(result?.error || "Unable to save the people changes.");
      await load();
      cancelBulkMode();
    } catch (error) {
      setBulkError(error.message || "Unable to save the people changes.");
    } finally {
      setBulkSaving(false);
    }
  }, [bulkConfirmation, cancelBulkMode, load]);

  const managePerson = useCallback(async (action, person, value = null) => {
    setPersonActionSaving(true);
    setRegroupError(null);
    try {
      const result = await window.electron.ipcRenderer.invoke("people:action", {
        action,
        personId: person.id,
        value,
      });
      if (!result?.success) throw new Error(result?.error || "Unable to update this person.");
      await load();
      return true;
    } catch (error) {
      setRegroupError(error.message || "Unable to update this person.");
      return false;
    } finally {
      setPersonActionSaving(false);
    }
  }, [load]);

  const openRenamePerson = useCallback((person) => {
    setContextMenu(null);
    setRenamePerson(person);
    setRenameValue(person.name || "");
  }, []);

  const saveRenamePerson = useCallback(async () => {
    if (!renamePerson || !renameValue.trim()) return;
    if (await managePerson("rename", renamePerson, renameValue)) setRenamePerson(null);
  }, [managePerson, renamePerson, renameValue]);

  const openSplitPerson = useCallback((person) => {
    setContextMenu(null);
    setSplitPerson(person);
  }, []);

  const confirmSplitPerson = useCallback(async () => {
    if (!splitPerson || personActionSaving) return;
    if (await managePerson("split", splitPerson)) setSplitPerson(null);
  }, [managePerson, personActionSaving, splitPerson]);

  const togglePersonHidden = useCallback(async (person) => {
    setContextMenu(null);
    await managePerson(person.hidden ? "unhide" : "hide", person);
  }, [managePerson]);

  const hideFaceGridPerson = useCallback(async () => {
    if (!faceGridPerson || personActionSaving || faceGridActionId) return;
    setPersonActionSaving(true);
    setFaceGridError(null);
    try {
      const result = await window.electron.ipcRenderer.invoke("people:action", {
        action: "hide",
        personId: faceGridPerson.id,
      });
      if (!result?.success) throw new Error(result?.error || "Unable to hide this person.");
      await load();
      closeFaceGrid();
    } catch (error) {
      setFaceGridError(error.message || "Unable to hide this person.");
    } finally {
      setPersonActionSaving(false);
    }
  }, [closeFaceGrid, faceGridActionId, faceGridPerson, load, personActionSaving]);

  const separateFaceFromGrid = useCallback(async (face) => {
    if (!faceGridPerson || faceGridActionId) return;
    setFaceGridActionId(face.faceId);
    setFaceGridError(null);
    try {
      const result = await window.electron.ipcRenderer.invoke("people:face-action", {
        action: "separate",
        faceId: face.faceId,
      });
      if (!result?.success) throw new Error(result?.error || "Unable to separate this face.");
      setFaceGridFaces((current) => current.filter((currentFace) => currentFace.faceId !== face.faceId));
      await load();
      if (faceGridFaces.length === 1) closeFaceGrid();
    } catch (error) {
      setFaceGridError(error.message || "Unable to separate this face.");
    } finally {
      setFaceGridActionId(null);
    }
  }, [closeFaceGrid, faceGridActionId, faceGridFaces.length, faceGridPerson, load]);

  useEffect(() => {
    if (!faceGridPerson) return undefined;
    const closeOnEscape = (event) => {
      if (event.key === "Escape") closeFaceGrid();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [closeFaceGrid, faceGridPerson]);

  const unavailable = resource?.state === "download-required" || resource?.state === "download-failed";
  const columns = columnCountFor(size.width || 0);
  const cellWidth = cellWidthFor(size.width || 0, columns);
  const rows = Math.ceil(filteredPeople.length / columns);
  const renderCell = useCallback(({ columnIndex, rowIndex, key, style }) => {
    const index = rowIndex * columns + columnIndex;
    const person = filteredPeople[index];
    if (!person) return null;
    const label = person.displayName;
    return (
      <button
        key={key}
        type="button"
        className={`person-card${person.hidden ? " person-card--hidden" : ""}${bulkMode === "merge-select" && person.id === bulkTargetId ? " person-card--bulk-target" : ""}${bulkPersonIds.includes(person.id) ? " person-card--bulk-selected" : ""}`}
        style={{
          ...style,
          left: columnIndex * (cellWidth + GRID_GAP),
          top: rowIndex * (CARD_HEIGHT + GRID_GAP),
          width: cellWidth,
          height: CARD_HEIGHT,
        }}
        onClick={(event) => handlePersonClick(event, person)}
        onContextMenu={(event) => {
          event.preventDefault();
          if (!bulkMode) setContextMenu({ x: event.clientX, y: event.clientY, person });
        }}
      >
        <FaceAvatar person={person} label={label} />
        <span className="person-card-name">
          {person.hidden ? <FontAwesomeIcon icon={faEyeSlash} aria-hidden="true" /> : null}
          {label}
        </span>
        <span className="person-card-count">
          {person.itemCount === 1 ? "1 item" : `${Number(person.itemCount).toLocaleString()} items`}
        </span>
      </button>
    );
  }, [bulkMode, bulkPersonIds, bulkTargetId, cellWidth, columns, filteredPeople, handlePersonClick]);

  const regroupPeople = useCallback(async () => {
    setRegrouping(true);
    setRegroupError(null);
    try {
      const result = await window.electron.ipcRenderer.invoke("people:recluster");
      if (!result?.success) throw new Error(result?.error || "Unable to regroup people.");
      await load();
    } catch (error) {
      setRegroupError(error.message || "Unable to regroup people.");
    } finally {
      setRegrouping(false);
    }
  }, [load]);

  const loadSuggestion = useCallback(async () => {
    setReviewLoading(true);
    setReviewError(null);
    try {
      const result = await window.electron.ipcRenderer.invoke("people:next-suggestion", { minimumPhotos });
      if (!result?.success) throw new Error(result?.error || "Unable to find a match to review.");
      setSuggestion(result.data ?? null);
    } catch (error) {
      setSuggestion(null);
      setReviewError(error.message || "Unable to find a match to review.");
    } finally {
      setReviewLoading(false);
    }
  }, [minimumPhotos]);

  const openReview = useCallback(async () => {
    setReviewOpen(true);
    await loadSuggestion();
  }, [loadSuggestion]);

  const saveDecision = useCallback(async (kind) => {
    if (!suggestedPeople) return;
    setDecisionSaving(true);
    setReviewError(null);
    try {
      const result = await window.electron.ipcRenderer.invoke("people:decision", {
        kind,
        firstPersonId: suggestedPeople.first.id,
        secondPersonId: suggestedPeople.second.id,
      });
      if (!result?.success) throw new Error(result?.error || "Unable to save this decision.");
      await load();
      await loadSuggestion();
    } catch (error) {
      setReviewError(error.message || "Unable to save this decision.");
    } finally {
      setDecisionSaving(false);
    }
  }, [load, loadSuggestion, suggestedPeople]);

  const openReviewImage = useCallback((person) => {
    setReviewImage(person);
    setReviewImageZoom(1);
    setReviewImageOffset({ x: 0, y: 0 });
    setReviewImageLayout(null);
  }, []);

  const changeReviewImageZoom = useCallback((change) => {
    setReviewImageZoom((current) => {
      const next = Math.max(1, Math.min(5, Number((current + change).toFixed(1))));
      if (next === 1) setReviewImageOffset({ x: 0, y: 0 });
      return next;
    });
  }, []);

  const startReviewImageDrag = useCallback((event) => {
    if (reviewImageZoom <= 1) return;
    event.preventDefault();
    reviewImageDragRef.current = { x: event.clientX, y: event.clientY };
    const move = (nextEvent) => {
      if (!reviewImageDragRef.current) return;
      const deltaX = nextEvent.clientX - reviewImageDragRef.current.x;
      const deltaY = nextEvent.clientY - reviewImageDragRef.current.y;
      setReviewImageOffset((offset) => ({ x: offset.x + deltaX, y: offset.y + deltaY }));
      reviewImageDragRef.current = { x: nextEvent.clientX, y: nextEvent.clientY };
    };
    const stop = () => {
      reviewImageDragRef.current = null;
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", stop);
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", stop);
  }, [reviewImageZoom]);

  const updateReviewImageLayout = useCallback(() => {
    const image = reviewImageElementRef.current;
    if (!image || !image.offsetWidth || !image.offsetHeight) return;
    setReviewImageLayout({
      left: image.offsetLeft,
      top: image.offsetTop,
      width: image.offsetWidth,
      height: image.offsetHeight,
    });
  }, []);

  useEffect(() => {
    if (!reviewImage) return undefined;
    window.addEventListener("resize", updateReviewImageLayout);
    return () => window.removeEventListener("resize", updateReviewImageLayout);
  }, [reviewImage, updateReviewImageLayout]);

  const reviewFaceBox = reviewImage && [
    reviewImage.boxLeft,
    reviewImage.boxTop,
    reviewImage.boxWidth,
    reviewImage.boxHeight,
  ].every((value) => Number.isFinite(Number(value))) && Number(reviewImage.boxWidth) > 0 && Number(reviewImage.boxHeight) > 0
    ? {
      left: Number(reviewImage.boxLeft),
      top: Number(reviewImage.boxTop),
      width: Number(reviewImage.boxWidth),
      height: Number(reviewImage.boxHeight),
    }
    : null;

  return (
    <div className="people-view">
      <div className="people-toolbar">
        {bulkMode ? (
          <div className="people-bulk-status" role="status">
            {bulkMode === "merge-target" && <span>Choose the person to merge into</span>}
            {bulkMode === "merge-select" && <span>Merge {bulkPersonIds.length} {bulkPersonIds.length === 1 ? "person" : "people"} into {bulkTarget?.displayName ?? "this person"}</span>}
            {bulkMode === "hide" && <span>Hide {bulkPersonIds.length} {bulkPersonIds.length === 1 ? "person" : "people"}</span>}
          </div>
        ) : <div className="people-title"><span>People</span></div>}
        <div className="people-toolbar-actions">
          {!bulkMode && (
            <>
              <button
                type="button"
                className="people-regroup-button"
                onClick={startBulkMerge}
                disabled={unavailable || regrouping || reviewLoading || decisionSaving}
                title="Choose a destination person, then select people to merge into it"
              >
                Bulk merge
              </button>
              <button
                type="button"
                className="people-regroup-button"
                onClick={startBulkHide}
                disabled={unavailable || regrouping || reviewLoading || decisionSaving}
                title="Select people to hide from the People view"
              >
                Bulk hide
              </button>
            </>
          )}
          {bulkMode && (
            <>
              {bulkMode !== "merge-target" && (
                <button
                  type="button"
                  className={bulkMode === "hide" ? "people-bulk-hide-button" : "people-bulk-merge-button"}
                  onClick={openBulkConfirmation}
                  disabled={!bulkPersonIds.length || bulkSaving}
                >
                  {bulkMode === "hide" ? "Hide selected" : "Merge selected"}
                </button>
              )}
              <button type="button" className="people-regroup-button" onClick={cancelBulkMode} disabled={bulkSaving}>Cancel</button>
            </>
          )}
          <button
            type="button"
            className="people-regroup-button"
            onClick={regroupPeople}
            disabled={unavailable || regrouping || !!bulkMode}
            title="Regroup detected faces using the current matching rules"
          >
            <FontAwesomeIcon icon={faArrowsRotate} aria-hidden="true" />
            {regrouping ? "Regrouping..." : "Regroup people"}
          </button>
          <button
            type="button"
            className="people-regroup-button"
            onClick={openReview}
            disabled={unavailable || regrouping || reviewLoading || decisionSaving || !!bulkMode}
            title="Review likely duplicate people without merging them automatically"
          >
            Review matches
          </button>
          <label className="people-search">
            <FontAwesomeIcon icon={faMagnifyingGlass} aria-hidden="true" />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search people..." aria-label="Search people" />
          </label>
        </div>
      </div>
      <div className="people-content" ref={containerRef}>
        {loading && <div className="memories-loading"><div className="loader" /></div>}
        {!loading && unavailable && <div className="memories-empty"><p>Download Facial Recognition in Settings to find people in your library.</p></div>}
        {!loading && !unavailable && regroupError && <div className="people-regroup-error" role="alert">{regroupError}</div>}
        {!loading && !unavailable && filteredPeople.length === 0 && <div className="memories-empty"><p>{query.trim() ? "No people match your search." : "No grouped people found yet. Facial recognition continues indexing in the background."}</p></div>}
        {!loading && !unavailable && filteredPeople.length > 0 && size.width > 0 && (
          <Grid
            width={size.width}
            height={size.height}
            columnCount={columns}
            columnWidth={cellWidth + GRID_GAP}
            rowCount={rows}
            rowHeight={CARD_HEIGHT + GRID_GAP}
            cellRenderer={renderCell}
            overscanRowCount={2}
            overscanColumnCount={1}
            style={{ outline: "none", overflowX: "hidden" }}
          />
        )}
      </div>
      {contextMenu && (
        <PeopleContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          person={contextMenu.person}
          disabled={unavailable || personActionSaving}
          onClose={() => setContextMenu(null)}
          onRename={openRenamePerson}
          onSplit={openSplitPerson}
          onToggleHidden={togglePersonHidden}
        />
      )}
      {faceGridPerson && (
        <div className="people-face-grid-overlay" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) closeFaceGrid();
        }}>
          <section className="people-face-grid-dialog" role="dialog" aria-modal="true" aria-labelledby="people-face-grid-title">
            <div className="people-face-grid-header">
              <div>
                <h2 id="people-face-grid-title">Faces for {faceGridPerson.displayName}</h2>
                {!faceGridLoading && !faceGridError && <span>{faceGridFaces.length === 1 ? "1 face" : `${faceGridFaces.length.toLocaleString()} faces`}</span>}
              </div>
              <div className="people-face-grid-header-actions">
                <button type="button" className="people-face-grid-hide" onClick={hideFaceGridPerson} disabled={personActionSaving || faceGridActionId != null}>{personActionSaving ? "Hiding..." : "Hide person"}</button>
                <button type="button" onClick={closeFaceGrid} disabled={faceGridActionId != null}>Close</button>
              </div>
            </div>
            <div className="people-face-grid-content">
              {faceGridLoading && <div className="memories-loading"><div className="loader" /></div>}
              {!faceGridLoading && faceGridError && <div className="people-regroup-error" role="alert">{faceGridError}</div>}
              {!faceGridLoading && !faceGridError && faceGridFaces.length === 0 && <div className="people-review-message">No faces are currently assigned to this person.</div>}
              {!faceGridLoading && !faceGridError && faceGridFaces.length > 0 && (
                <div className="person-face-grid">
                  {faceGridFaces.map((face, index) => (
                    <FaceGridAvatar
                      key={face.faceId}
                      face={face}
                      label={`Separate face ${index + 1} from ${faceGridPerson.displayName}`}
                      onSeparate={() => separateFaceFromGrid(face)}
                      separating={faceGridActionId === face.faceId}
                    />
                  ))}
                </div>
              )}
            </div>
          </section>
        </div>
      )}
      {bulkConfirmation && (
        <div className="people-review-overlay" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !bulkSaving) setBulkConfirmation(null);
        }}>
          <section className="people-review-dialog people-bulk-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="people-bulk-confirm-title">
            <h2 id="people-bulk-confirm-title">{bulkConfirmation.kind === "hide" ? "Hide selected people?" : "Merge selected people?"}</h2>
            <p className="people-review-description">
              {bulkConfirmation.kind === "hide"
                ? `${bulkConfirmation.personIds.length} ${bulkConfirmation.personIds.length === 1 ? "person will" : "people will"} be hidden from the People view.`
                : `${bulkConfirmation.personIds.length} ${bulkConfirmation.personIds.length === 1 ? "person will" : "people will"} be merged into ${peopleWithLabels.find((person) => person.id === bulkConfirmation.targetPersonId)?.displayName ?? "the selected person"}.`}
            </p>
            {bulkError && <div className="people-regroup-error" role="alert">{bulkError}</div>}
            <div className="people-bulk-confirm-actions">
              <button type="button" className="people-review-close" onClick={() => setBulkConfirmation(null)} disabled={bulkSaving}>Cancel</button>
              <button
                type="button"
                className={bulkConfirmation.kind === "hide" ? "people-review-remove" : "people-review-merge"}
                onClick={saveBulkDecision}
                disabled={bulkSaving}
              >
                {bulkSaving ? "Saving..." : bulkConfirmation.kind === "hide" ? "Hide people" : "Merge people"}
              </button>
            </div>
          </section>
        </div>
      )}
      {reviewOpen && (
        <div className="people-review-overlay" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !decisionSaving) setReviewOpen(false);
        }}>
          <section className="people-review-dialog" role="dialog" aria-modal="true" aria-labelledby="people-review-title">
            <h2 id="people-review-title">Review possible match</h2>
            {reviewLoading && <div className="people-review-message">Finding the next possible duplicate...</div>}
            {!reviewLoading && reviewError && <div className="people-regroup-error" role="alert">{reviewError}</div>}
            {!reviewLoading && !reviewError && !suggestion && (
              <div className="people-review-message">No unreviewed possible matches yet. Run Regroup people to generate suggestions for the current library.</div>
            )}
            {!reviewLoading && !reviewError && suggestion && !suggestedPeople && (
              <div className="people-review-message">This suggestion is no longer current. Finding another one...</div>
            )}
            {!reviewLoading && !reviewError && suggestedPeople && (
              <>
                <p className="people-review-description">These people were kept separate automatically. Are they the same person?</p>
                <div className="people-review-pair">
                  {[suggestedPeople.first, suggestedPeople.second].map((person) => (
                    <div className="people-review-person" key={person.id}>
                      <button type="button" className="people-review-avatar-button" onClick={() => openReviewImage(person)} title="Open full image">
                        <FaceAvatar person={person} label={person.displayName} />
                      </button>
                      <strong>{person.displayName}</strong>
                      <span>{person.itemCount === 1 ? "1 item" : `${Number(person.itemCount).toLocaleString()} items`}</span>
                      <button
                        type="button"
                        className="people-review-remove"
                        onClick={() => saveDecision(person.id === suggestedPeople.first.id ? "hide-first" : "hide-second")}
                        disabled={decisionSaving}
                      >
                        Hide person
                      </button>
                    </div>
                  ))}
                </div>
                <div className="people-review-actions">
                  <button type="button" className="people-review-remove" onClick={() => saveDecision("hide-both")} disabled={decisionSaving}>Hide both</button>
                  <button type="button" className="people-review-not-same" onClick={() => saveDecision("exclude")} disabled={decisionSaving}>Not the same person</button>
                  <button type="button" className="people-review-merge" onClick={() => saveDecision("merge")} disabled={decisionSaving}>{decisionSaving ? "Saving..." : "Merge people"}</button>
                </div>
              </>
            )}
            <button type="button" className="people-review-close" onClick={() => setReviewOpen(false)} disabled={decisionSaving}>Close</button>
          </section>
        </div>
      )}
      {reviewImage && (
        <div className="people-review-image-overlay" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setReviewImage(null);
        }}>
          <section className="people-review-image-dialog" role="dialog" aria-modal="true" aria-label={`Full image for ${reviewImage.displayName}`}>
            <div className="people-review-image-toolbar">
              <span>{reviewImage.displayName}</span>
              <div>
                <button type="button" onClick={() => changeReviewImageZoom(-0.5)} disabled={reviewImageZoom <= 1} aria-label="Zoom out">−</button>
                <button type="button" onClick={() => { setReviewImageZoom(1); setReviewImageOffset({ x: 0, y: 0 }); }}>100%</button>
                <button type="button" onClick={() => changeReviewImageZoom(0.5)} disabled={reviewImageZoom >= 5} aria-label="Zoom in">+</button>
                <button type="button" onClick={() => setReviewImage(null)}>Close</button>
              </div>
            </div>
            <div className="people-review-image-canvas" onWheel={(event) => {
              event.preventDefault();
              changeReviewImageZoom(event.deltaY < 0 ? 0.2 : -0.2);
            }} onMouseDown={startReviewImageDrag}>
              <img
                ref={reviewImageElementRef}
                className="people-review-full-image"
                src={reviewImage.coverPath ? `http://localhost:54055/files/${encodeURIComponent(reviewImage.coverPath)}` : `orbit://thumbs/${reviewImage.coverFileId}_thumb.jpg`}
                alt={`Full image for ${reviewImage.displayName}`}
                draggable={false}
                onLoad={updateReviewImageLayout}
                style={{ transform: `translate(${reviewImageOffset.x}px, ${reviewImageOffset.y}px) scale(${reviewImageZoom})` }}
              />
              {reviewFaceBox && reviewImageLayout && (
                <svg
                  className="face-focus-overlay face-focus-flash people-review-face-focus"
                  viewBox="0 0 1 1"
                  preserveAspectRatio="none"
                  aria-hidden="true"
                  style={{
                    left: `${reviewImageLayout.left + reviewImageOffset.x + ((1 - reviewImageZoom) * reviewImageLayout.width) / 2}px`,
                    top: `${reviewImageLayout.top + reviewImageOffset.y + ((1 - reviewImageZoom) * reviewImageLayout.height) / 2}px`,
                    width: `${reviewImageLayout.width * reviewImageZoom}px`,
                    height: `${reviewImageLayout.height * reviewImageZoom}px`,
                  }}
                >
                  <defs>
                    <mask id={reviewFaceMaskId} maskUnits="userSpaceOnUse" x="0" y="0" width="1" height="1">
                      <rect width="1" height="1" fill="white" />
                      <rect x={reviewFaceBox.left} y={reviewFaceBox.top} width={reviewFaceBox.width} height={reviewFaceBox.height} fill="black" />
                    </mask>
                  </defs>
                  <rect className="face-focus-dim" width="1" height="1" mask={`url(#${reviewFaceMaskId})`} />
                </svg>
              )}
            </div>
          </section>
        </div>
      )}
      {renamePerson && (
        <Popup
          title="Rename person"
          width={440}
          actions={[
            { label: "Cancel", kind: "secondary", onClick: () => setRenamePerson(null), disabled: personActionSaving },
            { label: personActionSaving ? "Saving..." : "Save", onClick: saveRenamePerson, disabled: personActionSaving || !renameValue.trim() },
          ]}
        >
          <input
            className="settings-content-input"
            type="text"
            value={renameValue}
            maxLength={128}
            autoFocus
            onChange={(event) => setRenameValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") saveRenamePerson();
            }}
            aria-label="Person name"
          />
        </Popup>
      )}
      {splitPerson && (
        <ConfirmPopup
          title="Split person?"
          message={`This will create a separate person for each of ${splitPerson.faceCount} faces.`}
          subMessage="This keeps the faces separate when people are regrouped."
          confirmLabel={personActionSaving ? "Splitting..." : "Split person"}
          onCancel={() => setSplitPerson(null)}
          onConfirm={confirmSplitPerson}
        />
      )}
    </div>
  );
};

export default PeopleView;
