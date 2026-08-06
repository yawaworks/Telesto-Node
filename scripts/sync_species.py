"""Fetches OBIS + iNaturalist records for the tracked species and pushes
them to the backend's /internal/species-sync endpoint. Run on a schedule
by .github/workflows/species-sync.yml — this replaces the old n8n
"Species Data Sync" workflow (Schedule Trigger -> Fetch OBIS/iNaturalist
in parallel -> Merge -> Normalize -> Push to Backend) with a plain Python
script running on GitHub's own infrastructure, free, with no separate
hosting dependency.
"""
import os
import sys
import requests

BACKEND_URL = os.environ["BACKEND_URL"]  # e.g. https://telesto-node-backend.onrender.com
SYNC_SECRET = os.environ["INTERNAL_SYNC_SECRET"]
SPECIES_NAME = os.environ.get("SYNC_SPECIES", "Acropora cervicornis")


def fetch_obis(species: str) -> list[dict]:
    try:
        resp = requests.get(
            "https://api.obis.org/v3/occurrence",
            params={"scientificname": species, "size": 200, "absence": "false"},
            timeout=20,
        )
        resp.raise_for_status()
        results = resp.json().get("results", [])
    except Exception as exc:
        print(f"[species-sync] OBIS fetch failed: {exc}")
        return []

    records = []
    for r in results:
        lat, lng = r.get("decimalLatitude"), r.get("decimalLongitude")
        if lat is None or lng is None:
            continue
        records.append({
            "scientific_name": r.get("scientificName", species),
            "latitude": lat,
            "longitude": lng,
            "depth_meters": r.get("depth"),
            "country": r.get("country"),
            "source": "obis",
            "event_date": r.get("eventDate"),
        })
    return records


def fetch_inaturalist(species: str) -> list[dict]:
    try:
        resp = requests.get(
            "https://api.inaturalist.org/v1/observations",
            params={"taxon_name": species, "per_page": 200},
            timeout=20,
        )
        resp.raise_for_status()
        results = resp.json().get("results", [])
    except Exception as exc:
        print(f"[species-sync] iNaturalist fetch failed: {exc}")
        return []

    records = []
    for r in results:
        lat, lng = r.get("latitude"), r.get("longitude")
        if lat is None or lng is None:
            continue
        records.append({
            "scientific_name": species,
            "latitude": lat,
            "longitude": lng,
            "depth_meters": None,
            "country": (r.get("place_guess") or "").split(",")[-1].strip() or None,
            "source": "inaturalist",
            "event_date": r.get("observed_on"),
        })
    return records


def main():
    records = fetch_obis(SPECIES_NAME) + fetch_inaturalist(SPECIES_NAME)

    if not records:
        print("[species-sync] No records from either source — nothing to push")
        sys.exit(0)  # not a failure, just nothing new right now

    resp = requests.post(
        f"{BACKEND_URL}/internal/species-sync",
        headers={"x-sync-secret": SYNC_SECRET},
        json={"records": records},
        # 60s, not 30 — Render's free tier can take 30-50s to wake from a
        # cold start (sleeps after ~15 min idle) before it even accepts a
        # connection, on top of Mongo write time. The Keep-Alive workflow
        # is meant to prevent this, but this timeout is a safety margin
        # for the (rare) case it misses a ping window.
        timeout=60,
    )
    resp.raise_for_status()
    print(f"[species-sync] Synced {len(records)} records: {resp.json()}")


if __name__ == "__main__":
    main()