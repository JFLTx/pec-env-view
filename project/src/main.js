import "maplibre-gl/dist/maplibre-gl.css";
import "./style.css";
import maplibregl from "maplibre-gl";
import { Protocol } from "pmtiles";

// KMZ handling
import JSZip from "jszip";
import * as toGeoJSON from "@tmcw/togeojson";

// Turf
import bbox from "@turf/bbox";
import length from "@turf/length";
import area from "@turf/area";
import { lineString, polygon } from "@turf/helpers";

const loadingScreen = document.getElementById("loading-screen");

const KMZ_SOURCE_ID = "uploaded-kmz";
const KMZ_POINT_LAYER_ID = "uploaded-kmz-point";
const KMZ_LINE_LAYER_ID = "uploaded-kmz-line";
const KMZ_FILL_LAYER_ID = "uploaded-kmz-fill";

const MEASURE_SOURCE_ID = "measure-source";
const MEASURE_LINE_ID = "measure-line";
const MEASURE_FILL_ID = "measure-fill";
const MEASURE_POINTS_ID = "measure-points";

const KMZ_DB_NAME = "map-upload-cache";
const KMZ_STORE_NAME = "uploads";
const KMZ_RECORD_KEY = "uploaded-kmz";

const COLLECT_STORE_NAME = "collected-points";
const COLLECT_RECORD_KEY = "collection-features";

const EMPTY_FEATURE_COLLECTION = {
  type: "FeatureCollection",
  features: [],
};

let uploadedKmzData = {
  type: "FeatureCollection",
  features: [],
};

let measureMode = null; // "distance" | "area" | null
let measureCoords = [];
let measurePopup = null;

let collectMode = false;
let collectedFeatures = []; // array of GeoJSON Feature objects
let pendingMarker = null;   // unsaved pin while sheet is open
let editingFeatureId = null;
let suppressMapClick = false;
const savedMarkers = new Map(); // featureId → maplibregl.Marker

function setKmzStatus(message, isError = false) {
  const statusEl = document.getElementById("kmz-status");
  if (!statusEl) return;
  statusEl.textContent = message;
  statusEl.classList.toggle("error", isError);
}

async function parseKmzToGeoJSON(file) {
  const arrayBuffer = await file.arrayBuffer();
  const zip = await JSZip.loadAsync(arrayBuffer);
  const kmlEntry = Object.values(zip.files).find(
    (entry) => !entry.dir && entry.name.toLowerCase().endsWith(".kml"),
  );

  if (!kmlEntry) {
    throw new Error("KMZ does not contain a KML file.");
  }

  const kmlText = await kmlEntry.async("text");
  return parseKmlTextToGeoJSON(kmlText);
}

function parseKmlTextToGeoJSON(kmlText) {
  kmlText = kmlText.replace(/^\uFEFF/, "");

  if (
    kmlText.includes("xsi:schemaLocation") &&
    !kmlText.includes("xmlns:xsi=")
  ) {
    kmlText = kmlText.replace(
      /<kml\b/,
      '<kml xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"',
    );
  }

  const parser = new DOMParser();
  const kmlDoc = parser.parseFromString(kmlText, "application/xml");
  const parseError =
    kmlDoc.getElementsByTagName("parsererror").length ||
    kmlDoc.querySelector("parsererror");

  if (parseError) {
    const errorMessage =
      parseError.textContent?.trim() || "KML XML parsing error.";
    throw new Error(`KML parse failed: ${errorMessage}`);
  }

  const geojson = toGeoJSON.kml(kmlDoc);

  if (!geojson?.features?.length) {
    throw new Error("No valid features found in the KML file.");
  }

  return geojson;
}

async function parseUploadToGeoJSON(file) {
  const fileName = file.name.toLowerCase();

  if (fileName.endsWith(".geojson") || fileName.endsWith(".json")) {
    const text = await file.text();
    const geojson = JSON.parse(text);

    if (!geojson?.features?.length) {
      throw new Error("No valid features found in the GeoJSON file.");
    }

    return geojson;
  }

  if (fileName.endsWith(".kml")) {
    const kmlText = await file.text();
    return parseKmlTextToGeoJSON(kmlText);
  }

  if (fileName.endsWith(".kmz")) {
    return parseKmzToGeoJSON(file);
  }

  throw new Error("Please upload a .kmz, .kml, .geojson, or .json file.");
}

