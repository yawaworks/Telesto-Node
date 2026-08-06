"""
Vessel movement tracking via Global Fishing Watch (GFW) — apparent
fishing effort near a location, so a researcher can see whether a
detection site sits inside active fishing pressure.

============================================================================
HONESTY FLAG — read before relying on this module
============================================================================
Unlike everything else built alongside this (OBIS, iNaturalist, Wikipedia,
OpenAlex, CrossRef, etc.), this integration could NOT be tested against
the live API — GFW's domain isn't reachable from the environment this was
built in. Everything below is written from best available knowledge of
GFW's v3 "4wings" report API shape (POST endpoint, Bearer auth, a GeoJSON
region + date-range + dataset id in the request body), but:

  - The exact dataset id string below (GFW_FISHING_EFFORT_DATASET) is the
    kind of value GFW has changed before between API versions. If this
    returns a 400/404, checking the current dataset id against GFW's own
    API documentation (globalfishingwatch.org/our-apis) is the first
    thing to try — not a sign the whole approach is wrong.
  - The exact response JSON shape (_parse_4wings_response below) is a
    best-effort reading of the documented format, not verified against a
    real response. If parsing silently returns an empty list where real
    data should be, log the raw response and check the shape against
    current docs before assuming there's no vessel activity.
  - GFW requires an API key obtained by application (not instant/keyless
    like OBIS) — see https://globalfishingwatch.org/our-apis/. Real
    approval turnaround, not "free" in the frictionless sense BHL/IUCN
    keys are.

Ship this, watch the first real request against it, and adjust — don't
assume it's correct just because it imports cleanly and degrades
gracefully with no key. That degradation path (GFW_API_KEY unset ->
clean 503, not a crash) IS solid and matches the rest of this app's
optional-key pattern; the actual data-fetching path is the unverified
part.
============================================================================
"""

import os

import httpx

GFW_API_KEY = os.getenv("GFW_API_KEY", "")
GFW_BASE_URL = "https://gateway.api.globalfishingwatch.org/v3"

# Best-effort dataset id for public apparent-fishing-effort data — VERIFY
# against https://globalfishingwatch.org/our-apis/ before relying on
# this in production. GFW versions and renames these periodically.
GFW_FISHING_EFFORT_DATASET = "public-global-fishing-effort:latest"


def _parse_4wings_response(data: dict) -> list[dict]:
    """Best-effort parse of a 4wings report response into simple
    {latitude, longitude, hours} cells. GFW's actual response nests
    entries under an "entries" list, each containing a "data" array of
    per-cell records with lat/lon and apparent fishing hours — this
    reads that shape defensively (never raises on an unexpected
    structure, just returns fewer/no cells) so a shape mismatch fails
    quietly into "no data" rather than crashing the request."""
    cells = []
    entries = data.get("entries") if isinstance(data, dict) else None
    if not isinstance(entries, list):
        return cells

    for entry in entries:
        rows = entry.get("data") if isinstance(entry, dict) else None
        if not isinstance(rows, list):
            continue
        for row in rows:
            lat = row.get("lat")
            lon = row.get("lon")
            hours = row.get("hours") or row.get("fishingHours")
            if lat is None or lon is None:
                continue
            cells.append({"latitude": lat, "longitude": lon, "hours": hours})
    return cells


async def fetch_vessel_activity(
    min_lat: float, min_lng: float, max_lat: float, max_lng: float,
    start_date: str, end_date: str,
) -> list[dict]:
    """Fetches apparent fishing effort cells within a bounding box and
    date range (start_date/end_date as "YYYY-MM-DD"). Raises RuntimeError
    on any failure — including a shape mismatch that parses to zero
    results, since silently returning "no vessel activity" when the real
    answer is "the API call or parsing was wrong" would be worse than a
    visible error the caller can surface honestly."""
    if not GFW_API_KEY:
        raise RuntimeError("GFW_API_KEY is not set")

    region_geojson = {
        "type": "Polygon",
        "coordinates": [[
            [min_lng, min_lat], [max_lng, min_lat],
            [max_lng, max_lat], [min_lng, max_lat],
            [min_lng, min_lat],
        ]],
    }

    async with httpx.AsyncClient(timeout=20) as client:
        try:
            resp = await client.post(
                f"{GFW_BASE_URL}/4wings/report",
                headers={"Authorization": f"Bearer {GFW_API_KEY}"},
                params={
                    "spatial-resolution": "low",
                    "temporal-resolution": "monthly",
                    "group-by": "vessel_id",
                    "date-range": f"{start_date},{end_date}",
                },
                json={
                    "region": {"type": "GEOJSON", "geojson": region_geojson},
                    "datasets": [GFW_FISHING_EFFORT_DATASET],
                },
            )
            resp.raise_for_status()
        except httpx.HTTPStatusError as exc:
            raise RuntimeError(
                f"GFW API returned {exc.response.status_code} — this is the unverified integration "
                f"flagged in this module's docstring; check the dataset id and request shape against "
                f"GFW's current API docs. Response body: {exc.response.text[:300]}"
            )
        except Exception as exc:
            raise RuntimeError(f"GFW API request failed: {exc}")

        data = resp.json()

    return _parse_4wings_response(data)