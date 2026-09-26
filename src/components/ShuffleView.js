import React, { useEffect, useState, useRef, useCallback } from "react";
import "./ShuffleView.css";

const ShuffleView = ({
  preloadCount = 3,
  interval = 8000,
  hideMetadata = false,
  smoothTransition = false,
  chronological = false,
  filters = {},
  currentSettings,
}) => {
  const [images, setImages] = useState([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const timerRef = useRef(null);
  const preloadedUrls = useRef(new Set());
  const [displayedIndex, setDisplayedIndex] = useState(0);
  const [prevIndex, setPrevIndex] = useState(null);
  const chronologicalOffset = useRef(0);
  const fetchGenerationRef = useRef(0);

  function formatDate(timestamp) {
    if (!timestamp) return "";
    const date = new Date(timestamp * 1000);
    const pad = (n) => n.toString().padStart(2, "0");
    const day = pad(date.getDate());
    const month = pad(date.getMonth() + 1);
    const year = date.getFullYear();
    const hours = pad(date.getHours());
    const minutes = pad(date.getMinutes());
    const seconds = pad(date.getSeconds());
    return `${day}-${month}-${year} ${hours}:${minutes}:${seconds}`;
  }

  function formatLocalDateString(str) {
    if (!str) return "";
    const [datePart, timePart] = str.split(" ");
    if (!datePart) return "";
    const [year, month, day] = datePart.split("-");
    return `${day}-${month}-${year}${timePart ? " " + timePart : ""}`;
  }

  const preloadImageBytes = useCallback((imgRecords) => {
    const toLoad = imgRecords.filter((f) => !preloadedUrls.current.has(f.url));
    if (toLoad.length === 0) return Promise.resolve();

    return Promise.all(
      toLoad.map(
        (f) =>
          new Promise((resolve) => {
            const img = new Image();
            img.onload = () => {
              preloadedUrls.current.add(f.url);
              resolve();
            };
            img.onerror = () => {
              preloadedUrls.current.add(f.url);
              resolve();
            };
            img.src = f.url;
          }),
      ),
    );
  }, []);

  const fetchNext = useCallback(
    async (count = preloadCount, generation) => {
      try {
        const result = await window.electron.ipcRenderer.invoke("fetch-files", {
          offset: chronological ? chronologicalOffset.current : 0,
          limit: count,
          filters: {
            sortBy: chronological ? "ID" : "random",
            sortOrder: chronological ? "asc" : "desc",
            ...filters,
          },
          settings: currentSettings || {},
        });
        // Discard if filters changed while we were awaiting
        if (generation !== fetchGenerationRef.current) return [];
        if (result?.success) {
          const imagesOnly = result.rows.filter((f) => f.file_type === "image");
          if (chronological) {
            chronologicalOffset.current += result.rows.length;
          }
          return imagesOnly.map((f) => ({
            ...f,
            url: `http://localhost:54055/files/${encodeURIComponent(f.path)}`,
          }));
        }
      } catch (err) {
        console.error("Failed to fetch files:", err);
      }
      return [];
    },
    [preloadCount, chronological, filters, currentSettings],
  );

  const preloadImages = useCallback(
    async (generation) => {
      let newImgs = [];
      while (newImgs.length < preloadCount) {
        const fetched = await fetchNext(
          preloadCount - newImgs.length,
          generation,
        );
        // Empty result could mean stale generation or genuinely no more images
        if (fetched.length === 0) break;
        newImgs = [...newImgs, ...fetched];
      }

      // Don't apply results from a superseded filter set
      if (generation !== fetchGenerationRef.current) return;

      if (newImgs.length > 0) {
        await preloadImageBytes(newImgs);
        if (generation !== fetchGenerationRef.current) return; // check again after preload
        setImages((prev) => [...prev, ...newImgs]);
      }
      setLoading(false);
    },
    [fetchNext, preloadCount, preloadImageBytes],
  );

  useEffect(() => {
    if (images.length === 0) return;
    const upcoming = images.slice(currentIndex + 1, currentIndex + 3);
    if (upcoming.length > 0) preloadImageBytes(upcoming);
  }, [currentIndex, images, preloadImageBytes]);

  const nextImage = useCallback(() => {
    setCurrentIndex((prev) => {
      const next = prev + 1;
      if (next >= images.length) {
        preloadImages(fetchGenerationRef.current);
        return prev;
      }
      setPrevIndex(prev);
      return next;
    });
  }, [images.length, preloadImages]);

  useEffect(() => {
    const generation = ++fetchGenerationRef.current;

    setImages([]);
    setCurrentIndex(0);
    setLoading(true);
    clearInterval(timerRef.current);
    setDisplayedIndex(0);
    setPrevIndex(null);
    preloadedUrls.current = new Set();
    chronologicalOffset.current = 0;
    preloadImages(generation);
  }, [filters, chronological]);

  useEffect(() => {
    if (images.length === 0) return;
    timerRef.current = setInterval(nextImage, interval);
    return () => clearInterval(timerRef.current);
  }, [images, interval]);

  if (loading) {
    return (
      <div className="shuffle-loading">
        <div className="shuffle-loader"></div>
      </div>
    );
  }

  const current = images[currentIndex];
  const displayed = images[displayedIndex];
  if (!current) return null;

  const getHeicClass = (img) =>
    currentSettings?.adjustHeicColors && img?.extension === ".heic"
      ? "heic-color-adjust"
      : "";

  return (
    <div className="shuffle-view">
      {/* Hidden preloader */}
      <img
        key={current.url}
        src={current.url}
        style={{ display: "none" }}
        onLoad={() => {
          if (smoothTransition) setPrevIndex((p) => p); // no-op, prev already set in nextImage
          setDisplayedIndex(currentIndex);
        }}
      />

      <div className="shuffle-image-container">
        {smoothTransition && prevIndex !== null && (
          <img
            key={`prev-${images[prevIndex]?.url}`}
            src={images[prevIndex]?.url}
            alt=""
            className={`shuffle-image shuffle-image-prev ${getHeicClass(images[prevIndex])}`}
          />
        )}
        <img
          key={images[displayedIndex]?.url}
          src={images[displayedIndex]?.url}
          alt={images[displayedIndex]?.filename}
          className={`shuffle-image${smoothTransition ? " shuffle-image-next" : ""} ${getHeicClass(images[displayedIndex])}`}
        />
      </div>

      {!hideMetadata && (
        <div className="shuffle-metadata">
          <div>{displayed.filename}</div>
          {(displayed.create_date_local || displayed.create_date) && (
            <div>
              {displayed.create_date_local
                ? formatLocalDateString(displayed.create_date_local)
                : formatDate(displayed.create_date)}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default ShuffleView;
