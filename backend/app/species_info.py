import asyncio
import time
import httpx

# Wikimedia's API etiquette policy requires a descriptive User-Agent
# identifying the application and a contact method — requests without one
# can be throttled or rejected outright. This was the actual cause of
# "no information found" showing up even for real, well-documented species.
# OpenAlex's "polite pool" (faster, more reliable rate limits) also keys
# off a contact email being present somewhere in the request — including
# it in the User-Agent here covers both.
REQUEST_HEADERS = {
    "User-Agent": "TelestoNode/1.0 (marine ecosystem monitoring research tool; "
                  "contact: yashikayapsandworks@gmail.com)"
}

# In-process cache keyed by species label. Resets on redeploy/restart —
# fine here since all upstream sources are free and fast; this just
# avoids redundant round-trips while the process is warm.
_cache = {}
_CACHE_TTL_SECONDS = 60 * 60 * 24  # 24h

# How many related papers to surface in the tooltip. Kept small — this is
# a hover popup, not a literature review.
_MAX_PAPERS = 4


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
            f"https://en.wikipedia.org/api/rest_v1/page/summary/{title.replace(' ', '_')}",
            headers=REQUEST_HEADERS,
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
    # Prefer a direct landing page (often open-access or the publisher's
    # page) over a bare DOI URL, since it's more likely to actually be
    # readable without a paywall prompt.
    primary = work.get("primary_location") or {}
    landing = primary.get("landing_page_url")
    if landing:
        return landing
    doi = work.get("doi")
    if doi:
        return doi if doi.startswith("http") else f"https://doi.org/{doi}"
    return work.get("id")  # OpenAlex work ID URL as a last resort


async def _fetch_related_papers(client: httpx.AsyncClient, scientific_name: str):
    """Free, no-API-key search against OpenAlex — a large open catalog of
    scholarly works. Used here purely for "does published research mention
    this species" relevance, not as a claim that Telesto Node's own
    detections are validated by these papers."""
    try:
        resp = await client.get(
            "https://api.openalex.org/works",
            params={
                "search": scientific_name,
                "per-page": _MAX_PAPERS,
                "sort": "relevance_score:desc",
                # OpenAlex's documented "polite pool" mechanism — a
                # mailto query param gets a much higher, dedicated rate
                # limit than the shared anonymous pool. Having the
                # contact email only in the User-Agent header wasn't
                # enough; this is the actual documented requirement and
                # is what was causing HTTP 429s.
                "mailto": "yashikayapsandworks@gmail.com",
            },
            headers=REQUEST_HEADERS,
        )
        if resp.status_code != 200:
            return [], f"openalex:{scientific_name} -> HTTP {resp.status_code}"

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
        return papers, f"openalex:{scientific_name} -> {len(papers)} results"
    except Exception as e:
        # Broadened from httpx.HTTPError: a malformed/unexpected OpenAlex
        # response body (bad JSON, missing fields the parsing loop above
        # assumes exist) previously wasn't caught here, since those are
        # plain KeyError/JSONDecodeError, not HTTPError. When this ran
        # inside asyncio.gather alongside the Wikipedia/OBIS calls, an
        # uncaught exception here could take down the ENTIRE
        # get_species_info() call, not just silently drop the papers
        # section — turning "no papers found" into "whole modal errors."
        return [], f"openalex:{scientific_name} -> error {type(e).__name__}: {e}"


async def _fetch_wikipedia_with_fallback(client: httpx.AsyncClient, common_name: str, scientific_name: str):
    """Bundles the "try scientific name, fall back to common name" logic
    into one coroutine so the whole thing can run as a single unit inside
    asyncio.gather, in parallel with the OBIS and OpenAlex calls — those
    two don't depend on the Wikipedia result at all, so there's no reason
    to make them wait for it."""
    debug = []
    wiki = await _fetch_wikipedia_summary(client, scientific_name)
    debug.append(f"wikipedia:{scientific_name} -> {'hit' if wiki else 'miss'}")
    if wiki is None and common_name != scientific_name:
        wiki = await _fetch_wikipedia_summary(client, common_name)
        debug.append(f"wikipedia:{common_name} -> {'hit' if wiki else 'miss'}")
    return wiki, debug


async def _fetch_obis_taxon(client: httpx.AsyncClient, scientific_name: str):
    try:
        resp = await client.get(
            "https://api.obis.org/v3/taxon/complete",
            params={"scientificname": scientific_name},
            headers=REQUEST_HEADERS,
        )
        if resp.status_code == 200:
            results = resp.json().get("results", [])
            return results, f"obis:{scientific_name} -> {len(results)} results"
        return [], f"obis:{scientific_name} -> HTTP {resp.status_code}"
    except Exception as e:
        return [], f"obis:{scientific_name} -> error {type(e).__name__}: {e}"


async def get_species_info(species_name: str) -> dict:
    cached = _cache.get(species_name)
    if cached and (time.time() - cached["cached_at"]) < _CACHE_TTL_SECONDS:
        return cached["data"]

    common_name, scientific_name = _split_label(species_name)
    data = {"query": species_name}
    debug_attempts = []

    async with httpx.AsyncClient(timeout=8.0) as client:
        # These three calls are fully independent of each other — none of
        # them needs another's result — so run them concurrently instead
        # of sequentially. Previously this was three separate `await`s
        # back to back, meaning total latency was the SUM of all three
        # (worst case ~24s at the 8s-per-call timeout). Running them in
        # parallel bounds it to whichever single call is slowest instead
        # — the actual fix for the Species Inspector modal feeling slow.
        (wiki, wiki_debug), (obis_results, obis_debug), (papers, papers_debug) = await asyncio.gather(
            _fetch_wikipedia_with_fallback(client, common_name, scientific_name),
            _fetch_obis_taxon(client, scientific_name),
            _fetch_related_papers(client, scientific_name),
        )
        debug_attempts.extend(wiki_debug)
        debug_attempts.append(obis_debug)
        debug_attempts.append(papers_debug)

        if wiki:
            data["common_name"] = wiki.get("title")
            data["summary"] = wiki.get("extract")
            data["wikipedia_url"] = (
                wiki.get("content_urls", {}).get("desktop", {}).get("page")
            )
            # Wikipedia's summary API already includes an image if the
            # article has one — "originalimage" (full-res) is preferred
            # over "thumbnail" (Wikipedia's smaller default crop) when
            # both are present, since it renders better at the modal's
            # larger display size.
            image = wiki.get("originalimage") or wiki.get("thumbnail")
            if image and image.get("source"):
                data["diagram_url"] = image["source"]

        if obis_results:
            match = obis_results[0]
            data["scientific_name"] = match.get("scientificName")
            data["taxon_rank"] = match.get("taxonRank")
            data["kingdom"] = match.get("kingdom")

        if papers:
            data["research_papers"] = papers

    if len(data) <= 1:
        data["error"] = "No information found for this species"

    # Always attach the debug trail (not just on total failure) — this is
    # what let us actually diagnose the papers-going-missing report
    # instead of guessing. Only consumed by devtools/network inspection;
    # the frontend modal doesn't render this field.
    data["_debug"] = debug_attempts

    data["_source"] = "wikipedia_obis_openalex"
    _cache[species_name] = {"data": data, "cached_at": time.time()}
    return data