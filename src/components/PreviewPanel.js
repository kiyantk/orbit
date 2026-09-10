import React, { useState, useRef, useEffect, useCallback } from "react";
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

// ─── Metadata row ─────────────────────────────────────────────────────────────

const MetaRow = ({ label, value, title, children }) => {
  if (value == null && !children) return null;
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
}) {
  const videoRefNormal = useRef(null);
  const trackRefNormal = useRef(null);
  const videoRefFullscreen = useRef(null);
  const trackRefFullscreen = useRef(null);
  const wasNormalPlayingRef = useRef(false);
  const imgRef = useRef(null);
  const lastMousePos = useRef(null);
  const previousMediaId = useRef(null);

  const [isPlaying, setIsPlaying] = useState(true);
  const [isHovered, setIsHovered] = useState(false);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [isSeeking, setIsSeeking] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [mediaUnavailable, setMediaUnavailable] = useState(false);
  const [itemCountry, setItemCountry] = useState(null);
  const [itemPlace, setItemPlace] = useState(null);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [tags, setTags] = useState([]);

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
  const fileUrl = item
    ? `http://localhost:54055/files/${encodeURIComponent(item.path)}`
    : null;
  const heicClass =
    currentSettings?.adjustHeicColors && item?.extension === ".heic"
      ? "heic-color-adjust"
      : "";

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
      {selectedItemAvailable === false || mediaUnavailable ? (
        <div className="flex justify-center items-center preview-panel-content text-gray-400 text-sm">
          Item could not be found
        </div>
      ) : (
        <div className="flex justify-center preview-panel-content">
          {isLoading && (
            <div className="absolute inset-0 flex justify-center items-center bg-black/50 z-10">
              <div className="loader" />
            </div>
          )}

          {isVideo ? (
            <div
              className="video-wrapper"
              onMouseEnter={() => !isSeeking && setIsHovered(true)}
              onMouseLeave={() => !isSeeking && setIsHovered(false)}
            >
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
            <img
              src={fileUrl}
              alt={item.filename}
              className={`normal-image max-h-[500px] object-contain rounded-lg bg-gray-200 ${isLoading ? "hidden" : ""} ${heicClass}`}
              onClick={openFullscreen}
              onLoad={() => setIsLoading(false)}
              onError={handleMediaError}
              data-visualfilter={currentSettings?.mediaFilter ?? "none"}
            />
          )}
        </div>
      )}

      {/* ── Metadata ── */}
      <div className="metadata-panel" key={panelKey}>
        <MetaRow label="Filename" value={item.filename} />
        <MetaRow
          label="Size"
          value={item.size != null ? formatBytes(item.size) : null}
        />

        {(item.extension || item.file_type) && (
          <MetaRow
            label="Type"
            value={`${item.extension}${item.file_type ? ` (${item.file_type})` : ""}`}
          />
        )}

        {takenDisplay && <MetaRow label="Taken" value={takenDisplay} />}

        <MetaRow label="Device" value={item.device_model} />

        {item.width && item.height && (
          <MetaRow label="Resolution" value={`${item.width}x${item.height}`} />
        )}

        {isVideo && duration > 0 && (
          <MetaRow label="Duration" value={formatDuration(duration)} />
        )}

        {item.latitude != null && item.longitude != null && (
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
        <MetaRow label="Place" value={itemPlace} />
        <MetaRow label="Country" value={item.country ? itemCountry : null} />
        <MetaRow label="Lens" value={item.lens_model} />
        <MetaRow label="ISO" value={item.iso} />
        <MetaRow label="Software" value={item.software} />
        <MetaRow
          label="Megapixels"
          value={item.megapixels ? item.megapixels.toFixed(0) : null}
        />
        <MetaRow
          label="Exposure"
          value={item.exposure_time ? `${item.exposure_time} s` : null}
        />
        <MetaRow label="Color Space" value={item.color_space} />
        <MetaRow label="Flash" value={item.flash} />
        <MetaRow
          label="Aperture"
          value={item.aperture ? `f/${item.aperture}` : null}
        />

        {item.focal_length && (
          <MetaRow
            label="Focal Length"
            value={`${item.focal_length} (${item.focal_length_35mm})`}
          />
        )}

        <MetaRow label="Time Offset" value={item.offset_time_original} />
        <MetaRow label="Make" value={item.camera_make} />

        {(item.create_date || item.created) && birthDate && referenceDate && (
          <MetaRow label="Age" value={calculateAge(birthDate, referenceDate)} />
        )}

        <MetaRow
          label="Modified At"
          value={item.modified ? formatTimestamp(item.modified) : null}
        />
        <MetaRow
          label="Created At"
          value={item.created ? formatTimestamp(item.created) : null}
        />
        <MetaRow label="Path" value={item.path} />
        {smartScore != null && (
          <MetaRow
            label="Similarity"
            value={`${(smartScore * 100).toFixed(1)}%`}
            title={`Raw CLIP cosine similarity: ${smartScore.toFixed(4)}`}
          />
        )}
        <MetaRow label="ID" value={item.id ? item.media_id : null} />

        {tags.length > 0 && (
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
            onClick={(e) => e.stopPropagation()}
          >
            <button className="fullscreen-close" onClick={closeFullscreen}>
              <FontAwesomeIcon icon={faXmark} />
            </button>

            {isVideo ? (
              <div
                className="video-wrapper fullscreen-video"
                onMouseEnter={() => !isSeeking && setIsHovered(true)}
                onMouseLeave={() => !isSeeking && setIsHovered(false)}
              >
                <video
                  ref={videoRefFullscreen}
                  src={fileUrl}
                  onPlay={() => setIsPlaying(true)}
                  onPause={() => setIsPlaying(false)}
                  autoPlay
                  muted={isMuted}
                  loop
                  className="video-element"
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
              <img
                ref={imgRef}
                src={fileUrl}
                alt={item.filename}
                className={`fullscreen-image ${heicClass}`}
                style={{
                  transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`,
                  cursor: zoom > 1 ? "grab" : "auto",
                  transition: lastMousePos.current
                    ? "none"
                    : "transform 0.1s ease-out",
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
            )}
          </div>
        </div>
      )}
    </div>
  );
}
