import time
import httpx

# In-process cache keyed by species label. Resets on redeploy/restart —
# fine here since both upstream sources are free and fast; this just
# avoids redundant round-trips while the process is warm.
_cache = {}
_CACHE_TTL_SECONDS = 60 * 60 * 24  # 24h


async def get_species_info(species_name: str) -> dict:
    cached = _cache.get(species_name)
    if cached and (time.time() - cached["cached_at"]) < _CACHE_TTL_SECONDS:
        return cached["data"]

    data = {"query": species_name}

    async with httpx.AsyncClient(timeout=8.0) as client:
        # Wikipedia REST summary — free, no API key required. Gives a
        # short human-written description plus a link to the full article.
        try:
            wiki_resp = await client.get(
                f"https://en.wikipedia.org/api/rest_v1/page/summary/{species_name.replace(' ', '_')}"
            )
            if wiki_resp.status_code == 200:
                wiki = wiki_resp.json()
                data["common_name"] = wiki.get("title")
                data["summary"] = wiki.get("extract")
                data["wikipedia_url"] = (
                    wiki.get("content_urls", {}).get("desktop", {}).get("page")
                )
        except httpx.HTTPError:
            pass

        # OBIS taxon match — free, no API key required, and the same
        # source your bathymetry map's species markers already rely on.
        # Confirms scientific name / taxonomic rank rather than guessing.
        try:
            obis_resp = await client.get(
                "https://api.obis.org/v3/taxon/complete",
                params={"scientificname": species_name},
            )
            if obis_resp.status_code == 200:
                results = obis_resp.json().get("results", [])
                if results:
                    match = results[0]
                    data["scientific_name"] = match.get("scientificName")
                    data["taxon_rank"] = match.get("taxonRank")
                    data["kingdom"] = match.get("kingdom")
        except httpx.HTTPError:
            pass

    if len(data) <= 1:
        data["error"] = "No information found for this species"

    data["_source"] = "wikipedia_obis"
    _cache[species_name] = {"data": data, "cached_at": time.time()}
    return data