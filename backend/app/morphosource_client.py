from urllib.parse import quote_plus

# MorphoSource (morphosource.org) is a real, free, public repository of
# CT/micro-CT scans and other 3D specimen data — genuinely the right
# source for "anatomical/internal" imagery (Category 3). It does publish
# a REST API (github.com/MorphoSource/morphosource-api), but:
#   - the interactive docs are JS-rendered and the exact request/response
#     shape couldn't be confirmed from this environment
#   - downloading media requires a registered API key regardless
#   - the site itself notes an active migration to "MorphoSource 2.0"
#   - morphosource.org isn't reachable from this sandbox's network
#     egress allowlist, so nothing here could be live-tested
#
# Rather than ship an API integration built on guessed endpoints, this
# returns a search URL on MorphoSource's own site instead — a link-out,
# not an in-app gallery. Honesty caveat that applies to this too: the
# exact search path below (/catalog/media?q=) is inferred from Hyrax/
# Blacklight conventions (the framework MorphoSource is built on,
# per their own GitHub docs), NOT confirmed against a live response —
# same network-access limitation as the API itself. Worth a 30-second
# manual check (open the URL it generates for a real species name) before
# trusting it in production; if the path's wrong, MorphoSource's own
# homepage search box is the fallback.
#
# Coverage note: MorphoSource grew out of the openVertebrate (oVert)
# project, so it's strong for fish and other vertebrates but has very
# little coral/marine-invertebrate material — expect empty results for
# most coral species this app also detects.
def morphosource_search_url(scientific_name: str) -> str:
    return f"https://www.morphosource.org/catalog/media?q={quote_plus(scientific_name)}"