import React, { useEffect, useState, useRef, useCallback } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "leaflet.markercluster/dist/MarkerCluster.css";
import "leaflet.markercluster/dist/MarkerCluster.Default.css";
import "leaflet.markercluster";
import "leaflet.heat";
import * as topojson from "topojson-client";

const TOPO_URL = "/countries.final.topo.json";

const MapView = ({ mapViewType, filters, currentSettings, onRevealItem }) => {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const clusterLayer = useRef(null);
  const heatLayer = useRef(null);
  const lineLayer = useRef(null);
  const countriesLayer = useRef(null);
  const geoJsonCache = useRef(null);
  const allCoords = useRef([]);
  // Tracks whether the component is still mounted — checked after every await
  const mountedRef = useRef(true);
  const activeLineLayerOnMap = useRef(null);
  const activeHeatLayerOnMap = useRef(null);

  const [mapReady, setMapReady] = useState(false);
  const [loading, setLoading] = useState(false);
  const [firstLoaded, setFirstLoaded] = useState(false);
  const [countryNameMap, setCountryNameMap] = useState({});
  const [countryCounts, setCountryCounts] = useState({});
  const [countryBounds, setCountryBounds] = useState({});
  const [countriesMenuVisible, setCountriesMenuVisible] = useState(false);

  // ─── Helpers ──────────────────────────────────────────────────────────────
  const formatTimestamp = (timestamp) => {
    if (!timestamp) return "";
    const d = new Date(timestamp * 1000);
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  };

  // Returns true when the cluster layer exists AND is currently on the map.
  // This is the key guard that prevents every getMinZoom / null-ref crash.
  const clusterIsOnMap = () =>
    mapRef.current &&
    clusterLayer.current &&
    mapRef.current.hasLayer(clusterLayer.current);

  // ─── Initialize map ───────────────────────────────────────────────────────
  useEffect(() => {
    mountedRef.current = true;

    const map = L.map(containerRef.current, {
      preferCanvas: false,
      maxZoom: 18,
    }).setView([0, 0], 2);

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      maxZoom: 19,
    }).addTo(map);

    const cluster = L.markerClusterGroup({
      chunkedLoading: true,
      chunkInterval: 100,
      chunkDelay: 50,
      maxClusterRadius: 90,
      spiderfyOnMaxZoom: true,
      showCoverageOnHover: false,
      iconCreateFunction(c) {
        const count = c.getChildCount();
        let size, tier;
        if (count < 100) {
          size = 28;
          tier = "small";
        } else if (count < 1000) {
          size = 36;
          tier = "medium";
        } else if (count < 10000) {
          size = 44;
          tier = "large";
        } else {
          size = 52;
          tier = "xlarge";
        }

        const label =
          count >= 1000
            ? `${(count / 1000).toFixed(count >= 10000 ? 0 : 1)}k`
            : count;

        return L.divIcon({
          html: `<div class="custom-cluster custom-cluster--${tier}">${label}</div>`,
          className: "",
          iconSize: [size, size],
          iconAnchor: [size / 2, size / 2],
        });
      },
    });

    // *** Add the cluster layer to the map immediately so it always has a map
    //     reference. MarkerClusterGroup.addLayers() internally calls
    //     map.getMinZoom(), which throws if the layer isn't on a map yet. ***
    map.addLayer(cluster);

    clusterLayer.current = cluster;
    mapRef.current = map;
    setMapReady(true);

    return () => {
      mountedRef.current = false;
      map.remove();
      mapRef.current = null;
      clusterLayer.current = null;
      heatLayer.current = null;
      lineLayer.current = null;
      countriesLayer.current = null;
    };
  }, []);

  // ─── Fetch map data whenever map is ready or filters change ──────────────
  useEffect(() => {
    if (!mapReady) return;

    let cancelled = false;

    const loadMapData = async () => {
      setLoading(true);

      let res;
      try {
        res = await window.electron.ipcRenderer.invoke("fetch-map-data", {
          filters,
        });
      } catch (err) {
        console.error("[MapView] fetch-map-data failed:", err);
        if (!cancelled && mountedRef.current) setLoading(false);
        return;
      }

      // Bail out if the component unmounted or the effect was superseded
      if (cancelled || !mountedRef.current) return;
      if (!res.success) {
        setLoading(false);
        return;
      }

      // Guard: map may have been torn down while awaiting
      if (!mapRef.current || !clusterLayer.current) return;

      const map = mapRef.current;

      // Build markers
      const markers = res.points.map((p) => {
        const marker = L.marker([p.lat, p.lng], {
          icon: L.icon({
            iconUrl: `${process.env.PUBLIC_URL}/marker.png`,
            iconSize: [10, 10],
            iconAnchor: [5, 5],
          }),
        });
        marker.on("click", () => {
          if (!marker.getPopup()) {
            const {
              filename,
              date,
              device,
              country,
              altitude,
              item_id,
              id,
              thumbnail_path,
            } = p.popup;

            const thumbSrc = thumbnail_path
              ? `orbit://thumbs/${item_id}_thumb.jpg`
              : null;

            marker
              .bindPopup(
                `
                  <div class="map-popup-image-wrapper">
                    ${
                      thumbSrc
                        ? `<img 
                             src="${thumbSrc}" 
                             alt="${filename}" 
                             class="map-popup-image"
                           />`
                        : ""
                    }
                    <div class="map-popup-open-label">Open</div>
                  </div>
                  
                  <b>${filename}</b><br>
                  ${formatTimestamp(date)}<br>
                  ${device || "Unknown"}<br>
                  ${country || "Unknown"}
                  ${altitude ? ` | ${altitude.toFixed(0)}m` : ""}
                `,
              );
            
            marker.once("popupopen", (e) => {
              requestAnimationFrame(() => {
                const popup = e.popup.getElement();
              
                const wrapper = popup?.querySelector(
                  ".map-popup-image-wrapper",
                );
              
                if (!wrapper) {
                  console.warn("Popup wrapper missing");
                  return;
                }
              
                wrapper.addEventListener("click", () => {
                  onRevealItem({
                    ...p.popup,
                    media_id: p.popup.id,
                  });
                });
              });
            });
            
            marker.openPopup();
          }
        });
        return marker;
      });

      // Cluster layer is already on the map (added during init), so
      // clearLayers / addLayers are always safe here.
      clusterLayer.current.clearLayers();
      clusterLayer.current.addLayers(markers);

      allCoords.current = res.points.map((p) => [p.lat, p.lng]);

      heatLayer.current = L.heatLayer(allCoords.current, {
        radius: 20,
        blur: 15,
      });

      lineLayer.current = L.featureGroup(
        res.lines.map((seg) => L.polyline(seg, { color: "red", weight: 2 })),
      );

      setCountryCounts(res.countryCounts);
      setCountryBounds(res.countryBounds);

      // Fit to cluster bounds while we still know the layer is on the map
      const bounds = clusterLayer.current.getBounds();
      if (bounds.isValid()) map.fitBounds(bounds);

      // Resolve country names (another async gap — re-check after)
      const entries = await Promise.all(
        Object.keys(res.countryCounts).map(async (code) => [
          code,
          await window.electron.ipcRenderer.invoke("get-country-name", code),
        ]),
      );

      if (cancelled || !mountedRef.current) return;

      setCountryNameMap(Object.fromEntries(entries));
      setFirstLoaded(true);
      setLoading(false);
    };

    loadMapData();

    return () => {
      cancelled = true;
    };
  }, [mapReady, filters]);

  // ─── Load and cache TopoJSON → GeoJSON ───────────────────────────────────
  const loadGeoJson = useCallback(async () => {
    if (geoJsonCache.current) return geoJsonCache.current;

    const res = await fetch(TOPO_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${TOPO_URL}`);
    const topo = await res.json();

    const keys = Object.keys(topo.objects);
    if (!keys.length) throw new Error("TopoJSON has no objects");

    const key = keys.find((k) => k.toLowerCase().includes("countr")) ?? keys[0];

    const geojson = topojson.feature(topo, topo.objects[key]);
    geoJsonCache.current = geojson;
    return geojson;
  }, []);

  // ─── Build / rebuild the countries GeoJSON highlight layer ───────────────
  const buildCountriesLayer = useCallback(
    async (map, visitedCodes) => {
      // Remove any existing countries layer
      if (countriesLayer.current && map.hasLayer(countriesLayer.current)) {
        map.removeLayer(countriesLayer.current);
        countriesLayer.current = null;
      }

      let geojson;
      try {
        geojson = await loadGeoJson();
      } catch (e) {
        console.error("[MapView] Failed to load GeoJSON:", e);
        return;
      }

      // Bail if the map was replaced / unmounted while we were fetching
      if (!mountedRef.current || map !== mapRef.current) return;

      const visitedUpper = {};
      for (const code of Object.keys(visitedCodes)) {
        visitedUpper[code.toUpperCase()] = code;
      }

      const maxCount = Math.max(...Object.values(visitedCodes), 1);

      const getMatchedRawCode = (feature) => {
        const iso = (feature.properties?.ISO_A2 || "").toUpperCase();
        return iso && visitedUpper[iso] ? visitedUpper[iso] : null;
      };

      const layer = L.geoJSON(geojson, {
        style: (feature) => {
          const rawCode = getMatchedRawCode(feature);
          if (!rawCode) {
            return {
              fillColor: "transparent",
              fillOpacity: 0,
              color: "#444",
              weight: 0.4,
              opacity: 0.3,
            };
          }
          const count = visitedCodes[rawCode] || 1;
          const opacity = 0.35 + 0.3 * (count / maxCount);
          return {
            fillColor: "#7f54b3",
            fillOpacity: opacity,
            color: "#4e1982",
            weight: 1.2,
            opacity: 0.9,
          };
        },

        onEachFeature: (feature, featureLayer) => {
          const rawCode = getMatchedRawCode(feature);
          if (!rawCode) return;

          const count = visitedCodes[rawCode] || 0;
          const name =
            feature.properties.ADMIN ||
            feature.properties.NAME ||
            feature.properties.name ||
            feature.properties.NAME_EN ||
            rawCode;

          featureLayer.on({
            mouseover(e) {
              e.target.setStyle({
                fillOpacity: Math.min(
                  (e.target.options.fillOpacity || 0.5) + 0.2,
                  0.92,
                ),
                weight: 2,
              });
              e.target
                .bindTooltip(
                  `<b>${name}</b><br/>${count} photo${count !== 1 ? "s" : ""}`,
                  { sticky: true, className: "country-tooltip" },
                )
                .openTooltip();
            },
            mouseout(e) {
              // countriesLayer.current may have been replaced; guard it
              if (countriesLayer.current)
                countriesLayer.current.resetStyle(e.target);
              e.target.closeTooltip();
            },
            click(e) {
              map.fitBounds(e.target.getBounds(), { padding: [20, 20] });
            },
          });
        },
      });

      countriesLayer.current = layer;
      map.addLayer(layer);

      // Fit to visited countries
      const visitedFeatures = geojson.features.filter(
        (f) => getMatchedRawCode(f) !== null,
      );
      if (visitedFeatures.length) {
        const tempLayer = L.geoJSON({
          type: "FeatureCollection",
          features: visitedFeatures,
        });
        const bounds = tempLayer.getBounds();
        if (bounds.isValid()) map.fitBounds(bounds, { padding: [30, 30] });
      }
    },
    [loadGeoJson],
  );

  // ─── Mode switch ──────────────────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    // Wait until the map and cluster layer both exist
    if (!map || !clusterLayer.current) return;

    // Remove every managed layer that is currently on the map
    const allLayers = [clusterLayer.current, countriesLayer.current];
    allLayers.forEach((l) => l && map.hasLayer(l) && map.removeLayer(l));

    if (activeLineLayerOnMap.current) {
      map.removeLayer(activeLineLayerOnMap.current);
      activeLineLayerOnMap.current = null;
    }

    if (activeHeatLayerOnMap.current) {
      map.removeLayer(activeHeatLayerOnMap.current);
      activeHeatLayerOnMap.current = null;
    }

    setCountriesMenuVisible(false);

    if (mapViewType === "cluster") {
      // clusterLayer is always safe to add — it was initialised on the map
      map.addLayer(clusterLayer.current);
      const bounds = clusterLayer.current.getBounds();
      if (bounds.isValid()) map.fitBounds(bounds);
    } else if (mapViewType === "heatmap") {
      // heatLayer may still be null if data hasn't loaded yet
      if (heatLayer.current) {
        map.addLayer(heatLayer.current);
        activeHeatLayerOnMap.current = heatLayer.current;
        const bounds = L.latLngBounds(allCoords.current);
        if (bounds.isValid()) map.fitBounds(bounds);
      }
    } else if (mapViewType === "line") {
      if (lineLayer.current) {
        map.addLayer(lineLayer.current);
        activeLineLayerOnMap.current = lineLayer.current;
        const bounds = lineLayer.current.getBounds();
        if (bounds.isValid()) map.fitBounds(bounds);
      }
    } else if (mapViewType === "countries") {
      setCountriesMenuVisible(true);
      // Only build if we have data
      if (Object.keys(countryCounts).length > 0) {
        buildCountriesLayer(map, countryCounts);
      }
    }
  }, [mapReady, mapViewType, countryCounts, buildCountriesLayer]);

  // ─── Country panel click ──────────────────────────────────────────────────
  const handleCountryClick = (countryCode) => {
    const map = mapRef.current;
    if (!map || !countryBounds[countryCode]) return;
    const bounds = L.latLngBounds(countryBounds[countryCode]);
    if (bounds.isValid()) map.fitBounds(bounds);
  };

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <>
      <style>{`
        .country-tooltip {
          background: rgba(20, 20, 20, 0.88);
          color: #fff;
          border: 1px solid #4e1982;
          border-radius: 6px;
          font-size: 12px;
          padding: 5px 9px;
          pointer-events: none;
        }
        .country-tooltip::before { display: none; }
      `}</style>

      <div
        ref={containerRef}
        className="map-container"
        data-mapstyle={currentSettings.mapStyle}
        style={{
          height: "calc(100% - 23px)",
          width: "100%",
          display: !loading || firstLoaded ? "block" : "none",
        }}
      />

      {countriesMenuVisible && (
        <div
          id="countriesMenu"
          style={{
            position: "absolute",
            top: 40,
            right: 20,
            minWidth: 250,
            maxHeight: 400,
            overflowY: "auto",
            background: "rgba(44,44,44,0.95)",
            color: "white",
            padding: 10,
            borderRadius: 10,
            zIndex: 1000,
          }}
        >
          <h3 style={{ margin: "0 0 8px" }}>Visited Countries</h3>
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {Object.entries(countryCounts)
              .sort((a, b) => b[1] - a[1])
              .map(([code, count]) => (
                <li
                  key={code}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    cursor: "pointer",
                    padding: "4px 2px",
                  }}
                  onClick={() => handleCountryClick(code)}
                >
                  <img
                    src={`https://cdn.kiy.li/img/flags/${code.toLowerCase()}.svg`}
                    alt={code}
                    style={{
                      width: 20,
                      height: 14,
                      objectFit: "cover",
                      borderRadius: 2,
                    }}
                  />
                  <span>
                    {countryNameMap[code] || code} ({count})
                  </span>
                </li>
              ))}
          </ul>
        </div>
      )}

      {loading && !firstLoaded && (
        <div className="map-loading stats-loading">
          <div className="loader" />
        </div>
      )}

      {loading && firstLoaded && (
        <div className="map-loading-small">
          <div className="loader" />
        </div>
      )}
    </>
  );
};

export default MapView;
