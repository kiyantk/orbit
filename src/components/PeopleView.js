import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Grid } from "react-virtualized";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faMagnifyingGlass, faUser, faUsers } from "@fortawesome/free-solid-svg-icons";
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
  const sourceUrl = person.coverFileId ? `orbit://thumbs/${person.coverFileId}_thumb.jpg` : null;
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
  const imageStyle = {
    width: renderedWidth,
    height: renderedHeight,
    left: 72 - centerX * renderedWidth,
    top: 72 - centerY * renderedHeight,
  };

  return (
    <div className="person-avatar" aria-hidden="true">
      {sourceUrl ? <img src={sourceUrl} alt="" draggable={false} style={imageStyle} /> : <FontAwesomeIcon icon={faUsers} />}
      <span className="person-avatar-ring" />
      <span className="sr-only">{label}</span>
    </div>
  );
}

const PeopleView = ({ onViewPerson, onCountChange }) => {
  const [people, setPeople] = useState([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [resource, setResource] = useState(null);
  const containerRef = useRef(null);
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

  const filteredPeople = useMemo(() => {
    const search = normaliseText(query.trim());
    if (!search) return peopleWithLabels;
    return peopleWithLabels.filter((person) => normaliseText(person.displayName).includes(search));
  }, [peopleWithLabels, query]);

  useEffect(() => {
    onCountChange?.({ total: people.length, filtered: filteredPeople.length });
  }, [people.length, filteredPeople.length, onCountChange]);

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
        className="person-card"
        style={{
          ...style,
          left: columnIndex * (cellWidth + GRID_GAP),
          top: rowIndex * (CARD_HEIGHT + GRID_GAP),
          width: cellWidth,
          height: CARD_HEIGHT,
        }}
        onClick={() => person.fileIds?.length && onViewPerson(person)}
      >
        <FaceAvatar person={person} label={label} />
        <span className="person-card-name">{label}</span>
        <span className="person-card-count">
          {person.itemCount === 1 ? "1 item" : `${Number(person.itemCount).toLocaleString()} items`}
        </span>
      </button>
    );
  }, [cellWidth, columns, filteredPeople, onViewPerson]);

  const unavailable = resource?.state === "download-required" || resource?.state === "download-failed";

  return (
    <div className="people-view">
      <div className="people-toolbar">
        <div className="people-title"><span>People</span></div>
        <label className="people-search">
          <FontAwesomeIcon icon={faMagnifyingGlass} aria-hidden="true" />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search people..." aria-label="Search people" />
        </label>
      </div>
      <div className="people-content" ref={containerRef}>
        {loading && <div className="memories-loading"><div className="loader" /></div>}
        {!loading && unavailable && <div className="memories-empty"><p>Download Facial Recognition in Settings to find people in your library.</p></div>}
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
    </div>
  );
};

export default PeopleView;