function ensureKmzLayerSetup() {
  if (map.getSource(KMZ_SOURCE_ID)) return;

  map.addSource(KMZ_SOURCE_ID, {
    type: "geojson",
    data: {
      type: "FeatureCollection",
      features: [],
    },
  });

  map.addLayer({
    id: KMZ_FILL_LAYER_ID,
    type: "fill",
    source: KMZ_SOURCE_ID,
    filter: ["==", ["geometry-type"], "Polygon"],
    paint: {
      "fill-color": ["coalesce", ["get", "fill"], "#3282ff"],
      "fill-opacity": ["coalesce", ["get", "fill-opacity"], 0.25],
    },
  });

  map.addLayer({
    id: KMZ_LINE_LAYER_ID,
    type: "line",
    source: KMZ_SOURCE_ID,
    filter: ["in", ["geometry-type"], ["literal", ["LineString", "Polygon"]]],
    paint: {
      "line-color": ["coalesce", ["get", "stroke"], "#ffffff"],
      "line-width": ["coalesce", ["get", "stroke-width"], 2],
      "line-opacity": ["coalesce", ["get", "stroke-opacity"], 1],
    },
  });

  map.addLayer({
    id: KMZ_POINT_LAYER_ID,
    type: "circle",
    source: KMZ_SOURCE_ID,
    filter: ["==", ["geometry-type"], "Point"],
    paint: {
      "circle-radius": 6,
      "circle-color": [
        "coalesce",
        ["get", "stroke"],
        ["get", "fill"],
        "#ff3d00",
      ],
      "circle-opacity": ["coalesce", ["get", "fill-opacity"], 1],
      "circle-stroke-color": "#ffffff",
      "circle-stroke-width": 1.5,
    },
  });
}

function updateKmzData(geojson, options = {}) {
  const { fit = true, statusMessage = null } = options;

  ensureKmzLayerSetup();

  const source = map.getSource(KMZ_SOURCE_ID);
  if (!source || typeof source.setData !== "function") return;

  uploadedKmzData = {
    type: "FeatureCollection",
    features: [...(geojson?.features || [])],
  };

  source.setData(uploadedKmzData);

  if (fit && uploadedKmzData.features.length) {
    const bounds = bbox(uploadedKmzData);
    map.fitBounds(
      [
        [bounds[0], bounds[1]],
        [bounds[2], bounds[3]],
      ],
      {
        padding: 70,
        maxZoom: 14,
        animate: true,
      },
    );
  }

  if (statusMessage) {
    setKmzStatus(statusMessage);
  }
}

function appendKmzData(newGeojson, fileName = "KMZ") {
  const existingFeatures = uploadedKmzData?.features || [];
  const newFeatures = (newGeojson?.features || []).map((feature) => ({
    ...feature,
    properties: {
      ...(feature.properties || {}),
      _kmzFile: fileName,
    },
  }));

  const combined = {
    type: "FeatureCollection",
    features: [...existingFeatures, ...newFeatures],
  };

  updateKmzData(combined, {
    fit: true,
    statusMessage: `Loaded ${newFeatures.length} feature(s) from ${fileName}. Total stored: ${combined.features.length}.`,
  });

  return combined;
}

async function handleKmzUpload(event) {
  const file = event.target?.files?.[0];
  if (!file) return;

  setKmzStatus(`Loading ${file.name}...`);

  try {
    const geojson = await parseUploadToGeoJSON(file);
    const combined = appendKmzData(geojson, file.name);
    await saveKmzToCache(combined);

    event.target.value = "";
  } catch (error) {
    console.error(error);
    setKmzStatus(error?.message || "Unable to parse uploaded file.", true);
    event.target.value = "";
  }
}

function attachKmzUploadListener() {
  const fileInput = document.getElementById("kmz-upload");
  if (fileInput && !fileInput.dataset.bound) {
    fileInput.addEventListener("change", handleKmzUpload);
    fileInput.dataset.bound = "true";
  }

  const clearBtn = document.getElementById("kmz-clear");
  if (clearBtn && !clearBtn.dataset.bound) {
    clearBtn.addEventListener("click", async () => {
      try {
        await removeKmzData();
      } catch (err) {
        console.error(err);
        setKmzStatus("Failed to clear uploaded KMZ.", true);
      }
    });
    clearBtn.dataset.bound = "true";
  }
}

function ensureMeasureLayers() {
  if (map.getSource(MEASURE_SOURCE_ID)) return;

  map.addSource(MEASURE_SOURCE_ID, {
    type: "geojson",
    data: {
      type: "FeatureCollection",
      features: [],
    },
  });

  map.addLayer({
    id: MEASURE_FILL_ID,
    type: "fill",
    source: MEASURE_SOURCE_ID,
    filter: ["==", "$type", "Polygon"],
    paint: {
      "fill-color": "#1D90E4",
      "fill-opacity": 0.15,
    },
  });

  map.addLayer({
    id: MEASURE_LINE_ID,
    type: "line",
    source: MEASURE_SOURCE_ID,
    filter: ["==", "$type", "LineString"],
    paint: {
      "line-color": "#FFFFFF",
      "line-width": 3,
    },
  });

  map.addLayer({
    id: MEASURE_POINTS_ID,
    type: "circle",
    source: MEASURE_SOURCE_ID,
    filter: ["==", "$type", "Point"],
    paint: {
      "circle-radius": 5,
      "circle-color": "#1D90E4",
      "circle-stroke-color": "#ffffff",
      "circle-stroke-width": 1.5,
    },
  });
}

