import React, { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faPlay,
  faPause,
  faVolumeMute,
  faVolumeUp,
  faXmark,
  faExpand,
} from "@fortawesome/free-solid-svg-icons";
import { MapContainer, TileLayer, Marker } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import L from "leaflet";
import TagPill from "./TagPill";
import { isPreviewMetadataFieldVisible } from "./previewMetadata";

delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: require("leaflet/dist/images/marker-icon-2x.png"),
  iconUrl: require("leaflet/dist/images/marker-icon.png"),
  shadowUrl: require("leaflet/dist/images/marker-shadow.png"),
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatBytes(a, b = 2) {
  if (!+a) return "Unknown";
  const d = Math.floor(Math.log(a) / Math.log(1000));
  return `${parseFloat((a / Math.pow(1000, d)).toFixed(b < 0 ? 0 : b))} ${
    ["Bytes", "KB", "MB", "GB", "TB", "PB", "EB", "ZB", "YB"][d]
  }`;
}

function formatTimestamp(timestamp) {
  if (!timestamp) return "";
  const date = new Date(timestamp * 1000);
  const pad = (n) => n.toString().padStart(2, "0");
  return `${pad(date.getDate())}-${pad(date.getMonth() + 1)}-${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function formatLocalDateString(str) {
  if (!str) return "";
  const [datePart, timePart] = str.split(" ");
  if (!datePart) return "";
  const [year, month, day] = datePart.split("-");
  return `${day}-${month}-${year}${timePart ? " " + timePart : ""}`;
}

function formatDuration(seconds) {
  const total = Math.floor(seconds);
  const pad = (n) => n.toString().padStart(2, "0");
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
}

function calculateAge(birthDate, epochSeconds) {
  const birth = new Date(birthDate);
  const date = new Date(epochSeconds * 1000);
  let age = date.getFullYear() - birth.getFullYear();
  const monthDiff = date.getMonth() - birth.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && date.getDate() < birth.getDate()))
    age--;
  return age;
}

function getContrastColor(hex) {
  if (!hex) return "#000";
  const rgb = parseInt(hex.substring(1), 16);
  const luminance =
    0.299 * ((rgb >> 16) & 0xff) +
    0.587 * ((rgb >> 8) & 0xff) +
    0.114 * (rgb & 0xff);
  return luminance > 150 ? "#000" : "#fff";
}

function getReferenceEpoch(item) {
  if (item.create_date) return item.create_date;
  const fallback = Math.min(
    item.created ?? Infinity,
    item.modified ?? Infinity,
  );
  return fallback === Infinity ? null : fallback;
}

function safePlay(video) {
  if (!video) return;
  const p = video.play();
  if (p !== undefined) {
    p.catch((err) => {
      if (!err.message.includes("media was removed from the document"))
        console.error(err);
    });
  }
}

function formatFaceMetric(score) {
  const value = Number(score);
  return Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : null;
}

function textSearchTerms(value) {
  return String(value ?? "").normalize("NFKC").toLocaleLowerCase()
    .match(/[\p{L}\p{N}_]+/gu) ?? [];
}

function differsByAtMostOneCharacter(left, right) {
  if (Math.abs(left.length - right.length) > 1) return false;
  let leftIndex = 0;
  let rightIndex = 0;
  let differences = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    if (left[leftIndex] === right[rightIndex]) {
      leftIndex += 1;
      rightIndex += 1;
    } else if (++differences > 1) {
      return false;
    } else if (left.length > right.length) {
      leftIndex += 1;
    } else if (right.length > left.length) {
      rightIndex += 1;
    } else {
      leftIndex += 1;
      rightIndex += 1;
    }
  }
  return true;
}

function boxMatchesTextQuery(detectedText, query) {
  const queryText = String(query ?? "").normalize("NFKC").trim().toLocaleLowerCase();
  const normalizedBoxText = String(detectedText ?? "").normalize("NFKC").trim().toLocaleLowerCase();
  if (!queryText || !normalizedBoxText) return false;
  if (normalizedBoxText.includes(queryText)) return true;
  const queryTerms = textSearchTerms(queryText);
  const boxTerms = textSearchTerms(normalizedBoxText);
  return queryTerms.some((queryTerm) => boxTerms.some((boxTerm) =>
    boxTerm.startsWith(queryTerm) ||
    (queryTerm.length >= 4 && differsByAtMostOneCharacter(queryTerm, boxTerm)),
  ));
}

// ─── Metadata row ─────────────────────────────────────────────────────────────

const MetaRow = ({ label, value, title, children, visible = true }) => {
  if (!visible || (value == null && !children)) return null;
  return (
    <div className={`metadata-row ${"metadata-row-" + label}`}>
      <span className="metadata-label">{label}</span>
      <span className="metadata-value" title={title ?? String(value)}>
        {children ?? value}
      </span>
    </div>
  );
};

// ─── Video controls (shared between normal + fullscreen) ───────────────────────

const VideoControls = React.forwardRef(function VideoControls(
  {
    progress,
    isPlaying,
    isMuted,
    isSeeking,
    onTogglePlay,
    onToggleMute,
    onSeekStart,
    showFullscreen,
    onFullscreen,
  },
  trackRef,
) {
  return (
    <div className="video-overlay">
      {!isSeeking && (
        <>
          <div className="overlay-darken" onClick={onTogglePlay} />
          <button
            onClick={onTogglePlay}
            className="video-control center-control"
          >
            <FontAwesomeIcon icon={isPlaying ? faPause : faPlay} />
          </button>
        </>
      )}
      <div className="video-controls-bottom">
        <div
          className="video-track-wrapper"
          ref={trackRef}
          onMouseDown={onSeekStart}
        >
          <div
            className="video-track-filled"
            style={{ width: `${progress * 100}%` }}
          />
          <div className="video-track-overlay" />
        </div>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onToggleMute();
          }}
          className="video-control mute-control"
        >
          <FontAwesomeIcon icon={isMuted ? faVolumeMute : faVolumeUp} />
        </button>
        {showFullscreen && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onFullscreen();
            }}
            className="video-control fullscreen-control"
          >
            <FontAwesomeIcon icon={faExpand} />
          </button>
        )}
      </div>
    </div>
  );
});

// ─── Main component ───────────────────────────────────────────────────────────

export default function PreviewPanel({
  item,
  isMuted,
  setIsMuted,
  forceFullscreen,
  setForceFullscreen,
  birthDate,
  currentSettings,
  panelKey,
  selectedItemAvailable,
  smartScore,
  textMatch,
  textSearchTerm,
  facePersonId,
}) {
  const videoRefNormal = useRef(null);
  const trackRefNormal = useRef(null);
  const videoRefFullscreen = useRef(null);
  const trackRefFullscreen = useRef(null);
  const wasNormalPlayingRef = useRef(false);
  const imgRef = useRef(null);
  const fullscreenImageContainerRef = useRef(null);
  const lastMousePos = useRef(null);
  const ocrMaskId = useRef(`ocr-focus-mask-${Math.random().toString(36).slice(2)}`).current;
  const faceMaskId = useRef(`face-focus-mask-${Math.random().toString(36).slice(2)}`).current;
  const previousMediaId = useRef(null);
  const previousPlaceNameDisplay = useRef(
    currentSettings?.placesNameDisplay ?? "english",
  );

  const [isPlaying, setIsPlaying] = useState(true);
  const [isHovered, setIsHovered] = useState(false);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [isSeeking, setIsSeeking] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isFullscreenMediaLoading, setIsFullscreenMediaLoading] =
    useState(true);
  const [mediaUnavailable, setMediaUnavailable] = useState(false);
  const [itemCountry, setItemCountry] = useState(null);
  const [itemPlace, setItemPlace] = useState(null);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [tags, setTags] = useState([]);
  const [ocrBoxes, setOcrBoxes] = useState([]);
  const [ocrFocusFlash, setOcrFocusFlash] = useState(false);
  const [ocrOverlayLayout, setOcrOverlayLayout] = useState(null);
  const [faceMetrics, setFaceMetrics] = useState(null);
  const [faceFocusFlash, setFaceFocusFlash] = useState(false);

  const currentVideoRef = isFullscreen ? videoRefFullscreen : videoRefNormal;
  const currentTrackRef = isFullscreen ? trackRefFullscreen : trackRefNormal;

  // Stable refs so seek mousemove handlers always read live values
  const liveTrackRef = useRef(null);
  const liveVideoRef = useRef(null);
  const liveDurationRef = useRef(0);
  liveTrackRef.current = currentTrackRef; // ref object, not .current
  liveVideoRef.current = currentVideoRef; // ref object, not .current
  liveDurationRef.current = duration;
  const progress = duration > 0 ? Math.min(currentTime / duration, 1) : 0;
  const isVideo = item?.file_type?.startsWith("video");
  const placeNameDisplay = currentSettings?.placesNameDisplay ?? "english";
  const countryNameDisplay = currentSettings?.placesCountryNames ?? "name";
  const fileUrl = item
    ? `http://localhost:54055/files/${encodeURIComponent(item.path)}`
    : null;
  const thumbnailUrl = item?.thumbnail_path
    ? `orbit://thumbs/${item.id}_thumb.jpg`
    : null;
  const showThumbnailWhileLoading =
    currentSettings?.showThumbnailWhileFullImageLoads ?? false;
  const useUnavailableThumbnail =
    selectedItemAvailable === false &&
    currentSettings?.unavailableBehaviour === "thumbnail" &&
    thumbnailUrl;
  const heicClass =
    currentSettings?.adjustHeicColors && item?.extension === ".heic"
      ? "heic-color-adjust"
      : "";
  const isMetadataVisible = (field) =>
    isPreviewMetadataFieldVisible(currentSettings, field);
  const updateOcrOverlayLayout = useCallback(() => {
    const image = imgRef.current;
    const container = fullscreenImageContainerRef.current;
    if (!image || !container || !image.offsetWidth || !image.offsetHeight) {
      setOcrOverlayLayout((previous) => previous ? null : previous);
      return;
    }
    const nextLayout = {
      left: image.offsetLeft,
      top: image.offsetTop,
      width: image.offsetWidth,
      height: image.offsetHeight,
    };
    setOcrOverlayLayout((previous) =>
      previous && Object.keys(nextLayout).every((key) => previous[key] === nextLayout[key])
        ? previous
        : nextLayout,
    );
  }, []);
  const matchingOcrBoxes = useMemo(
    () => ocrBoxes.filter((box) => boxMatchesTextQuery(box.text, textSearchTerm)),
    [ocrBoxes, textSearchTerm],
  );
  const ocrFocusKey = matchingOcrBoxes.map((box) =>
    `${box.text}:${box.points.flat().join(",")}`,
  ).join("|");

  // ── Video sync ─────────────────────────────────────────────────────────────

  useEffect(() => {
    const video = currentVideoRef.current;
    if (!video) return;
    const onMetadata = () => {
      if (isFinite(video.duration)) setDuration(video.duration);
    };
    const onTimeUpdate = () => {
      if (!isSeeking) setCurrentTime(video.currentTime);
    };
    video.addEventListener("loadedmetadata", onMetadata);
    video.addEventListener("timeupdate", onTimeUpdate);
    return () => {
      video.removeEventListener("loadedmetadata", onMetadata);
      video.removeEventListener("timeupdate", onTimeUpdate);
    };
  }, [item, isSeeking, isFullscreen]);

  // ── Item change ────────────────────────────────────────────────────────────

  useEffect(() => {
    const isNewMedia = previousMediaId.current !== item.id;

    previousMediaId.current = item.id;

    if(!isNewMedia) return;
    
    setCurrentTime(0);
    setIsPlaying(true);
    setIsLoading(true);
    setIsFullscreenMediaLoading(true);
    setMediaUnavailable(false);

    setItemCountry("");
    setItemPlace("");

    window.electron.ipcRenderer
      .invoke("get-country-name", item.country)
      .then(setItemCountry)
      .catch((err) => console.error("Error converting country:", err));

    // Place
    window.electron.ipcRenderer
      .invoke("location:get-for-files", [item.id])
      .then((result) => {
        if (!result.success || result.rows.length === 0) {
          setItemPlace(null);
          return;
        }

        const location = result.rows[0];

        const place = location.city || location.subdivision || null;

        setItemPlace(place);
      })
      .catch((err) => {
        console.error("Failed to fetch location:", err);
        setItemPlace(null);
      });

    // Always stop normal video while fullscreen is active
    if (isFullscreen && isVideo && videoRefNormal.current) {
      videoRefNormal.current.pause();
    }

    const video = currentVideoRef.current;

    if (video) {
      video.currentTime = 0;

      const playNewVideo = () => {
        safePlay(video);
        setIsPlaying(true);
      };

      video.addEventListener("loadeddata", playNewVideo, { once: true });

      return () => {
        video.removeEventListener("loadeddata", playNewVideo);
      };
    }
  }, [item]);

  // Name preference changes are a display-only update. Refresh the currently
  // visible Place without resetting playback or reprocessing its GPS data.
  useEffect(() => {
    if (previousPlaceNameDisplay.current === placeNameDisplay) return;
    previousPlaceNameDisplay.current = placeNameDisplay;
    if (!item?.id) return;

    window.electron.ipcRenderer
      .invoke("location:get-for-files", [item.id])
      .then((result) => {
        if (!result.success || result.rows.length === 0) {
          setItemPlace(null);
          return;
        }

        const location = result.rows[0];
        setItemPlace(location.city || location.subdivision || null);
      })
      .catch((err) => {
        console.error("Failed to refresh displayed place:", err);
        setItemPlace(null);
      });
  }, [item?.id, placeNameDisplay]);

  // ── Tags ───────────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!item?.id) return;
    window.electron.ipcRenderer
      .invoke("tags:get-all")
      .then((allTags) =>
        setTags(
          (allTags || []).filter((tag) => tag.media_ids.includes(item.id)),
        ),
      )
      .catch((err) => console.error("Failed to fetch tags:", err));
  }, [item, panelKey]);

  useEffect(() => {
    let cancelled = false;
    if (!item?.id || !textSearchTerm || isVideo) {
      setOcrBoxes([]);
      return undefined;
    }
    window.electron.ipcRenderer
      .invoke("ocr:get-for-files", [item.id])
      .then((result) => {
        if (cancelled) return;
        const row = result?.success ? result.rows?.[0] : null;
        setOcrBoxes(Array.isArray(row?.boxes) ? row.boxes : []);
      })
      .catch(() => {
        if (!cancelled) setOcrBoxes([]);
      });
    return () => { cancelled = true; };
  }, [item?.id, textSearchTerm, isVideo]);

  useEffect(() => {
    let cancelled = false;
    if (!item?.id || !facePersonId) {
      setFaceMetrics(null);
      return undefined;
    }

    window.electron.ipcRenderer
      .invoke("people:get-face-metrics", { fileId: item.id, personId: facePersonId })
      .then((result) => {
        if (!cancelled) {
          setFaceMetrics(result?.success && result.data
            ? { ...result.data, fileId: item.id, personId: facePersonId }
            : null);
        }
      })
      .catch(() => {
        if (!cancelled) setFaceMetrics(null);
      });

    return () => {
      cancelled = true;
    };
  }, [item?.id, facePersonId]);

  const displayedFaceMetrics =
    faceMetrics?.fileId === item?.id && faceMetrics.personId === facePersonId
      ? faceMetrics
      : null;
  const faceBox = displayedFaceMetrics &&
    [
      displayedFaceMetrics.boxLeft,
      displayedFaceMetrics.boxTop,
      displayedFaceMetrics.boxWidth,
      displayedFaceMetrics.boxHeight,
    ].every((value) => Number.isFinite(Number(value))) &&
    Number(displayedFaceMetrics.boxWidth) > 0 &&
    Number(displayedFaceMetrics.boxHeight) > 0
    ? {
      left: Number(displayedFaceMetrics.boxLeft),
      top: Number(displayedFaceMetrics.boxTop),
      width: Number(displayedFaceMetrics.boxWidth),
      height: Number(displayedFaceMetrics.boxHeight),
    }
    : null;
  const faceFocusKey = faceBox
    ? `${item.id}:${facePersonId}:${faceBox.left}:${faceBox.top}:${faceBox.width}:${faceBox.height}`
    : "";

  useEffect(() => {
    if (!isFullscreen || isVideo || isFullscreenMediaLoading || !ocrFocusKey) {
      setOcrFocusFlash(false);
      return undefined;
    }
    setOcrFocusFlash(true);
    const timer = setTimeout(() => setOcrFocusFlash(false), 1_100);
    return () => clearTimeout(timer);
  }, [isFullscreen, isVideo, isFullscreenMediaLoading, ocrFocusKey]);

  useEffect(() => {
    if (!isFullscreen || isVideo || isFullscreenMediaLoading || !faceFocusKey) {
      setFaceFocusFlash(false);
      return undefined;
    }
    setFaceFocusFlash(true);
    const timer = setTimeout(() => setFaceFocusFlash(false), 1_100);
    return () => clearTimeout(timer);
  }, [isFullscreen, isVideo, isFullscreenMediaLoading, faceFocusKey]);

  useEffect(() => {
    if (
      !isFullscreen ||
      isVideo ||
      isFullscreenMediaLoading ||
      (!ocrFocusKey && !faceFocusKey)
    ) return undefined;
    updateOcrOverlayLayout();
    let frame = null;
    const handleResize = () => {
      if (frame != null) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(updateOcrOverlayLayout);
    };
    window.addEventListener("resize", handleResize);
    return () => {
      if (frame != null) cancelAnimationFrame(frame);
      window.removeEventListener("resize", handleResize);
    };
  }, [isFullscreen, isVideo, isFullscreenMediaLoading, ocrFocusKey, faceFocusKey, updateOcrOverlayLayout]);

  // ── Keyboard ───────────────────────────────────────────────────────────────

  useEffect(() => {
    const handleKeyDown = (e) => {
      const tag = document.activeElement?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key === "Escape" && isFullscreen) {
        e.preventDefault();
        e.stopPropagation();
        closeFullscreen();
        return;
      }
      if (e.key === " " || e.code === "Space") {
        e.preventDefault();
        togglePlay();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isFullscreen, isPlaying]);

  // ── Fullscreen trigger from parent ─────────────────────────────────────────

  useEffect(() => {
    if (forceFullscreen) {
      openFullscreen();
      setForceFullscreen(false);
    }
  }, [forceFullscreen]);

  // ── Playback ───────────────────────────────────────────────────────────────

  const togglePlay = () => {
    if (!currentVideoRef.current) return;
    if (isPlaying) currentVideoRef.current.pause();
    else safePlay(currentVideoRef.current);
    setIsPlaying((p) => !p);
  };

  const handleMediaError = useCallback(() => {
    setIsLoading(false);
    setMediaUnavailable(true);
    setIsFullscreen(false);
  }, []);

  // ── Seek ───────────────────────────────────────────────────────────────────

  // Reads from stable refs so stale closures in mousemove handlers are never an issue
  const seekToEvent = useCallback((e) => {
    const track = liveTrackRef.current?.current;
    const video = liveVideoRef.current?.current;
    if (!track || !video) return;
    const rect = track.getBoundingClientRect();
    const pos = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
    const newTime = (pos / rect.width) * liveDurationRef.current;
    setCurrentTime(newTime);
    video.currentTime = newTime;
  }, []); // no deps — reads everything from refs

  const handleSeekStart = useCallback(
    (e) => {
      setIsSeeking(true);
      seekToEvent(e);
      const onMove = (eMove) => seekToEvent(eMove);
      const onUp = () => {
        setIsSeeking(false);
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [seekToEvent],
  );

  // ── Fullscreen ─────────────────────────────────────────────────────────────

  const openFullscreen = () => {
    setIsFullscreen(true);
    setIsFullscreenMediaLoading(true);
    setZoom(1);
    setOffset({ x: 0, y: 0 });
    if (isVideo && videoRefNormal.current) {
      wasNormalPlayingRef.current = !videoRefNormal.current.paused;
      videoRefNormal.current.pause();
    }
    setTimeout(() => {
      if (videoRefNormal.current && videoRefFullscreen.current) {
        videoRefFullscreen.current.currentTime =
          videoRefNormal.current.currentTime;
        isPlaying
          ? safePlay(videoRefFullscreen.current)
          : videoRefFullscreen.current.pause();
      }
    }, 0);
  };

  const closeFullscreen = () => {
    if (videoRefNormal.current && videoRefFullscreen.current) {
      videoRefNormal.current.currentTime =
        videoRefFullscreen.current.currentTime;
      if (isPlaying) safePlay(videoRefNormal.current);
    }
    setIsFullscreen(false);
  };

  // ── Image pan/zoom ─────────────────────────────────────────────────────────

  const handleWheel = (e) => {
    e.preventDefault();
    const newZoom = Math.min(
      Math.max(zoom + (e.deltaY < 0 ? 0.1 : -0.1), 1),
      5,
    );
    setZoom(newZoom);
    if (newZoom === 1) setOffset({ x: 0, y: 0 });
  };

  const handleMouseDown = (e) => {
    e.preventDefault();
    lastMousePos.current = { x: e.clientX, y: e.clientY };
    const onMove = (eMove) => {
      if (!lastMousePos.current) return;
      const dx = eMove.clientX - lastMousePos.current.x;
      const dy = eMove.clientY - lastMousePos.current.y;
      setOffset((prev) => ({ x: prev.x + dx, y: prev.y + dy }));
      lastMousePos.current = { x: eMove.clientX, y: eMove.clientY };
    };
    const onUp = () => {
      lastMousePos.current = null;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  // ── Early return ───────────────────────────────────────────────────────────

  if (!item) return null;

  const referenceDate = getReferenceEpoch(item);
  const takenDisplay = item.create_date_local
    ? formatLocalDateString(item.create_date_local)
    : formatTimestamp(item.create_date);

  const videoControlProps = {
    progress,
    isPlaying,
    isMuted,
    isSeeking,
    onTogglePlay: togglePlay,
    onToggleMute: () => setIsMuted((m) => !m),
    onSeekStart: handleSeekStart,
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="p-4 space-y- preview-panel-wrapper">
      {/* ── Media preview ── */}
      {(selectedItemAvailable === false && !useUnavailableThumbnail) ||
      mediaUnavailable ? (
        <div className="flex justify-center items-center preview-panel-content text-gray-400 text-sm">
          Item could not be found
        </div>
      ) : (
        <div className="flex justify-center preview-panel-content">
          {isLoading && !useUnavailableThumbnail && (
            <div className="preview-media-loader" aria-label="Loading media">
              <div className="loader" />
            </div>
          )}

          {useUnavailableThumbnail ? (
            <img
              src={thumbnailUrl}
              alt={item.filename}
              className="normal-image max-h-[500px] object-contain rounded-lg bg-gray-200 preview-thumbnail"
              data-visualfilter={currentSettings?.mediaFilter ?? "none"}
            />
          ) : isVideo ? (
            <div
              className="video-wrapper"
              onMouseEnter={() => !isSeeking && setIsHovered(true)}
              onMouseLeave={() => !isSeeking && setIsHovered(false)}
            >
              {isLoading && showThumbnailWhileLoading && thumbnailUrl && (
                <img
                  src={thumbnailUrl}
                  alt=""
                  aria-hidden="true"
                  className="normal-image max-h-[500px] object-contain rounded-lg bg-gray-200 preview-thumbnail"
                  data-visualfilter={currentSettings?.mediaFilter ?? "none"}
                />
              )}
              <video
                ref={videoRefNormal}
                src={fileUrl}
                autoPlay
                muted={isMuted}
                loop
                className={`video-element ${isLoading ? "hidden" : ""}`}
                onLoadedData={() => setIsLoading(false)}
                onError={handleMediaError}
                data-visualfilter={currentSettings?.mediaFilter ?? "none"}
              />
              {isHovered && (
                <VideoControls
                  ref={trackRefNormal}
                  {...videoControlProps}
                  showFullscreen
                  onFullscreen={openFullscreen}
                />
              )}
            </div>
          ) : (
            <>
              {isLoading && showThumbnailWhileLoading && thumbnailUrl && (
                <img
                  src={thumbnailUrl}
                  alt={item.filename}
                  className="normal-image max-h-[500px] object-contain rounded-lg bg-gray-200 preview-thumbnail"
                  onClick={openFullscreen}
                  data-visualfilter={currentSettings?.mediaFilter ?? "none"}
                />
              )}
              <img
                src={fileUrl}
                alt={item.filename}
                className={`normal-image max-h-[500px] object-contain rounded-lg bg-gray-200 ${isLoading ? "hidden" : ""} ${heicClass}`}
                onClick={openFullscreen}
                onLoad={() => setIsLoading(false)}
                onError={handleMediaError}
                data-visualfilter={currentSettings?.mediaFilter ?? "none"}
              />
            </>
          )}
        </div>
      )}

      {/* ── Metadata ── */}
      <div className="metadata-panel" key={panelKey}>
        <MetaRow
          label="Filename"
          value={item.filename}
          visible={isMetadataVisible("filename")}
        />
        <MetaRow
          label="Size"
          value={item.size != null ? formatBytes(item.size) : null}
          visible={isMetadataVisible("size")}
        />

        {isMetadataVisible("type") && (item.extension || item.file_type) && (
          <MetaRow
            label="Type"
            value={`${item.extension}${item.file_type ? ` (${item.file_type})` : ""}`}
          />
        )}

        {takenDisplay && (
          <MetaRow
            label="Taken"
            value={takenDisplay}
            visible={isMetadataVisible("taken")}
          />
        )}

        <MetaRow
          label="Device"
          value={item.device_model}
          visible={isMetadataVisible("device")}
        />

        {item.width && item.height && (
          <MetaRow
            label="Resolution"
            value={`${item.width}x${item.height}`}
            visible={isMetadataVisible("resolution")}
          />
        )}

        {isVideo && duration > 0 && (
          <MetaRow
            label="Duration"
            value={formatDuration(duration)}
            visible={isMetadataVisible("duration")}
          />
        )}

        {isMetadataVisible("location") &&
          item.latitude != null &&
          item.longitude != null && (
          <MetaRow
            label="Location"
            title={`${item.latitude}, ${item.longitude}${item.altitude != null ? `, ${item.altitude.toFixed(0)} m` : ""}`}
          >
            <div style={{ width: "100%", height: 150 }}>
              <MapContainer
                key={item.id}
                center={[item.latitude, item.longitude]}
                zoom={13}
                style={{
                  width: "100%",
                  height: "100%",
                  userSelect: "none",
                  marginTop: 5,
                }}
              >
                <TileLayer
                  url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                  attribution="&copy; OpenStreetMap contributors"
                />
                <Marker position={[item.latitude, item.longitude]} />
              </MapContainer>
            </div>
            <div
              style={{
                padding: "2px 0",
                backgroundColor: "#28262d",
                borderRadius: "0 0 10px 10px",
              }}
            >
              {item.latitude}, {item.longitude}
              {item.altitude != null && `, ${item.altitude.toFixed(0)} m`}
            </div>
          </MetaRow>
        )}
        <MetaRow
          label="Place"
          value={itemPlace}
          visible={isMetadataVisible("place")}
        />
        <MetaRow
          label="Country"
          value={
            item.country
              ? countryNameDisplay === "code"
                ? String(item.country).toUpperCase()
                : itemCountry
              : null
          }
          visible={isMetadataVisible("country")}
        />
        <MetaRow
          label="Lens"
          value={item.lens_model}
          visible={isMetadataVisible("lens")}
        />
        <MetaRow label="ISO" value={item.iso} visible={isMetadataVisible("iso")} />
        <MetaRow
          label="Software"
          value={item.software}
          visible={isMetadataVisible("software")}
        />
        <MetaRow
          label="Megapixels"
          value={item.megapixels ? item.megapixels.toFixed(0) : null}
          visible={isMetadataVisible("megapixels")}
        />
        <MetaRow
          label="Exposure"
          value={item.exposure_time ? `${item.exposure_time} s` : null}
          visible={isMetadataVisible("exposure")}
        />
        <MetaRow
          label="Color Space"
          value={item.color_space}
          visible={isMetadataVisible("colorSpace")}
        />
        <MetaRow
          label="Flash"
          value={item.flash}
          visible={isMetadataVisible("flash")}
        />
        <MetaRow
          label="Aperture"
          value={item.aperture ? `f/${item.aperture}` : null}
          visible={isMetadataVisible("aperture")}
        />

        {item.focal_length && (
          <MetaRow
            label="Focal Length"
            value={`${item.focal_length} (${item.focal_length_35mm})`}
            visible={isMetadataVisible("focalLength")}
          />
        )}

        <MetaRow
          label="Time Offset"
          value={item.offset_time_original}
          visible={isMetadataVisible("timeOffset")}
        />
        <MetaRow
          label="Make"
          value={item.camera_make}
          visible={isMetadataVisible("make")}
        />

        {(item.create_date || item.created) && birthDate && referenceDate && (
          <MetaRow
            label="Age"
            value={calculateAge(birthDate, referenceDate)}
            visible={isMetadataVisible("age")}
          />
        )}

        <MetaRow
          label="Modified At"
          value={item.modified ? formatTimestamp(item.modified) : null}
          visible={isMetadataVisible("modifiedAt")}
        />
        <MetaRow
          label="Created At"
          value={item.created ? formatTimestamp(item.created) : null}
          visible={isMetadataVisible("createdAt")}
        />
        <MetaRow
          label="Path"
          value={item.path}
          visible={isMetadataVisible("path")}
        />
        {isMetadataVisible("similarity") && smartScore != null && (
          <MetaRow
            label="Similarity"
            value={`${(smartScore * 100).toFixed(1)}%`}
            title={`Raw CLIP cosine similarity: ${smartScore.toFixed(4)}`}
          />
        )}
        {isMetadataVisible("similarity") && textMatch && (
          <MetaRow
            label="Text match"
            value={textMatch}
            title="Matched against text detected in this image"
          />
        )}
        {displayedFaceMetrics && (
          <>
            <MetaRow
              label="Face Confidence"
              value={formatFaceMetric(displayedFaceMetrics.confidence)}
              title={`Raw face-detection confidence: ${Number(displayedFaceMetrics.confidence).toFixed(4)}`}
            />
            <MetaRow
              label="Face Quality"
              value={formatFaceMetric(displayedFaceMetrics.quality)}
              title={`Raw face-recognition quality: ${Number(displayedFaceMetrics.quality).toFixed(4)}`}
            />
          </>
        )}
        <MetaRow
          label="ID"
          value={item.id ? item.media_id : null}
          visible={isMetadataVisible("id")}
        />

        {isMetadataVisible("tags") && tags.length > 0 && (
          <MetaRow label="Tags">
            {tags.map((tag) => (
              <TagPill key={tag.id} tag={tag} style={{ marginRight: 4 }} />
            ))}
          </MetaRow>
        )}
      </div>

      {/* ── Fullscreen overlay ── */}
      {isFullscreen && (
        <div className="fullscreen-overlay" onClick={closeFullscreen}>
          <div
            className="fullscreen-content"
          >
            <button className="fullscreen-close" onClick={closeFullscreen}>
              <FontAwesomeIcon icon={faXmark} />
            </button>

            {isVideo ? (
              <div
                className={`video-wrapper fullscreen-video ${isFullscreenMediaLoading ? "fullscreen-video-loading" : ""}`}
                onClick={(e) => {
                  if (e.target === e.currentTarget) closeFullscreen();
                  else e.stopPropagation();
                }}
                onMouseEnter={() => !isSeeking && setIsHovered(true)}
                onMouseLeave={() => !isSeeking && setIsHovered(false)}
              >
                {isFullscreenMediaLoading &&
                  showThumbnailWhileLoading &&
                  thumbnailUrl && (
                    <img
                      src={thumbnailUrl}
                      alt=""
                      aria-hidden="true"
                      className="fullscreen-video-thumbnail preview-thumbnail"
                      data-visualfilter={currentSettings?.mediaFilter ?? "none"}
                    />
                  )}
                <video
                  ref={videoRefFullscreen}
                  src={fileUrl}
                  onPlay={() => setIsPlaying(true)}
                  onPause={() => setIsPlaying(false)}
                  autoPlay
                  muted={isMuted}
                  loop
                  className={`video-element ${isFullscreenMediaLoading ? "hidden" : ""}`}
                  onLoadedData={() => setIsFullscreenMediaLoading(false)}
                  onError={handleMediaError}
                  data-visualfilter={currentSettings?.mediaFilter ?? "none"}
                />
                {(isHovered || isSeeking) && (
                  <VideoControls
                    ref={trackRefFullscreen}
                    {...videoControlProps}
                    showFullscreen={false}
                  />
                )}
              </div>
            ) : (
              <div
                ref={fullscreenImageContainerRef}
                className="fullscreen-image-container"
                onClick={(e) => {
                  if (e.target === e.currentTarget) closeFullscreen();
                  else e.stopPropagation();
                }}
              >
                {isFullscreenMediaLoading &&
                  showThumbnailWhileLoading &&
                  thumbnailUrl && (
                    <img
                      src={thumbnailUrl}
                      alt=""
                      aria-hidden="true"
                      className="fullscreen-image preview-thumbnail"
                      data-visualfilter={currentSettings?.mediaFilter ?? "none"}
                    />
                  )}
                <img
                  ref={imgRef}
                  src={fileUrl}
                  alt={item.filename}
                  className={`fullscreen-image ${isFullscreenMediaLoading ? "hidden" : ""} ${heicClass}`}
                  style={{
                    transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`,
                    cursor: zoom > 1 ? "grab" : "auto",
                    // A transformed image plus a full-size masked SVG forces
                    // Chromium to animate two large surfaces. Keep OCR focus
                    // responsive by applying its zoom/pan without animation.
                    transition: matchingOcrBoxes.length > 0
                      ? "none"
                      : lastMousePos.current
                      ? "none"
                      : "transform 0.1s ease-out",
                  }}
                  onLoad={() => {
                    setIsFullscreenMediaLoading(false);
                    requestAnimationFrame(updateOcrOverlayLayout);
                  }}
                  onWheel={handleWheel}
                  onMouseDown={zoom > 1 ? handleMouseDown : undefined}
                  onDoubleClick={() => {
                    setZoom(1);
                    setOffset({ x: 0, y: 0 });
                  }}
                  onError={handleMediaError}
                  data-visualfilter={currentSettings?.mediaFilter ?? "none"}
                />
                {!isFullscreenMediaLoading && ocrOverlayLayout && matchingOcrBoxes.length > 0 && (
                  <svg
                    className={`ocr-focus-overlay ${ocrFocusFlash ? "ocr-focus-flash" : ""}`}
                    viewBox="0 0 1 1"
                    preserveAspectRatio="none"
                    aria-hidden="true"
                    style={{
                      // This is mathematically the same center-origin scale
                      // and translation as the image, but avoids an expensive
                      // transform animation on the masked SVG layer.
                      left: `${ocrOverlayLayout.left + offset.x + ((1 - zoom) * ocrOverlayLayout.width) / 2}px`,
                      top: `${ocrOverlayLayout.top + offset.y + ((1 - zoom) * ocrOverlayLayout.height) / 2}px`,
                      width: `${ocrOverlayLayout.width * zoom}px`,
                      height: `${ocrOverlayLayout.height * zoom}px`,
                    }}
                  >
                    <defs>
                      <mask id={ocrMaskId} maskUnits="userSpaceOnUse" x="0" y="0" width="1" height="1">
                        <rect width="1" height="1" fill="white" />
                        {matchingOcrBoxes.map((box, index) => (
                          <polygon
                            key={`mask-${index}`}
                            points={box.points.map((point) => point.join(",")).join(" ")}
                            fill="black"
                          />
                        ))}
                      </mask>
                    </defs>
                    <rect
                      className="ocr-focus-dim"
                      width="1"
                      height="1"
                      mask={`url(#${ocrMaskId})`}
                    />
                    {matchingOcrBoxes.map((box, index) => (
                      <polygon
                        className="ocr-focus-box"
                        key={`box-${index}`}
                        points={box.points.map((point) => point.join(",")).join(" ")}
                      />
                    ))}
                  </svg>
                )}
                {!isFullscreenMediaLoading && ocrOverlayLayout && faceBox && (
                  <svg
                    className={`face-focus-overlay ${faceFocusFlash ? "face-focus-flash" : ""}`}
                    viewBox="0 0 1 1"
                    preserveAspectRatio="none"
                    aria-hidden="true"
                    style={{
                      left: `${ocrOverlayLayout.left + offset.x + ((1 - zoom) * ocrOverlayLayout.width) / 2}px`,
                      top: `${ocrOverlayLayout.top + offset.y + ((1 - zoom) * ocrOverlayLayout.height) / 2}px`,
                      width: `${ocrOverlayLayout.width * zoom}px`,
                      height: `${ocrOverlayLayout.height * zoom}px`,
                    }}
                  >
                    <defs>
                      <mask id={faceMaskId} maskUnits="userSpaceOnUse" x="0" y="0" width="1" height="1">
                        <rect width="1" height="1" fill="white" />
                        <rect
                          x={faceBox.left}
                          y={faceBox.top}
                          width={faceBox.width}
                          height={faceBox.height}
                          fill="black"
                        />
                      </mask>
                    </defs>
                    <rect
                      className="face-focus-dim"
                      width="1"
                      height="1"
                      mask={`url(#${faceMaskId})`}
                    />
                  </svg>
                )}
              </div>
            )}
          </div>
          {isFullscreenMediaLoading && (
            <div className="fullscreen-image-loader" aria-label="Loading image">
              <div className="loader" />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
