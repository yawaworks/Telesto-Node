const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:5050";

/**
 * Fetches species occurrence data (OBIS, cache-first via /species-data)
 * for a scientific name and loads it into the map's existing
 * "risk-points" GeoJSON source. Auto-fits the camera to frame every
 * matching sighting — previously a successful search could leave every
 * pin sitting off-screen with zero indication anything loaded.
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

    const source = map.getSource("risk-points");
    if (source) {
      source.setData(geojson);
    }

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
  const source = map?.getSource("risk-points");
  if (source) {
    source.setData({ type: "FeatureCollection", features: [] });
  }
}

/** Zooms/pans the camera to frame every result, with padding so pins
 * near the edge aren't clipped by the side panels. A single result still
 * gets a sensible close-in zoom rather than fitBounds collapsing to a
 * single point at max zoom. */
function fitToFeatures(map, features) {
  const coords = features
    .map((f) => f.geometry?.coordinates)
    .filter((c) => Array.isArray(c) && c.length === 2);

  if (coords.length === 0) return;

  if (coords.length === 1) {
    map.flyTo({ center: coords[0], zoom: 9, duration: 900 });
    return;
  }

  let minLng = coords[0][0], maxLng = coords[0][0];
  let minLat = coords[0][1], maxLat = coords[0][1];
  for (const [lng, lat] of coords) {
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