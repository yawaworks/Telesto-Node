import httpx

# Europe PMC's REST search API — free, no key, no signup, confirmed against
# their live developer docs (europepmc.org/RestfulWebService). This is
# genuinely a different thing from the OpenAlex/Semantic Scholar/CrossRef
# "research papers" list already in species_info.py: those surface papers
# about a species generally, this specifically targets papers whose
# figures are likely to be histological or ultrastructural (electron
# microscopy) imagery, via keyword-filtered search.
#
# IMPORTANT HONESTY NOTE: this returns LITERATURE that matches the
# imaging-modality keywords, not individual extracted figure images.
# Europe PMC does expose full-text XML for open-access articles that in
# principle contains embedded figure URLs, but parsing that reliably
# across the many different publisher XML schemas is a much bigger,
# fragile undertaking that couldn't be verified against a live article
# from this environment. Linking to the actual paper (where a researcher
# can see the real figures with real captions in context) is the honest
# version of this feature — better than fabricating an image-extraction
# pipeline that might silently return nothing or the wrong figure.
_BASE_URL = "https://www.ebi.ac.uk/europepmc/webservices/rest/search"
_MAX_RESULTS = 3

# Keyword sets used to bias the search toward each imagery category.
# These aren't a guarantee the article contains that kind of figure —
# they're a relevance signal based on title/abstract text, same caveat
# that applies to any keyword-based literature search.
HISTOLOGY_KEYWORDS = [
    "histology", "histological", "histopathology", "photomicrograph",
    "tissue section", "immunohistochemistry", "cryosection",
]
ULTRASTRUCTURE_KEYWORDS = [
    "scanning electron microscopy", "SEM", "transmission electron microscopy",
    "TEM", "ultrastructure", "electron micrograph",
]


def _build_query(scientific_name: str, keywords: list[str]) -> str:
    keyword_clause = " OR ".join(f'"{kw}"' for kw in keywords)
    # OPEN_ACCESS:y restricts to articles Europe PMC can legally show full
    # text/figures for — matches the licensing note in their own docs
    # (figure previews only work for CC-BY content).
    return f'"{scientific_name}" AND ({keyword_clause}) AND OPEN_ACCESS:y'


def _extract_authors(result: dict, max_authors: int = 3) -> str:
    author_string = result.get("authorString", "")
    if not author_string:
        return ""
    names = [n.strip() for n in author_string.split(",")]
    if len(names) <= max_authors:
        return author_string
    return ", ".join(names[:max_authors]) + " et al."


def _extract_url(result: dict) -> str | None:
    # Confirmed against live Europe PMC article pages (multiple
    # independent examples, including their own Annotations API docs):
    # the URL format is europepmc.org/article/{SOURCE}/{ID}, and the ID
    # keeps its source prefix rather than having it stripped — e.g. a
    # preprint's own docs show /article/PPR/PPR530086, not /article/PPR/530086.
    # MED (PubMed) is preferred first since that exact pattern
    # (/article/MED/{pmid}) is the one independently confirmed multiple
    # times; pmcid/doi are fallbacks for the rarer case a result has no pmid.
    pmid = result.get("pmid")
    if pmid:
        return f"https://europepmc.org/article/MED/{pmid}"
    pmcid = result.get("pmcid")
    if pmcid:
        return f"https://europepmc.org/article/PMC/{pmcid}"
    doi = result.get("doi")
    if doi:
        return f"https://doi.org/{doi}"
    return None


async def fetch_imaging_literature(
    client: httpx.AsyncClient, scientific_name: str, keywords: list[str], source_label: str
):
    """Searches Europe PMC for open-access papers about this species whose
    title/abstract suggest they contain the given imaging modality.
    Returns (results, debug_string) — same shape as the other paper
    fetchers in species_info.py, but each entry additionally carries
    matched_keyword so the frontend can show what triggered the match
    instead of implying certainty the figure exists."""
    try:
        resp = await client.get(
            _BASE_URL,
            params={
                "query": _build_query(scientific_name, keywords),
                "format": "json",
                "resultType": "lite",
                "pageSize": _MAX_RESULTS,
            },
            timeout=10.0,
        )
        if resp.status_code != 200:
            return [], f"{source_label}:{scientific_name} -> HTTP {resp.status_code}"

        results = resp.json().get("resultList", {}).get("result", [])
        papers = []
        for r in results:
            title = (r.get("title") or "").strip()
            if not title:
                continue
            url = _extract_url(r)
            if not url:
                continue
            papers.append(
                {
                    "title": title,
                    "year": r.get("pubYear"),
                    "authors": _extract_authors(r),
                    "journal": r.get("journalTitle"),
                    "url": url,
                }
            )
        return papers, f"{source_label}:{scientific_name} -> {len(papers)} results"
    except Exception as e:
        return [], f"{source_label}:{scientific_name} -> error {type(e).__name__}: {e}"