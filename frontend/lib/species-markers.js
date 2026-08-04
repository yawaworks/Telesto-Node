const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:5050";

/** Same paint config as the initial layer setup in bathymetry-map.js —
 * duplicated here (not imported) so this file can defensively re-create
 * the source/layer if they're ever missing, without needing a reference
 * back to bathymetry-map.js's init function. */
function ensureRiskLayer(map) {
  if (!map.getSource("risk-points")) {
    console.warn(
      "[species-markers] 'risk-points' source was missing — re-creating it. " +
      "This means the map's style reloaded/reset at some point after initial " +
      "load, silently dropping the runtime-added source/layer (a known " +
      "MapLibre behavior) — previous searches likely rendered zero visible " +
      "markers as a result, with no error anywhere, because the old code " +
      "just silently skipped setData() when the source didn't exist."
    );
    map.addSource("risk-points", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
  }

  if (!map.getLayer("risk-markers")) {
    map.addLayer({
      id: "risk-markers",
      type: "circle",
      source: "risk-points",
      paint: {
        "circle-radius": [
          "interpolate",
          ["linear"],
          ["zoom"],
          2, 3,
          6, 6,
          10, 9,
          14, 12,
        ],
        "circle-color": "#ff5470",
        "circle-blur": 0.15,
        "circle-opacity": 0.95,
        "circle-stroke-width": 1.5,
        "circle-stroke-color": "#1c2226",
        "circle-stroke-opacity": 0.9,
      },
    });
  }
}

/**
 * Fetches species occurrence data (OBIS, cache-first via /species-data)
 * for a scientific name and loads it into the map's "risk-points"
 * GeoJSON source — creating that source/layer first if they're missing
 * (see ensureRiskLayer above) rather than silently doing nothing, which
 * is what let a fully successful 200-result search render zero visible
 * markers with no error anywhere in the console.
 *
 * Returns a small status object so the caller (the search UI in page.js)
 * can show real feedback — result count, "not found", or an error —
 * instead of the search silently succeeding or failing with nothing
 * visible to the researcher.
 */
export async function loadSpeciesMarkers(map, scientificName) {
  if (!map || !scientificName) return { status: "idle", count: 0 };

  try {
    const response = await fetch(
      `${API_BASE_URL}/species-data?scientific_name=${encodeURIComponent(scientificName)}`
    );

    if (response.status === 404) {
      // Backend returns 404 when there's genuinely nothing cached AND
      // nothing from a live OBIS lookup — a real "no sightings" result,
      // not a failure. Clear any stale pins from a previous search.
      clearMarkers(map);
      return { status: "empty", count: 0 };
    }

    if (!response.ok) {
      console.warn(`Species lookup failed for "${scientificName}" (status ${response.status})`);
      return { status: "error", count: 0 };
    }

    const geojson = await response.json();
    const features = geojson?.features || [];

    ensureRiskLayer(map);
    const source = map.getSource("risk-points");
    source.setData(geojson);
    console.debug(
      `[species-markers] "${scientificName}": pushed ${features.length} features into risk-points source`
    );

    attachPopupHandler(map);

    if (features.length > 0) {
      fitToFeatures(map, features);
      return { status: "success", count: features.length, cached: !!geojson.cached };
    }

    return { status: "empty", count: 0 };
  } catch (err) {
    console.error("Failed to load species markers:", err);
    return { status: "error", count: 0 };
  }
}

/** Clears all pins from the map — used when a search returns nothing, so
 * stale results from a previous species don't linger and look like
 * matches for the current search. */
export function clearMarkers(map) {
  if (!map) return;
  const source = map.getSource("risk-points");
  if (source) {
    source.setData({ type: "FeatureCollection", features: [] });
  }
}

/** Zooms/pans the camera to frame the main cluster of results, with
 * padding so pins near the edge aren't clipped by the side panels.
 *
 * Filters out statistical outliers before computing the bounding box —
 * a single mis-geocoded or far-flung record (e.g. an aquarium-trade
 * sighting on the other side of the planet from an otherwise tight
 * cluster) previously forced the camera to zoom out to frame the ENTIRE
 * WORLD just to include one stray point, making the actual cluster of
 * real sightings invisible at that zoom level — exactly the opposite of
 * what an "auto-fit" is supposed to do. Outlier points stay in the map's
 * data source and are still visible/clickable if you manually pan out to
 * them; they're just excluded from the camera-framing calculation. */
function fitToFeatures(map, features) {
  const coords = features
    .map((f) => f.geometry?.coordinates)
    .filter((c) => Array.isArray(c) && c.length === 2);

  if (coords.length === 0) return;

  if (coords.length === 1) {
    map.flyTo({ center: coords[0], zoom: 9, duration: 900 });
    return;
  }

  const clusterCoords = filterOutliers(coords);

  if (clusterCoords.length === 1) {
    map.flyTo({ center: clusterCoords[0], zoom: 9, duration: 900 });
    return;
  }

  let minLng = clusterCoords[0][0], maxLng = clusterCoords[0][0];
  let minLat = clusterCoords[0][1], maxLat = clusterCoords[0][1];
  for (const [lng, lat] of clusterCoords) {
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }

  map.fitBounds(
    [
      [minLng, minLat],
      [maxLng, maxLat],
    ],
    { padding: { top: 80, bottom: 80, left: 260, right: 220 }, maxZoom: 11, duration: 900 }
  );
}

/** Drops points sitting far outside the main cluster, using distance
 * from the median position (median rather than mean, so a handful of
 * outliers can't drag the reference point toward themselves). Keeps
 * everything within roughly a wider region around the cluster's
 * "center of mass" — generous enough to keep a naturally spread-out
 * species intact, tight enough that a genuinely distant stray record
 * (different ocean/continent) gets excluded from the camera fit. Always
 * keeps at least a handful of points so a legitimately dispersed dataset
 * doesn't collapse down to nothing. */
function filterOutliers(coords) {
  const lngs = coords.map((c) => c[0]).sort((a, b) => a - b);
  const lats = coords.map((c) => c[1]).sort((a, b) => a - b);
  const medianLng = lngs[Math.floor(lngs.length / 2)];
  const medianLat = lats[Math.floor(lats.length / 2)];

  // Longitude degrees compress toward the poles — weight by cos(latitude)
  // so distance comparisons are roughly proportional to real-world
  // kilometers rather than raw degree deltas.
  const latRad = (medianLat * Math.PI) / 180;
  const lngWeight = Math.max(0.15, Math.cos(latRad));

  const withDistance = coords.map((c) => {
    const dLng = (c[0] - medianLng) * lngWeight;
    const dLat = c[1] - medianLat;
    return { coord: c, dist: Math.sqrt(dLng * dLng + dLat * dLat) };
  });

  withDistance.sort((a, b) => a.dist - b.dist);

  // Keep the closest 90% of points, but never fewer than 3 (or all of
  // them, if there are fewer than 3 to begin with) — a small dataset
  // shouldn't get aggressively trimmed.
  const keepCount = Math.max(3, Math.ceil(withDistance.length * 0.9));
  const kept = withDistance.slice(0, Math.min(keepCount, withDistance.length));

  return kept.map((d) => d.coord);
}

let popupHandlerAttached = false;

function attachPopupHandler(map) {
  if (popupHandlerAttached) return; // only wire the click listener once
  popupHandlerAttached = true;

  map.on("click", "risk-markers", (e) => {
    const feature = e.features?.[0];
    if (!feature) return;

    const { scientificName, depth_meters, country, source } = feature.properties;
    const [lng, lat] = feature.geometry.coordinates;

    const html = `
      <div style="font-family: monospace; font-size: 12px; color: #111;">
        <strong>${scientificName || "Unknown species"}</strong><br/>
        Depth: ${depth_meters ?? "—"} m<br/>
        Location: ${country || "International Waters"}<br/>
        ${source ? `Source: ${source}<br/>` : ""}
        ${lat.toFixed(3)}, ${lng.toFixed(3)}
      </div>
    `;

    new window.maplibregl.Popup({ closeButton: true })
      .setLngLat([lng, lat])
      .setHTML(html)
      .addTo(map);
  });

  map.on("mouseenter", "risk-markers", () => {
    map.getCanvas().style.cursor = "pointer";
  });
  map.on("mouseleave", "risk-markers", () => {
    map.getCanvas().style.cursor = "";
  });
}