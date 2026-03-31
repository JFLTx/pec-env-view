import "maplibre-gl/dist/maplibre-gl.css";
import "./style.css";
import maplibregl from "maplibre-gl";
import { Protocol } from "pmtiles";

// KMZ handling
import JSZip from "jszip";
import * as toGeoJSON from "@tmcw/togeojson";

// Turf
import bbox from "@turf/bbox";
import booleanIntersects from "@turf/boolean-intersects";

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

  // did sprites load?
  console.log("all images:", map.listImages());
}); // End map.on("load");

// list of layers that get a popup
// modify these from the style.json
const popupLayerConfig = [
  { id: "pec-symbol", label: "PEC Site" },
  { id: "schools-symbol", label: "School" },
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
];

const popupLayerIds = popupLayerConfig.map((layer) => layer.id);

const popupLayerLookup = Object.fromEntries(
  popupLayerConfig.map((layer) => [layer.id, layer.label]),
);

map.on("click", (e) => {
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

// What zoom are we at?
map.on("zoomend", () => {
  console.log("Zoom: ", map.getZoom().toFixed(2));
});