function updateMeasureSource() {
  const source = map.getSource(MEASURE_SOURCE_ID);
  if (!source) return;

  const features = measureCoords.map((coord) => ({
    type: "Feature",
    geometry: {
      type: "Point",
      coordinates: coord,
    },
    properties: {},
  }));

  if (measureMode === "distance" && measureCoords.length >= 2) {
    features.push(
      lineString(measureCoords, {
        measureType: "distance",
      }),
    );
  }

  if (measureMode === "area" && measureCoords.length >= 3) {
    const closedRing = [...measureCoords, measureCoords[0]];
    features.push(
      polygon([closedRing], {
        measureType: "area",
      }),
    );
  }

  source.setData({
    type: "FeatureCollection",
    features,
  });
}

function openKmzDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(KMZ_DB_NAME, 2); // v2 adds collected-points store

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(KMZ_STORE_NAME)) {
        db.createObjectStore(KMZ_STORE_NAME);
      }
      if (!db.objectStoreNames.contains(COLLECT_STORE_NAME)) {
        db.createObjectStore(COLLECT_STORE_NAME);
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function saveKmzToCache(geojson) {
  const db = await openKmzDb();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(KMZ_STORE_NAME, "readwrite");
    const store = tx.objectStore(KMZ_STORE_NAME);

    store.put(
      {
        savedAt: new Date().toISOString(),
        geojson,
      },
      KMZ_RECORD_KEY,
    );

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function loadKmzFromCache() {
  const db = await openKmzDb();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(KMZ_STORE_NAME, "readonly");
    const store = tx.objectStore(KMZ_STORE_NAME);
    const request = store.get(KMZ_RECORD_KEY);

    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

async function clearKmzCache() {
  const db = await openKmzDb();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(KMZ_STORE_NAME, "readwrite");
    const store = tx.objectStore(KMZ_STORE_NAME);
    store.delete(KMZ_RECORD_KEY);

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function saveCollectCache(features) {
  const db = await openKmzDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(COLLECT_STORE_NAME, "readwrite");
    tx.objectStore(COLLECT_STORE_NAME).put(features, COLLECT_RECORD_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function loadCollectCache() {
  const db = await openKmzDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(COLLECT_STORE_NAME, "readonly");
    const req = tx.objectStore(COLLECT_STORE_NAME).get(COLLECT_RECORD_KEY);
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function clearCollectCache() {
  const db = await openKmzDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(COLLECT_STORE_NAME, "readwrite");
    tx.objectStore(COLLECT_STORE_NAME).delete(COLLECT_RECORD_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// Functions for calculation distance and area in the browser
function formatDistanceMiles(miles) {
  if (miles < 0.1) {
    return `${(miles * 5280).toFixed(0)} ft`;
  }
  return `${miles.toFixed(2)} mi`;
}

function formatAreaSqFtOrAcres(squareMeters) {
  const squareFeet = squareMeters * 10.7639;
  const acres = squareFeet / 43560;

  if (acres < 0.25) {
    return `${squareFeet.toFixed(0)} sq ft`;
  }
  return `${acres.toFixed(2)} acres`;
}

function updateMeasurePopup() {
  if (measurePopup) {
    measurePopup.remove();
    measurePopup = null;
  }

  if (measureMode === "distance" && measureCoords.length >= 2) {
    const line = lineString(measureCoords);
    const miles = length(line, { units: "miles" });
    const lastCoord = measureCoords[measureCoords.length - 1];

    measurePopup = new maplibregl.Popup({
      closeButton: false,
      closeOnClick: false,
      offset: 12,
    })
      .setLngLat(lastCoord)
      .setHTML(`<strong>Distance:</strong> ${formatDistanceMiles(miles)}`)
      .addTo(map);
  }

  if (measureMode === "area" && measureCoords.length >= 3) {
    const poly = polygon([[...measureCoords, measureCoords[0]]]);
    const sqm = area(poly);
    const lastCoord = measureCoords[measureCoords.length - 1];

    measurePopup = new maplibregl.Popup({
      closeButton: false,
      closeOnClick: false,
      offset: 12,
    })
      .setLngLat(lastCoord)
      .setHTML(`<strong>Area:</strong> ${formatAreaSqFtOrAcres(sqm)}`)
      .addTo(map);
  }
}

function clearMeasurement() {
  measureCoords = [];
  updateMeasureSource();

  if (measurePopup) {
    measurePopup.remove();
    measurePopup = null;
  }
}

// map protocols
const protocol = new Protocol();
maplibregl.addProtocol("pmtiles", protocol.tile);

const map = new maplibregl.Map({
  container: "map",
  center: [-85, 36],
  zoom: 5,
  maxPitch: 85,
  style: "./style.json",
});

map.once("idle", () => {
  loadingScreen.classList.add("hidden");
});

const layerGroups = [
  {
    label: "PEC Locations",
    layers: ["pec-symbol"],
  },
  {
    label: "Noise Data",
    layers: ["Noise", "Noise polygons"],
  },
  {
    label: "Contours",
    layers: ["Contour", "Contour index", "Contour labels (ft)"],
  },
  {
    label: "Roads",
    layers: [
      "Road-minor",
      "Road-major-casing",
      "Road-major",
      "Road-bridge",
      "Road-labels",
    ],
  },
  {
    label: "Water",
    layers: ["Water-fill", "Waterway", "River-labels", "Lakeline-labels"],
  },
  {
    label: "Farmland",
    layers: ["Farmland Fill", "Farmland Outline"],
  },
  {
    label: "Industrial Sites",
    layers: ["Industrial sites"],
  },
  {
    label: "Parks",
    layers: ["KY Parks Fill", "KY Parks Outline", "KY Parks Labels"],
  },
  {
    label: "State Forests",
    layers: ["state-forests-fill", "state-forests-outline"],
  },
  {
    label: "Cemeteries",
    layers: ["Cemetery Fill", "Cemetery Outline", "Cemetery Label"],
  },
  {
    label: "Wetlands",
    layers: ["wetlands-fill", "wetlands-outline", "wetlands-outline-soft"],
  },
  {
    label: "Sinkholes",
    layers: ["sinkhole-fill", "sinkhole-outline"],
  },
  {
    label: "Critical Habitat",
    layers: ["critical-habitat-fill", "critical-habitat-outline"],
  },
  {
    label: "Schools",
    layers: ["schools"],
  },
  {
    label: "Libraries",
    layers: ["libraries-symbol"],
  },
  {
    label: "Airports",
    layers: ["airports-symbol"],
  },
  {
    label: "Churches",
    layers: ["churches"],
  },
  {
    label: "Water Utilities",
    layers: [
      "Water Lines casing",
      "Water Lines",
      "Sewer Lines casing",
      "Sewer Lines",
    ],
  },
  {
    label: "Springs / Wells / Pump Stations",
    layers: ["spring-source", "spring", "water-well", "pump-station"],
  },
  {
    label: "FRS Interests",
    layers: ["frs-interests"],
  },
  {
    label: "Simplified Geology",
    layers: ["geology"],
  },
  {
    label: "Heritage Land Conservation Fund",
    layers: [
      "Heritage Land Conservation Fund",
      "Heritage Land Conservation Fund outline",
    ],
  },
  {
    label: "National Registry Districts",
    layers: ["National Registry Districts", "NR Districts Outline"],
  },
  {
    label: "NLEB Sensitive Areas",
    layers: ["nleb-shadow", "nleb-outline", "nleb"],
  },
  {
    label: "Indiana Bat Sensitive Areas",
    layers: ["indianabat-shadow", "indianabat-outline", "indianaBat"],
  },
];

function initSidebarToggle() {
  const sidebar = document.getElementById("sidebar");
  const toggle = document.getElementById("sidebar-toggle");
  const overlay = document.getElementById("sidebar-overlay");

  const isMobile = () => window.matchMedia("(max-width: 768px)").matches;

  // Open sidebar by default on desktop; HTML starts with .closed
  if (!isMobile()) {
    sidebar.classList.remove("closed");
  }

  toggle?.addEventListener("click", () => {
    sidebar.classList.toggle("closed");
    const isNowOpen = !sidebar.classList.contains("closed");
    if (isMobile() && overlay) {
      overlay.classList.toggle("active", isNowOpen);
    }
  });

  overlay?.addEventListener("click", () => {
    sidebar.classList.add("closed");
    overlay.classList.remove("active");
  });

  // Resize the map canvas after the sidebar slide animation completes
  sidebar?.addEventListener("transitionend", () => {
    map.resize();
  });

  // Close sidebar overlay and re-sync when crossing the breakpoint
  let wasMobile = isMobile();
  window.addEventListener("resize", () => {
    const nowMobile = isMobile();
    if (wasMobile !== nowMobile) {
      sidebar.classList.add("closed");
      overlay?.classList.remove("active");
      if (!nowMobile) sidebar.classList.remove("closed");
      wasMobile = nowMobile;
    }
    map.resize();
  });
}

function initSidebarLayers(layerGroups) {
  const listEl = document.getElementById("sidebar-layer-list");
  if (!listEl) return;

  const firstExisting = (ids) => ids.find((id) => map.getLayer(id));
  const isVisible = (ids) => {
    const first = firstExisting(ids);
    return first ? map.getLayoutProperty(first, "visibility") !== "none" : false;
  };
  const setVisible = (ids, visible) => {
    ids.forEach((id) => {
      if (map.getLayer(id)) {
        map.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
      }
    });
  };

  layerGroups.forEach((group) => {
    const row = document.createElement("label");
    row.className = "layer-row";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = isVisible(group.layers);
    checkbox.addEventListener("change", () => setVisible(group.layers, checkbox.checked));

    const text = document.createElement("span");
    text.className = "layer-row-label";
    text.textContent = group.label;

    row.appendChild(checkbox);
    row.appendChild(text);
    listEl.appendChild(row);

    group.checkbox = checkbox;
  });

  const syncCheckboxes = () => {
    layerGroups.forEach((group) => {
      if (group.checkbox) group.checkbox.checked = isVisible(group.layers);
    });
  };

  map.on("styledata", syncCheckboxes);
}

function initSidebarMeasure() {
  const distBtn = document.getElementById("measure-distance");
  const areaBtn = document.getElementById("measure-area");
  const clearBtn = document.getElementById("measure-clear");
  const hint = document.getElementById("measure-hint");

  const updateState = () => {
    distBtn?.classList.toggle("active", measureMode === "distance");
    areaBtn?.classList.toggle("active", measureMode === "area");
    if (hint) {
      if (measureMode === "distance") {
        hint.textContent = "Click the map to add points. Click Clear to reset.";
      } else if (measureMode === "area") {
        hint.textContent = "Click the map to add vertices. Click Clear to reset.";
      } else {
        hint.textContent = "Select a tool, then click the map.";
      }
    }
  };

  distBtn?.addEventListener("click", () => {
    measureMode = "distance";
    clearMeasurement();
    updateState();
  });

  areaBtn?.addEventListener("click", () => {
    measureMode = "area";
    clearMeasurement();
    updateState();
  });

  clearBtn?.addEventListener("click", () => {
    measureMode = null;
    clearMeasurement();
    updateState();
  });
}

// popup functionality for each layer
// Escape HTML so popup text does not break when values contain special chars
function escapeHTML(value) {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Convert geometry type to something readable
function getGeometryLabel(feature) {
  if (!feature.geometry || !feature.geometry.type) return "Unknown";
  return feature.geometry.type;
}

// Build attribute rows for a feature
function buildAttributesTable(properties) {
  const entries = Object.entries(properties || {});

  if (!entries.length) {
    return `<div class="popup-empty">No attributes found.</div>`;
  }

  return `
    <div class="popup-attrs">
      ${entries
        .map(
          ([key, value]) => `
            <div class="popup-attr-row">
              <div class="popup-attr-key">${escapeHTML(key)}</div>
              <div class="popup-attr-value">${escapeHTML(value)}</div>
            </div>
          `,
        )
        .join("")}
    </div>
  `;
}

// Build popup HTML for all clicked features
function buildPopup(features) {
  if (!features.length) {
    return `<div class="popup-wrap"><div class="popup-empty">No features found here.</div></div>`;
  }

  const grouped = {};

  for (const feature of features) {
    const layerId = feature.layer?.id || "Unknown Layer";
    const layerLabel = popupLayerLookup[layerId] || layerId;

    if (!grouped[layerId]) {
      grouped[layerId] = {
        label: layerLabel,
        features: [],
      };
    }

    grouped[layerId].features.push(feature);
  }

  const summaryCount = features.length;
  const layerCount = Object.keys(grouped).length;

  const sections = Object.entries(grouped)
    .map(([layerId, group]) => {
      const layerLabel = group.label;
      const layerFeatures = group.features;
      const featureCards = layerFeatures
        .map((feature, index) => {
          const featureTitle = `Feature ${index + 1}`;
          const geomType = getGeometryLabel(feature);

          return `
            <details class="popup-feature" ${index === 0 ? "open" : ""}>
              <summary class="popup-feature-summary">
                <span class="popup-feature-title">${escapeHTML(featureTitle)}</span>
                <span class="popup-feature-geom">${escapeHTML(geomType)}</span>
              </summary>
              <div class="popup-feature-body">
                ${buildAttributesTable(feature.properties)}
              </div>
            </details>
          `;
        })
        .join("");

      return `
        <section class="popup-layer-section">
          <div class="popup-layer-header">
            <div class="popup-layer-name">${escapeHTML(layerLabel)}</div>
            <div class="popup-layer-count">${layerFeatures.length} clicked</div>
          </div>
          <div class="popup-layer-body">
            ${featureCards}
          </div>
        </section>
      `;
    })
    .join("");

  return `
    <div class="popup-wrap">
      <div class="popup-top">
        <div class="popup-title">Clicked Features</div>
        <div class="popup-subtitle">${summaryCount} feature(s) across ${layerCount} layer(s)</div>
      </div>
      ${sections}
    </div>
  `;
} // END buildPopup

// ── Collection feature ────────────────────────────────────────────────────────

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function createPinElement(pending = false) {
  const el = document.createElement("div");
  el.className = "collect-pin" + (pending ? " pending" : "");
  const headFill = pending ? "#7abbe0" : "#1B6CA8";
  const needleFill = pending ? "#5590c0" : "#14507F";
  el.innerHTML = `
    <svg viewBox="0 0 24 40" width="24" height="40" xmlns="http://www.w3.org/2000/svg">
      <circle cx="12" cy="11" r="10" fill="${headFill}" stroke="rgba(255,255,255,0.7)" stroke-width="1.5"/>
      <path d="M11.2 21 L10.5 36 L12 40 L13.5 36 L12.8 21 Z" fill="${needleFill}"/>
      <ellipse cx="9" cy="8" rx="3.2" ry="2" fill="rgba(255,255,255,0.32)" transform="rotate(-25 9 8)"/>
    </svg>`;
  return el;
}

function updateCollectSidebar() {
  const count = collectedFeatures.length;
  const label = document.getElementById("collect-count-label");
  const exportBtn = document.getElementById("collect-export");
  const clearAllBtn = document.getElementById("collect-clear-all");
  if (label) label.textContent = count === 0 ? "No points collected." : `${count} point${count === 1 ? "" : "s"} collected.`;
  if (exportBtn) exportBtn.disabled = count === 0;
  if (clearAllBtn) clearAllBtn.disabled = count === 0;
}

function openCollectSheet(lngLat, existingFeature = null) {
  editingFeatureId = existingFeature?.properties?.id ?? null;

  document.getElementById("cf-name").value = existingFeature?.properties?.name ?? "";
  document.getElementById("cf-site").value = existingFeature?.properties?.fieldSite ?? "";
  document.getElementById("cf-khc").value = existingFeature?.properties?.khc ?? "";
  document.getElementById("cf-address").value = existingFeature?.properties?.address ?? "";
  document.getElementById("cf-desc").value = existingFeature?.properties?.description ?? "";

  const deleteBtn = document.getElementById("collect-delete");
  deleteBtn?.classList.toggle("hidden", !existingFeature);

  const sheet = document.getElementById("collect-sheet");
  sheet.dataset.lat = lngLat.lat;
  sheet.dataset.lng = lngLat.lng;

  document.getElementById("collect-coords").textContent =
    `${lngLat.lat.toFixed(6)}, ${lngLat.lng.toFixed(6)}`;

  sheet.classList.remove("closed");
  setTimeout(() => document.getElementById("cf-name")?.focus(), 320);
}

function closeCollectSheet() {
  document.getElementById("collect-sheet").classList.add("closed");
  editingFeatureId = null;
  if (pendingMarker) {
    pendingMarker.remove();
    pendingMarker = null;
  }
}

function addSavedMarker(feature) {
  const id = feature.properties.id;
  const [lng, lat] = feature.geometry.coordinates;
  const el = createPinElement(false);

  el.addEventListener("click", (e) => {
    e.stopPropagation();
    suppressMapClick = true;
    setTimeout(() => { suppressMapClick = false; }, 80);
    if (measureMode) return;
    openCollectSheet(
      { lat, lng },
      collectedFeatures.find((f) => f.properties.id === id),
    );
  });

  const marker = new maplibregl.Marker({ element: el, anchor: "bottom" })
    .setLngLat([lng, lat])
    .addTo(map);

  savedMarkers.set(id, marker);
}

function handleCollectSave(e) {
  e.preventDefault();
  const sheet = document.getElementById("collect-sheet");
  const lat = parseFloat(sheet.dataset.lat);
  const lng = parseFloat(sheet.dataset.lng);

  const props = {
    name:        document.getElementById("cf-name").value.trim(),
    fieldSite:   document.getElementById("cf-site").value.trim(),
    khc:         document.getElementById("cf-khc").value.trim(),
    address:     document.getElementById("cf-address").value.trim(),
    description: document.getElementById("cf-desc").value.trim(),
  };

  if (editingFeatureId) {
    const idx = collectedFeatures.findIndex((f) => f.properties.id === editingFeatureId);
    if (idx !== -1) {
      collectedFeatures[idx].properties = { ...collectedFeatures[idx].properties, ...props };
    }
  } else {
    const id = generateId();
    const feature = {
      type: "Feature",
      geometry: { type: "Point", coordinates: [lng, lat] },
      properties: { id, collectedAt: new Date().toISOString(), ...props },
    };
    collectedFeatures.push(feature);

    // Promote the pending marker to a saved marker
    if (pendingMarker) {
      const el = pendingMarker.getElement();
      el.innerHTML = createPinElement(false).innerHTML;
      el.classList.remove("pending");
      el.addEventListener("click", (ev) => {
        ev.stopPropagation();
        suppressMapClick = true;
        setTimeout(() => { suppressMapClick = false; }, 80);
        if (measureMode) return;
        openCollectSheet({ lat, lng }, collectedFeatures.find((f) => f.properties.id === id));
      });
      savedMarkers.set(id, pendingMarker);
      pendingMarker = null; // don't remove it in closeCollectSheet
    } else {
      addSavedMarker(feature);
    }
  }

  saveCollectCache(collectedFeatures).catch(console.error);
  updateCollectSidebar();

  // Close sheet without removing the (now saved) marker
  document.getElementById("collect-sheet").classList.add("closed");
  editingFeatureId = null;
  pendingMarker = null;
}

function handleCollectDelete() {
  if (!editingFeatureId) return;
  const id = editingFeatureId;
  collectedFeatures = collectedFeatures.filter((f) => f.properties.id !== id);

  const marker = savedMarkers.get(id);
  if (marker) { marker.remove(); savedMarkers.delete(id); }

  saveCollectCache(collectedFeatures).catch(console.error);
  updateCollectSidebar();
  closeCollectSheet();
}

function exportCollectGeoJSON() {
  const fc = { type: "FeatureCollection", features: collectedFeatures };
  const blob = new Blob([JSON.stringify(fc, null, 2)], { type: "application/geo+json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `pec-collection-${new Date().toISOString().slice(0, 10)}.geojson`;
  a.click();
  URL.revokeObjectURL(url);
}

function initCollect() {
  // Restore persisted points
  loadCollectCache().then((features) => {
    collectedFeatures = features;
    collectedFeatures.forEach(addSavedMarker);
    updateCollectSidebar();
  }).catch(console.error);

  // Sidebar toggle button
  const toggleBtn = document.getElementById("collect-toggle");
  toggleBtn?.addEventListener("click", () => {
    collectMode = !collectMode;
    toggleBtn.classList.toggle("active", collectMode);
    toggleBtn.textContent = collectMode ? "⏹ Stop Collecting" : "📍 Start Collecting";
    map.getCanvas().style.cursor = collectMode ? "crosshair" : "";
    if (!collectMode && pendingMarker) {
      pendingMarker.remove();
      pendingMarker = null;
      document.getElementById("collect-sheet").classList.add("closed");
    }
  });

  // Export button
  document.getElementById("collect-export")?.addEventListener("click", exportCollectGeoJSON);

  // Clear all
  document.getElementById("collect-clear-all")?.addEventListener("click", () => {
    if (!confirm(`Clear all ${collectedFeatures.length} collected point(s)?`)) return;
    savedMarkers.forEach((m) => m.remove());
    savedMarkers.clear();
    collectedFeatures = [];
    clearCollectCache().catch(console.error);
    updateCollectSidebar();
    closeCollectSheet();
  });

  // Bottom sheet form
  document.getElementById("collect-form")?.addEventListener("submit", handleCollectSave);
  document.getElementById("collect-cancel")?.addEventListener("click", closeCollectSheet);
  document.getElementById("collect-delete")?.addEventListener("click", handleCollectDelete);
}

map.on("load", async () => {
  // Add sky style to the map, giving an atmospheric effect
  map.setSky({
    "sky-color": "#90C7E9FF",
    "sky-horizon-blend": 0.5,
    "horizon-color": "#FFFCEBFF",
    "horizon-fog-blend": 0.4,
    "fog-color": "#B5B5B5FF",
    "fog-ground-blend": 0.5,
    "atmosphere-blend": [
      "interpolate",
      ["linear"],
      ["zoom"],
      0,
      1,
      10,
      1,
      12,
      0,
    ],
  });

  try {
    const cached = await loadKmzFromCache();
    if (cached?.geojson?.features?.length) {
      updateKmzData(cached.geojson, {
        fit: false,
        statusMessage: `Reloaded cached KMZ data (${cached.geojson.features.length} features).`,
      });
    }
  } catch (err) {
    console.error("Failed to reload cached KMZ:", err);
  }

  attachKmzUploadListener();
  ensureMeasureLayers();
  initSidebarLayers(layerGroups);
  initCollect();

  // did sprites load?
  // console.log("all images:", map.listImages());
}); // End map.on("load");

async function removeKmzData() {
  ensureKmzLayerSetup();

  uploadedKmzData = {
    type: "FeatureCollection",
    features: [],
  };

  const source = map.getSource(KMZ_SOURCE_ID);
  if (source && typeof source.setData === "function") {
    source.setData(uploadedKmzData);
  }

  const fileInput = document.getElementById("kmz-upload");
  if (fileInput) {
    fileInput.value = "";
  }

  await clearKmzCache();
  setKmzStatus("All uploaded KMZ data cleared.");
}

// list of layers that get a popup
// modify these from the style.json
const popupLayerConfig = [
  { id: "pec-symbol", label: "PEC Site" },
  { id: "schools", label: "School" },
  { id: "libraries-symbol", label: "Library" },
  { id: "airports-symbol", label: "Airport" },
  { id: "churches", label: "Church" },
  { id: "water-well", label: "Water Source" },
  { id: "nleb", label: "Northern Long-Eared Bat Sensitive Area" },
  { id: "indianaBat", label: "Indiana Bat Sensitive Area" },
  { id: "frs-interests", label: "Active EPA Facility Registry Service Sites" },
  { id: "spring-source", label: "Surface and Spring Water Sources" },
  { id: "pump-station", label: "Pump Stations" },
  { id: "USGS Quad Index Grid", label: "USGS Quad Index Grid" },
  { id: "spring", label: "Spring Water" },
  { id: "wetlands-fill", label: "NWI Wetlands" },
  { id: "sinkhole-fill", label: "Sinkholes" },
  { id: "critical-habitat-fill", label: "USFWS Critical Habitat" },
  { id: "Water Lines", label: "Water Lines" },
  { id: "Sewer Lines", label: "Sewer Lines" },
  { id: "state-forests-fill", label: "KY State Forests" },
  { id: "Farmland Fill", label: "Farmland Classification" },
  { id: "National Registry Districts", label: "National Registry Districts" },
  {
    id: "Heritage Land Conservation Fund",
    label: "Heritage Land Conservation Fund",
  },
  {
    id: "geology",
    label: "Simplified Geology",
  },
];

const popupLayerIds = popupLayerConfig.map((layer) => layer.id);

const popupLayerLookup = Object.fromEntries(
  popupLayerConfig.map((layer) => [layer.id, layer.label]),
);

map.on("click", (e) => {
  if (suppressMapClick) return;

  if (collectMode) {
    if (pendingMarker) { pendingMarker.remove(); }
    const el = createPinElement(true);
    pendingMarker = new maplibregl.Marker({ element: el, anchor: "bottom" })
      .setLngLat(e.lngLat)
      .addTo(map);
    openCollectSheet(e.lngLat);
    return;
  }

  if (measureMode) {
    measureCoords.push([e.lngLat.lng, e.lngLat.lat]);
    updateMeasureSource();
    updateMeasurePopup();
    return;
  }

  const features = map.queryRenderedFeatures(e.point, {
    layers: popupLayerIds,
  });

  const seen = new Set();
  const uniqueFeatures = features.filter((feature) => {
    const layerId = feature.layer?.id || "unknown";
    const featureId =
      feature.id ??
      feature.properties?.OBJECTID ??
      feature.properties?.FID ??
      JSON.stringify(feature.properties);

    const key = `${layerId}__${featureId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  if (!uniqueFeatures.length) return;

  const popup = buildPopup(uniqueFeatures);

  new maplibregl.Popup({
    closeButton: true,
    // closeOnClick: true,
    maxWidth: "420px",
  })
    .setLngLat(e.lngLat)
    .setHTML(popup)
    .addTo(map);
});

// cursor for interactivity on desktop
map.on("mousemove", (e) => {
  if (collectMode || measureMode) {
    map.getCanvas().style.cursor = "crosshair";
    return;
  }

  const features = map.queryRenderedFeatures(e.point, {
    layers: popupLayerIds,
  });

  map.getCanvas().style.cursor = features.length ? "pointer" : "";
});

// Add basic map controls
map.addControl(
  new maplibregl.NavigationControl({
    showCompass: true,
    showZoom: true,
    visualizePitch: true,
  }),
  "top-right",
);
map.addControl(
  new maplibregl.ScaleControl({
    maxWidth: 80,
    unit: "imperial",
  }),
);

// Add terrain control for 3D effect
map.addControl(
  new maplibregl.TerrainControl({
    source: "terrainSource",
    exaggeration: 2,
  }),
);

map.addControl(
  new maplibregl.GeolocateControl({
    positionOptions: {
      enableHighAccuracy: true,
    },
    trackUserLocation: true,
    showUserHeading: true,
    showAccuracyCircle: true,
    fitBoundsOptions: {
      maxZoom: 14,
    },
  }),
  "top-right",
);

initSidebarToggle();
initSidebarMeasure();

// What zoom are we at?
map.on("zoomend", () => {
  console.log("Zoom: ", map.getZoom().toFixed(2));
});
