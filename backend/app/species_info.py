import time
import httpx

REQUEST_HEADERS = {
    # OpenAlex specifically parses for the "mailto:" token to grant polite-
    # pool access (faster, more consistent rate limits) — a plain "contact:"
    # label doesn't trigger it. Wikipedia doesn't need this token, it just
    # wants a real identifying UA string, so this format satisfies both.
    "User-Agent": "TelestoNode/1.0 (marine ecosystem monitoring research tool; "
                  "mailto:yashikayapsandworks@gmail.com)"
}

# Also passed as an explicit query param on OpenAlex calls specifically —
# belt-and-suspenders, since the mailto param is OpenAlex's more reliably
# documented mechanism and costs nothing to include alongside the header.
OPENALEX_CONTACT_EMAIL = "yashikayapsandworks@gmail.com"

_cache = {}
_CACHE_TTL_SECONDS = 60 * 60 * 24        # 24h — for genuinely complete results
_FAILURE_CACHE_TTL_SECONDS = 60          # 60s — for results where an upstream call errored, so a transient failure doesn't lock a species out for a full day
_MAX_PAPERS = 4


def _split_label(species_name: str):
    if "_" in species_name:
        common, _, scientific = species_name.partition("_")
        return common.strip(), scientific.strip()
    return species_name.strip(), species_name.strip()


async def _fetch_wikipedia_summary(client: httpx.AsyncClient, title: str):
    try:
        resp = await client.get(
            f"https://en.wikipedia.org/api/rest_v1/page/summary/{title.replace(' ', '_')}",
            headers=REQUEST_HEADERS,
        )
        if resp.status_code == 200:
            payload = resp.json()
            if payload.get("extract"):
                return payload
    except httpx.HTTPError:
        pass
    return None


def _clean_openalex_title(work: dict) -> str:
    title = work.get("title") or work.get("display_name") or ""
    return title.strip()


def _clean_openalex_authors(work: dict, max_authors: int = 3) -> str:
    authorships = work.get("authorships") or []
    names = [
        a.get("author", {}).get("display_name")
        for a in authorships[:max_authors]
        if a.get("author", {}).get("display_name")
    ]
    if not names:
        return ""
    suffix = " et al." if len(authorships) > max_authors else ""
    return ", ".join(names) + suffix


def _openalex_link(work: dict) -> str | None:
    primary = work.get("primary_location") or {}
    landing = primary.get("landing_page_url")
    if landing:
        return landing
    doi = work.get("doi")
    if doi:
        return doi if doi.startswith("http") else f"https://doi.org/{doi}"
    return work.get("id")


async def _fetch_related_papers(client: httpx.AsyncClient, scientific_name: str):
    """Returns (papers, debug_string, had_error). had_error distinguishes
    "genuinely zero papers exist" from "the request failed" — the caller
    uses this to decide how long to cache the result."""
    try:
        resp = await client.get(
            "https://api.openalex.org/works",
            params={
                "search": scientific_name,
                "per-page": _MAX_PAPERS,
                "sort": "relevance_score:desc",
                "mailto": OPENALEX_CONTACT_EMAIL,
            },
            headers=REQUEST_HEADERS,
        )
        if resp.status_code != 200:
            return [], f"openalex:{scientific_name} -> HTTP {resp.status_code}", True

        results = resp.json().get("results", [])
        papers = []
        for work in results:
            title = _clean_openalex_title(work)
            if not title:
                continue
            papers.append(
                {
                    "title": title,
                    "year": work.get("publication_year"),
                    "authors": _clean_openalex_authors(work),
                    "url": _openalex_link(work),
                }
            )
        return papers, f"openalex:{scientific_name} -> {len(papers)} results", False
    except httpx.HTTPError as e:
        return [], f"openalex:{scientific_name} -> error {e}", True


async def get_species_info(species_name: str) -> dict:
    cached = _cache.get(species_name)
    if cached and (time.time() - cached["cached_at"]) < cached["ttl"]:
        return cached["data"]

    common_name, scientific_name = _split_label(species_name)
    data = {"query": species_name}
    debug_attempts = []
    had_any_error = False

    async with httpx.AsyncClient(timeout=8.0) as client:
        wiki = await _fetch_wikipedia_summary(client, scientific_name)
        debug_attempts.append(f"wikipedia:{scientific_name} -> {'hit' if wiki else 'miss'}")
        if wiki is None and common_name != scientific_name:
            wiki = await _fetch_wikipedia_summary(client, common_name)
            debug_attempts.append(f"wikipedia:{common_name} -> {'hit' if wiki else 'miss'}")

        if wiki:
            data["common_name"] = wiki.get("title")
            data["summary"] = wiki.get("extract")
            data["wikipedia_url"] = (
                wiki.get("content_urls", {}).get("desktop", {}).get("page")
            )
            image = wiki.get("originalimage") or wiki.get("thumbnail")
            if image and image.get("source"):
                data["diagram_url"] = image["source"]

        try:
            obis_resp = await client.get(
                "https://api.obis.org/v3/taxon/complete",
                params={"scientificname": scientific_name},
                headers=REQUEST_HEADERS,
            )
            if obis_resp.status_code == 200:
                results = obis_resp.json().get("results", [])
                debug_attempts.append(f"obis:{scientific_name} -> {len(results)} results")
                if results:
                    match = results[0]
                    data["scientific_name"] = match.get("scientificName")
                    data["taxon_rank"] = match.get("taxonRank")
                    data["kingdom"] = match.get("kingdom")
            else:
                debug_attempts.append(f"obis:{scientific_name} -> HTTP {obis_resp.status_code}")
                had_any_error = True
        except httpx.HTTPError as e:
            debug_attempts.append(f"obis:{scientific_name} -> error {e}")
            had_any_error = True

        papers, papers_debug, papers_had_error = await _fetch_related_papers(client, scientific_name)
        debug_attempts.append(papers_debug)
        had_any_error = had_any_error or papers_had_error
        if papers:
            data["research_papers"] = papers

    if len(data) <= 1:
        data["error"] = "No information found for this species"
        data["_debug"] = debug_attempts

    data["_source"] = "wikipedia_obis_openalex"

    # Short TTL when something upstream failed, so a transient hiccup
    # doesn't lock a species out of showing papers for a full day.
    ttl = _FAILURE_CACHE_TTL_SECONDS if had_any_error else _CACHE_TTL_SECONDS
    _cache[species_name] = {"data": data, "cached_at": time.time(), "ttl": ttl}
    return data