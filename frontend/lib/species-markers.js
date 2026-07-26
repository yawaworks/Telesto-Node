const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:5050";

/**
 * Fetches OBIS species occurrence data for a scientific name and loads it
 * into the map's existing "risk-points" GeoJSON source (already added in
 * bathymetry-map.js). Also wires up a click handler that shows a popup
 * with species details.
 */
export async function loadSpeciesMarkers(map, scientificName) {
  if (!map || !scientificName) return;

  try {
    const response = await fetch(
      `${API_BASE_URL}/species-data?scientific_name=${encodeURIComponent(scientificName)}`
    );

    if (!response.ok) {
      console.warn(`No OBIS data for "${scientificName}" (status ${response.status})`);
      return;
    }

    const geojson = await response.json();
    const source = map.getSource("risk-points");
    if (source) {
      source.setData(geojson);
    }

    attachPopupHandler(map);
  } catch (err) {
    console.error("Failed to load species markers:", err);
  }
}

let popupHandlerAttached = false;

function attachPopupHandler(map) {
  if (popupHandlerAttached) return; // only wire the click listener once
  popupHandlerAttached = true;

  map.on("click", "risk-markers", (e) => {
    const feature = e.features?.[0];
    if (!feature) return;

    const { scientificName, depth_meters, country } = feature.properties;
    const [lng, lat] = feature.geometry.coordinates;

    const html = `
      <div style="font-family: monospace; font-size: 12px; color: #111;">
        <strong>${scientificName || "Unknown species"}</strong><br/>
        Depth: ${depth_meters ?? "—"} m<br/>
        Location: ${country || "International Waters"}<br/>
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