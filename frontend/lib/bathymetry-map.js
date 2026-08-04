/**
 * Initializes the 3D ocean bathymetry map using MapLibre GL JS with
 * OpenFreeMap's free vector tiles + a free terrain-DEM source — no API key
 * or payment method required.
 *
 * Uses the CDN-loaded window.maplibregl global (see app/layout.js) rather
 * than the npm package, since bundling it through Next.js's dev webpack
 * caused its internal tile-parsing worker to silently fail.
 */
export function initBathymetryMap(container) {
  if (!container) return null;
  if (typeof window === "undefined" || !window.maplibregl) {
    console.error("maplibregl global not found — check that the CDN script in layout.js loaded.");
    return null;
  }

  const maplibregl = window.maplibregl;

  const map = new maplibregl.Map({
    container,
    style: "https://tiles.openfreemap.org/styles/liberty",
    center: [145.7781, -16.9203], // Cairns, Australia — coastline + Great Barrier Reef in view
    // Lower starting zoom/pitch than before (was 9.5/70) — a steep 3D tilt
    // at high zoom requests a large burst of tiles simultaneously on load,
    // which can trip rate-limiting on OpenFreeMap's free shared
    // infrastructure and surface as CORS-looking errors (really Cloudflare
    // 522s from the origin failing to respond in time). Starting gentler
    // and letting the user zoom/tilt in manually spreads the tile requests
    // out over time instead of firing them all at once.
    zoom: 8,
    pitch: 45,
    bearing: 45,
    antialias: true,
  });

  map.on("error", (e) => {
    // OpenFreeMap is a free, best-effort service — tile/font fetches can
    // fail under load or during outages. Log clearly instead of letting
    // it show up as unexplained CORS spam in the console.
    console.warn(
      "[bathymetry-map] tile/style load error (likely transient OpenFreeMap availability):",
      e?.error || e
    );
  });

  map.on("load", () => {
    // 3D terrain DEM source (free Terrarium tiles via AWS open data)
    map.addSource("terrain-dem", {
      type: "raster-dem",
      tiles: [
        "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png",
      ],
      tileSize: 256,
      encoding: "terrarium",
      maxzoom: 15,
    });
    map.setTerrain({ source: "terrain-dem", exaggeration: 2.5 });

    // Atmosphere / depth fog for a submarine-mission feel
    map.setFog({
      color: "rgb(6, 20, 30)",
      "high-color": "rgb(10, 40, 60)",
      "horizon-blend": 0.35,
      "space-color": "rgb(0, 5, 10)",
      "star-intensity": 0.2,
    });

    // Empty source to start; populate with OBIS/detection points at runtime
    if (!map.getSource("risk-points")) {
      map.addSource("risk-points", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
    }

    // Glowing risk marker layer (invasive species / bleaching alerts).
    //
    // FIX: previously fixed at circle-radius 8 with circle-blur 0.6 —
    // heavily blurred AND tiny, which made markers nearly invisible when
    // a species search zoomed out to a wide geographic range (e.g. a
    // species native across the whole Western Pacific), especially
    // against the light-colored OpenFreeMap basemap. A "200 sightings
    // found" result with genuinely no visible dots on screen was this,
    // not a data problem — the points were there, just too small/faint
    // to see.
    //
    // Now: radius scales with zoom (small when zoomed out over a huge
    // area so points don't smear together, larger when zoomed in on a
    // cluster), blur is reduced substantially so dots read as distinct
    // points rather than soft smudges, and a dark stroke is added so
    // markers stay visible regardless of what's directly underneath them
    // on the basemap (ocean, land, or a country label).
    map.addLayer({
      id: "risk-markers",
      type: "circle",
      source: "risk-points",
      paint: {
        "circle-radius": [
          "interpolate",
          ["linear"],
          ["zoom"],
          2, 3,   // very zoomed out (whole-ocean view): small but visible
          6, 6,
          10, 9,
          14, 12, // zoomed in on a cluster: larger, easy to click
        ],
        "circle-color": "#ff5470",
        "circle-blur": 0.15,
        "circle-opacity": 0.95,
        "circle-stroke-width": 1.5,
        "circle-stroke-color": "#1c2226",
        "circle-stroke-opacity": 0.9,
      },
    });
  });

  // Exposed for direct console debugging (window.__telestoMap). Lets you
  // inspect the actual live GeoJSON source data from devtools — e.g.
  // window.__telestoMap.getSource('risk-points')._data.features.length —
  // rather than inferring what happened purely from screenshots.
  if (typeof window !== "undefined") {
    window.__telestoMap = map;
  }

  return map;
}