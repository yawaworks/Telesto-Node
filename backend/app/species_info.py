import asyncio
import os
import time
import httpx

from app.europepmc_client import (
    HISTOLOGY_KEYWORDS,
    ULTRASTRUCTURE_KEYWORDS,
    fetch_imaging_literature,
)

from app.morphosource_client import morphosource_search_url

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

# Optional: a free Semantic Scholar API key moves requests off the shared
# anonymous rate-limit pool onto a dedicated per-key limit. Sign up free at
# https://www.semanticscholar.org/product/api and set S2_API_KEY on Render.
# Without it, this still works, just shares Render's outbound IP's rate
# budget with every other app on Render's free tier hitting the same API —
# which is the actual cause of the HTTP 429s seen even at low personal
# usage.
S2_API_KEY = os.getenv("S2_API_KEY", "")

# Both optional, free, instant-signup keys (no approval wait like Semantic
# Scholar) — the app works fine without them, it just skips these two
# specific data points rather than erroring.
# BHL: https://www.biodiversitylibrary.org/api3 (request a key on that page)
BHL_API_KEY = os.getenv("BHL_API_KEY", "")
# IUCN Red List: https://api.iucnredlist.org (request a token)
IUCN_API_KEY = os.getenv("IUCN_API_KEY", "")


async def _get_with_retry(client: httpx.AsyncClient, url: str, **kwargs):
    """GET with a couple of short retries specifically for HTTP 429 —
    OpenAlex/Semantic Scholar rate limits on a shared free-tier IP are
    often transient (someone else's burst of traffic, not a sustained
    block), so waiting half a second and trying again frequently
    succeeds where an immediate single attempt doesn't. Any other status
    code or exception is returned/raised immediately — this only exists
    to smooth over 429s, not to mask real failures."""
    delays = [0.5, 1.5]
    last_resp = None
    for attempt in range(len(delays) + 1):
        resp = await client.get(url, **kwargs)
        if resp.status_code != 429:
            return resp
        last_resp = resp
        if attempt < len(delays):
            await asyncio.sleep(delays[attempt])
    return last_resp

# In-process cache keyed by species label. Resets on redeploy/restart —
# fine here since all upstream sources are free and fast; this just
# avoids redundant round-trips while the process is warm.
_cache = {}
_CACHE_TTL_SECONDS = 60 * 60 * 24  # 24h

# How many related papers to surface in the tooltip. Kept small — this is
# a hover popup, not a literature review.
_MAX_PAPERS = 4


