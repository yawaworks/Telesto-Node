const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:5050";

/** Same defensive-recreate pattern as species-markers.js's ensureRiskLayer
 * — MapLibre can drop a runtime-added source/layer on a style reload,
 * silently leaving setData() calls with nothing to write into. */
function ensureVesselLayer(map) {
  if (!map.getSource("vessel-activity")) {
    map.addSource("vessel-activity", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
  }
  if (!map.getLayer("vessel-activity-points")) {
    map.addLayer({
      id: "vessel-activity-points",
      type: "circle",
      source: "vessel-activity",
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 2, 2, 6, 4, 10, 6, 14, 9],
        "circle-color": "#d8a877",
        "circle-blur": 0.3,
        "circle-opacity": 0.55,
      },
    });
  }
}

/**
 * Loads apparent fishing effort (Global Fishing Watch, see
 * backend/app/vessel_tracking.py) into the map for the given bounding
 * box and date range. Distinct color/style from species sightings
 * ("risk-points") — this is vessel activity, not animal presence, and
 * conflating the two visually would misrepresent what's being shown.
 *
 * Degrades explicitly on a 503 ("not configured" — GFW_API_KEY unset)
 * vs. any other failure, so the UI can tell a researcher "this feature
 * isn't set up" instead of a generic error that looks like a bug.
 */
export async function loadVesselActivity(map, bounds, dateRange) {
  if (!map || !bounds) return { status: "idle", count: 0 };

  const params = new URLSearchParams({
    min_lat: String(bounds.minLat),
    min_lng: String(bounds.minLng),
    max_lat: String(bounds.maxLat),
    max_lng: String(bounds.maxLng),
    start_date: dateRange.start,
    end_date: dateRange.end,
  });

  try {
    const response = await fetch(`${API_BASE_URL}/vessel-activity?${params}`);

    if (response.status === 503) {
      return { status: "not_configured", count: 0 };
    }
    if (!response.ok) {
      console.warn(`Vessel activity request failed (status ${response.status})`);
      return { status: "error", count: 0 };
    }

    const data = await response.json();
    const geojson = {
      type: "FeatureCollection",
      features: (data.cells || []).map((c) => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [c.longitude, c.latitude] },
        properties: { hours: c.hours },
      })),
    };

    ensureVesselLayer(map);
    map.getSource("vessel-activity").setData(geojson);

    return { status: geojson.features.length > 0 ? "success" : "empty", count: geojson.features.length };
  } catch (err) {
    console.error("Failed to load vessel activity:", err);
    return { status: "error", count: 0 };
  }
}

export function clearVesselActivity(map) {
  if (!map) return;
  const source = map.getSource("vessel-activity");
  if (source) {
    source.setData({ type: "FeatureCollection", features: [] });
  }
}