import time
import httpx

# In-process cache keyed by species label. Resets on redeploy/restart —
# fine here since both upstream sources are free and fast; this just
# avoids redundant round-trips while the process is warm.
_cache = {}
_CACHE_TTL_SECONDS = 60 * 60 * 24  # 24h


def _split_label(species_name: str):
    """Detection labels here come formatted as "Common Name_Scientific name"
    (e.g. "Regal Tang_Paracanthurus hepatus"), not a single clean name. Pull
    both halves apart so each can be tried separately — Wikipedia article
    titles usually match either the common name or the scientific name, but
    essentially never the combined underscore-joined string."""
    if "_" in species_name:
        common, _, scientific = species_name.partition("_")
        return common.strip(), scientific.strip()
    return species_name.strip(), species_name.strip()


async def _fetch_wikipedia_summary(client: httpx.AsyncClient, title: str):
    try:
        resp = await client.get(
            f"https://en.wikipedia.org/api/rest_v1/page/summary/{title.replace(' ', '_')}"
        )
        if resp.status_code == 200:
            payload = resp.json()
            # Wikipedia returns 200 with a "type": "disambiguation" or
            # missing "extract" for pages that don't actually describe the
            # species — treat those as a miss so we fall through to the
            # other name variant instead of showing a useless summary.
            if payload.get("extract"):
                return payload
    except httpx.HTTPError:
        pass
    return None


async def get_species_info(species_name: str) -> dict:
    cached = _cache.get(species_name)
    if cached and (time.time() - cached["cached_at"]) < _CACHE_TTL_SECONDS:
        return cached["data"]

    common_name, scientific_name = _split_label(species_name)
    data = {"query": species_name}

    async with httpx.AsyncClient(timeout=8.0) as client:
        # Try the scientific name first (more likely to be an exact,
        # unambiguous Wikipedia title), then fall back to the common name.
        wiki = await _fetch_wikipedia_summary(client, scientific_name)
        if wiki is None and common_name != scientific_name:
            wiki = await _fetch_wikipedia_summary(client, common_name)

        if wiki:
            data["common_name"] = wiki.get("title")
            data["summary"] = wiki.get("extract")
            data["wikipedia_url"] = (
                wiki.get("content_urls", {}).get("desktop", {}).get("page")
            )

        # OBIS taxon match — free, no API key required, and the same
        # source your bathymetry map's species markers already rely on.
        # Confirms scientific name / taxonomic rank rather than guessing.
        # Always query with the scientific-name half, since that's what
        # OBIS's taxonomic backbone actually indexes on.
        try:
            obis_resp = await client.get(
                "https://api.obis.org/v3/taxon/complete",
                params={"scientificname": scientific_name},
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