def _split_label(species_name: str):
    """Detection labels here come formatted as "Common-Name_Scientific-name"
    (e.g. "Tomato-Clownfish_Amphiprion-frenatus") — hyphens standing in for
    spaces within each name segment (a common constraint on model class
    names, which often can't contain literal spaces), and an underscore
    separating the common name from the scientific name.

    This was silently breaking EVERY downstream lookup: "Amphiprion-frenatus"
    matches nothing on Wikipedia, OBIS, OpenAlex, or Semantic Scholar — none
    of them treat a hyphen as a word-space substitute the way this label
    format does. Converting hyphens back to real spaces here, once, before
    any of those lookups happens, is the actual fix — not a rate-limit or
    API-specific issue, everything downstream was just searching for a
    string that doesn't exist anywhere."""
    if "_" in species_name:
        common, _, scientific = species_name.partition("_")
    else:
        common, scientific = species_name, species_name
    common = common.strip().replace("-", " ")
    scientific = scientific.strip().replace("-", " ")
    return common, scientific


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
        resp = await _get_with_retry(
            client,
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


def _clean_s2_authors(paper: dict, max_authors: int = 3) -> str:
    authors = paper.get("authors") or []
    names = [a.get("name") for a in authors[:max_authors] if a.get("name")]
    if not names:
        return ""
    suffix = " et al." if len(authors) > max_authors else ""
    return ", ".join(names) + suffix


def _s2_link(paper: dict) -> str | None:
    doi = (paper.get("externalIds") or {}).get("DOI")
    if doi:
        return f"https://doi.org/{doi}"
    return paper.get("url")  # Semantic Scholar's own paper page as fallback


def _crossref_title(item: dict) -> str:
    titles = item.get("title") or []
    return titles[0].strip() if titles else ""


def _crossref_year(item: dict):
    for key in ("published-print", "published-online", "published", "issued"):
        parts = (item.get(key) or {}).get("date-parts")
        if parts and parts[0] and parts[0][0]:
            return parts[0][0]
    return None


def _crossref_authors(item: dict, max_authors: int = 3) -> str:
    authors = item.get("author") or []
    names = []
    for a in authors[:max_authors]:
        name = " ".join(p for p in [a.get("given"), a.get("family")] if p)
        if name:
            names.append(name)
    if not names:
        return ""
    suffix = " et al." if len(authors) > max_authors else ""
    return ", ".join(names) + suffix


def _crossref_link(item: dict) -> str | None:
    doi = item.get("DOI")
    if doi:
        return f"https://doi.org/{doi}"
    return item.get("URL")


async def _fetch_crossref_papers(client: httpx.AsyncClient, scientific_name: str):
    """Third, independent paper source — CrossRef, requiring zero signup
    or API key at all (unlike Semantic Scholar, which needs a free but
    approval-gated key to get a decent rate limit). Same "polite pool"
    convention as OpenAlex: a mailto param gets a higher, more reliable
    rate limit than fully anonymous access, with no application process.
    This exists specifically so paper results don't depend entirely on
    sources that need approval or are prone to shared-IP rate limiting —
    CrossRef is available immediately, today, with no waiting."""
    try:
        resp = await _get_with_retry(
            client,
            "https://api.crossref.org/works",
            params={
                "query.bibliographic": scientific_name,
                "rows": _MAX_PAPERS,
                "mailto": "yashikayapsandworks@gmail.com",
            },
            headers=REQUEST_HEADERS,
        )
        if resp.status_code != 200:
            return [], f"crossref:{scientific_name} -> HTTP {resp.status_code}"

        items = resp.json().get("message", {}).get("items", [])
        papers = []
        for item in items:
            title = _crossref_title(item)
            if not title:
                continue
            papers.append(
                {
                    "title": title,
                    "year": _crossref_year(item),
                    "authors": _crossref_authors(item),
                    "url": _crossref_link(item),
                }
            )
        return papers, f"crossref:{scientific_name} -> {len(papers)} results"
    except Exception as e:
        return [], f"crossref:{scientific_name} -> error {type(e).__name__}: {e}"


async def _fetch_semantic_scholar_papers(client: httpx.AsyncClient, scientific_name: str):
    """Second, independent paper source — Semantic Scholar's free Graph
    API, no key required for this volume of use. Runs concurrently with
    OpenAlex (not as a sequential fallback only tried after OpenAlex
    fails) so a rate-limit or outage on one source doesn't cost extra
    latency waiting to try the other; results from both are merged in
    get_species_info."""
    try:
        headers = dict(REQUEST_HEADERS)
        if S2_API_KEY:
            headers["x-api-key"] = S2_API_KEY
        resp = await _get_with_retry(
            client,
            "https://api.semanticscholar.org/graph/v1/paper/search",
            params={
                "query": scientific_name,
                "limit": _MAX_PAPERS,
                "fields": "title,year,authors,url,externalIds",
            },
            headers=headers,
        )
        if resp.status_code != 200:
            return [], f"semanticscholar:{scientific_name} -> HTTP {resp.status_code}"

        results = resp.json().get("data", [])
        papers = []
        for paper in results:
            title = (paper.get("title") or "").strip()
            if not title:
                continue
            papers.append(
                {
                    "title": title,
                    "year": paper.get("year"),
                    "authors": _clean_s2_authors(paper),
                    "url": _s2_link(paper),
                }
            )
        return papers, f"semanticscholar:{scientific_name} -> {len(papers)} results"
    except Exception as e:
        return [], f"semanticscholar:{scientific_name} -> error {type(e).__name__}: {e}"


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


# How many real photos to surface in the Photos tab. iNaturalist taxa can
# have dozens of community-contributed photos; keep this small — a
# reference gallery, not every photo ever uploaded.
_MAX_PHOTOS = 8


async def _fetch_inaturalist_photos(client: httpx.AsyncClient, scientific_name: str):
    """iNaturalist indexes MULTIPLE real, community-contributed photos per
    taxon (not just one) — a genuinely better fit for a researcher-facing
    "Photos" tab than a single Wikipedia lead image, which is often a
    generic or unrepresentative shot chosen for the article's infobox
    rather than for taxonomic clarity.

    Two-step lookup: first find the taxon ID via a name search, then fetch
    that taxon's full record (which includes its photo array — the search
    endpoint alone doesn't return the full gallery)."""
    try:
        search_resp = await _get_with_retry(
            client,
            "https://api.inaturalist.org/v1/taxa",
            params={"q": scientific_name, "per_page": 1, "rank": "species"},
            headers=REQUEST_HEADERS,
        )
        if search_resp.status_code != 200:
            return [], f"inaturalist:{scientific_name} -> HTTP {search_resp.status_code} (search)"

        search_results = search_resp.json().get("results", [])
        if not search_results:
            return [], f"inaturalist:{scientific_name} -> no taxon match"

        taxon_id = search_results[0].get("id")
        if not taxon_id:
            return [], f"inaturalist:{scientific_name} -> taxon match has no id"

        detail_resp = await _get_with_retry(
            client,
            f"https://api.inaturalist.org/v1/taxa/{taxon_id}",
            headers=REQUEST_HEADERS,
        )
        if detail_resp.status_code != 200:
            return [], f"inaturalist:{scientific_name} -> HTTP {detail_resp.status_code} (detail)"

        detail_results = detail_resp.json().get("results", [])
        if not detail_results:
            return [], f"inaturalist:{scientific_name} -> no taxon detail"

        taxon_photos = detail_results[0].get("taxon_photos", [])
        photos = []
        for tp in taxon_photos[:_MAX_PHOTOS]:
            photo = tp.get("photo", {})
            url = photo.get("medium_url") or photo.get("square_url")
            if not url:
                continue
            photos.append(
                {
                    "url": url,
                    "attribution": photo.get("attribution") or "iNaturalist contributor",
                }
            )
        return photos, f"inaturalist:{scientific_name} -> {len(photos)} photos"
    except Exception as e:
        return [], f"inaturalist:{scientific_name} -> error {type(e).__name__}: {e}"


def _classify_wikipedia_image(url: str) -> str:
    """Wikipedia's lead image is usually a real photo, but is sometimes a
    diagram, distribution map, or anatomical illustration — those are
    almost always served as SVG, while real photos are virtually always
    raster (JPG/PNG). This is a genuine, checkable signal, not a guess:
    file extension reliably distinguishes the two categories in practice
    for Wikipedia's media."""
    return "diagram" if url.lower().endswith(".svg") else "photo"


async def _fetch_bhl_illustration(client: httpx.AsyncClient, scientific_name: str):
    """Biodiversity Heritage Library — a genuinely unique source no other
    integration here provides: scanned pages from the historical
    literature, often including the original type-description plate for
    a species. Skipped silently (not an error) if BHL_API_KEY isn't set,
    since this is optional reference material, not core functionality."""
    if not BHL_API_KEY:
        return None, "bhl: skipped (no BHL_API_KEY set)"
    try:
        resp = await _get_with_retry(
            client,
            "https://www.biodiversitylibrary.org/api3",
            params={
                "op": "PublicationSearch",
                "searchterm": scientific_name,
                "searchtype": "F",  # full-text search
                "apikey": BHL_API_KEY,
                "format": "json",
            },
            headers=REQUEST_HEADERS,
        )
        if resp.status_code != 200:
            return None, f"bhl:{scientific_name} -> HTTP {resp.status_code}"

        payload = resp.json()
        results = payload.get("Result") or []
        for item in results:
            page_id = item.get("PrimaryPageID") or item.get("PageID")
            if page_id:
                # BHL's page-image endpoint serves a scanned page directly
                # as an image — no extra lookup needed once we have an ID.
                return (
                    {
                        "url": f"https://www.biodiversitylibrary.org/pageimage/{page_id}",
                        "attribution": f"Biodiversity Heritage Library — {item.get('TitleName', 'historical literature')}",
                    },
                    f"bhl:{scientific_name} -> found page {page_id}",
                )
        return None, f"bhl:{scientific_name} -> no page image found"
    except Exception as e:
        return None, f"bhl:{scientific_name} -> error {type(e).__name__}: {e}"


async def _fetch_iucn_status(client: httpx.AsyncClient, scientific_name: str):
    """IUCN Red List conservation status — Least Concern through Extinct.
    Skipped silently if IUCN_API_KEY isn't set, same reasoning as BHL:
    optional enrichment, not something the app should error over."""
    if not IUCN_API_KEY:
        return None, "iucn: skipped (no IUCN_API_KEY set)"
    try:
        parts = scientific_name.split(" ", 1)
        if len(parts) != 2:
            return None, f"iucn:{scientific_name} -> name isn't genus+species, skipped"
        genus, species = parts
        resp = await _get_with_retry(
            client,
            f"https://api.iucnredlist.org/api/v4/taxa/scientific_name",
            params={"genus_name": genus, "species_name": species},
            headers={**REQUEST_HEADERS, "Authorization": IUCN_API_KEY},
        )
        if resp.status_code != 200:
            return None, f"iucn:{scientific_name} -> HTTP {resp.status_code}"

        assessments = resp.json().get("assessments") or []
        if not assessments:
            return None, f"iucn:{scientific_name} -> no assessment found"

        latest = assessments[0]
        category = latest.get("red_list_category", {}).get("code")
        if not category:
            return None, f"iucn:{scientific_name} -> assessment missing category"
        return category, f"iucn:{scientific_name} -> {category}"
    except Exception as e:
        return None, f"iucn:{scientific_name} -> error {type(e).__name__}: {e}"


async def get_species_info(species_name: str) -> dict:
    cached = _cache.get(species_name)
    if cached and (time.time() - cached["cached_at"]) < _CACHE_TTL_SECONDS:
        return cached["data"]

    common_name, scientific_name = _split_label(species_name)
    data = {"query": species_name}
    debug_attempts = []

    async with httpx.AsyncClient(timeout=8.0) as client:
        # These five calls are fully independent of each other — none of
        # them needs another's result — so run them concurrently instead
        # of sequentially. Three separate paper sources (OpenAlex,
        # Semantic Scholar, CrossRef) run in parallel too, not as
        # fallbacks tried only after another fails — that would cost
        # extra latency on every miss; running them all up front costs
        # nothing extra since they're concurrent anyway, and gives real
        # redundancy against any one source's outages, rate limits, or
        # (for Semantic Scholar specifically) needing an approval-gated
        # API key to get a decent limit. CrossRef needs no signup at all,
        # so it's the one source guaranteed to be usable immediately.
        (
            (wiki, wiki_debug),
            (obis_results, obis_debug),
            (openalex_papers, openalex_debug),
            (s2_papers, s2_debug),
            (crossref_papers, crossref_debug),
            (inat_photos, inat_debug),
            (bhl_illustration, bhl_debug),
            (iucn_status, iucn_debug),
            (histology_papers, histology_debug),
            (ultrastructure_papers, ultrastructure_debug),
        ) = await asyncio.gather(
            _fetch_wikipedia_with_fallback(client, common_name, scientific_name),
            _fetch_obis_taxon(client, scientific_name),
            _fetch_related_papers(client, scientific_name),
            _fetch_semantic_scholar_papers(client, scientific_name),
            _fetch_crossref_papers(client, scientific_name),
            _fetch_inaturalist_photos(client, scientific_name),
            _fetch_bhl_illustration(client, scientific_name),
            _fetch_iucn_status(client, scientific_name),
            fetch_imaging_literature(client, scientific_name, HISTOLOGY_KEYWORDS, "europepmc_histology"),
            fetch_imaging_literature(client, scientific_name, ULTRASTRUCTURE_KEYWORDS, "europepmc_ultrastructure"),
        )
        debug_attempts.extend(wiki_debug)
        debug_attempts.append(obis_debug)
        debug_attempts.append(openalex_debug)
        debug_attempts.append(s2_debug)
        debug_attempts.append(crossref_debug)
        debug_attempts.append(inat_debug)
        debug_attempts.append(bhl_debug)
        debug_attempts.append(iucn_debug)
        debug_attempts.append(histology_debug)
        debug_attempts.append(ultrastructure_debug)

        photos = []
        diagrams = []

        if wiki:
            data["common_name"] = wiki.get("title")
            data["summary"] = wiki.get("extract")
            data["wikipedia_url"] = (
                wiki.get("content_urls", {}).get("desktop", {}).get("page")
            )
            # Wikipedia's summary API includes an image if the article has
            # one — "originalimage" (full-res) is preferred over
            # "thumbnail" when both are present. Classified as photo vs
            # diagram (see _classify_wikipedia_image) rather than always
            # treated as a generic "diagram" regardless of what it
            # actually is — a real animal photo and a distribution-map
            # SVG are not the same kind of reference material, and a
            # researcher wants them in different places, not one lumped
            # "image" slot.
            image = wiki.get("originalimage") or wiki.get("thumbnail")
            if image and image.get("source"):
                url = image["source"]
                entry = {"url": url, "attribution": "Wikipedia"}
                if _classify_wikipedia_image(url) == "diagram":
                    diagrams.append(entry)
                else:
                    photos.append(entry)

        # Real community-contributed photos from iNaturalist — a genuine
        # gallery, not a single possibly-unrepresentative image. Listed
        # after the Wikipedia photo (if any) so the most likely canonical
        # image still appears first.
        photos.extend(inat_photos)

        # BHL's historical illustration (often the original type
        # description plate) goes into the same Diagrams tab as
        # Wikipedia's SVG technical images — both are "reference
        # illustration" rather than "photo of the living animal."
        if bhl_illustration:
            diagrams.append(bhl_illustration)

        if photos:
            data["photos"] = photos
        if diagrams:
            data["diagrams"] = diagrams

        # Category 3 (Anatomical/Internal) — a real link to MorphoSource's
        # own search, not an in-app gallery (see morphosource_client.py
        # for why). Always present since it costs nothing to construct —
        # the frontend decides whether coverage is worth surfacing, and a
        # researcher can always just click through and see for themselves.
        data["anatomical_search_url"] = morphosource_search_url(scientific_name)

        # Categories 4 & 5 (Histological/Cellular, Ultrastructural) — real
        # open-access literature whose title/abstract match the imaging
        # modality, from Europe PMC. These are LITERATURE LINKS, not
        # extracted figure images — see europepmc_client.py for why that
        # distinction matters. Only attached if something actually came
        # back, same pattern as photos/diagrams above.
        if histology_papers:
            data["histological_literature"] = histology_papers
        if ultrastructure_papers:
            data["ultrastructural_literature"] = ultrastructure_papers

        if iucn_status:
            data["conservation_status"] = iucn_status

        if obis_results:
            match = obis_results[0]
            data["scientific_name"] = match.get("scientificName")
            data["taxon_rank"] = match.get("taxonRank")
            data["kingdom"] = match.get("kingdom")
        else:
            # No confirmed taxonomic match, but the frontend's "View
            # Distribution" button still needs SOME name to search the
            # bathymetry map with — better to use our best-guess parsed
            # name than leave it with nothing to search for.
            data["scientific_name"] = scientific_name

        # Merge all three paper sources, deduping by a normalized title so
        # the same paper indexed in more than one source doesn't show up
        # twice. Capped at _MAX_PAPERS total.
        seen_titles = set()
        merged_papers = []
        for paper in openalex_papers + s2_papers + crossref_papers:
            key = paper["title"].strip().lower()
            if key in seen_titles:
                continue
            seen_titles.add(key)
            merged_papers.append(paper)
            if len(merged_papers) >= _MAX_PAPERS:
                break

        if merged_papers:
            data["research_papers"] = merged_papers

    if len(data) <= 1:
        data["error"] = "No information found for this species"

    # Always attach the debug trail (not just on total failure) — this is
    # what let us actually diagnose the papers-going-missing report
    # instead of guessing. Only consumed by devtools/network inspection;
    # the frontend modal doesn't render this field.
    data["_debug"] = debug_attempts

    data["_source"] = "wikipedia_obis_openalex_semanticscholar_crossref_inaturalist_bhl_iucn_europepmc_morphosource"
    _cache[species_name] = {"data": data, "cached_at": time.time()}
    return data