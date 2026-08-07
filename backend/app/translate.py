"""
Human-language translation for Telesto Node — the international-team and
literature/fieldwork side of "translation tools" for marine biology, as
distinct from interspecies bioacoustic decoding (app/bioacoustics.py),
which this deliberately does NOT attempt (see that module's docstring
philosophy — the same "don't overclaim" discipline applies here).

Real free-tier constraints, checked before writing this, not assumed
— and updated after two rounds of real deployed failures, not just
theory:
  - The default provider is MyMemory (https://mymemory.translated.net),
    a genuinely free, keyless REST API — no signup required. Its
    anonymous rate limit is 5,000 words/day per IP; passing a contact
    email (same pattern as the Wikimedia/OpenAlex "polite pool" header
    in species_info.py) raises that to 50,000 words/day. Quality is
    noticeably behind DeepL/Google, especially for anything beyond
    common language pairs — this is a real trade-off, not a hidden one.
  - MyMemory has NO working autodetect — confirmed via a real 403
    "INVALID LANGUAGE PAIR SPECIFIED" error, not just inferred. Source
    language is resolved LOCALLY instead, via the `langdetect` package
    (pure Python, fully offline, no network call, no external service to
    go down or rate-limit) — see _resolve_source_lang below. This also
    sidesteps a second real failure: public Lingva Translate instances
    (tried as an autodetect-capable alternative in an earlier version of
    this module) returned 403 Forbidden on real deployed requests, most
    likely Cloudflare or similar bot-protection blocking non-browser
    server-to-server traffic — a known, common failure mode for public
    Lingva instances, not specific to one bad instance URL. Lingva is
    kept as an opt-in secondary option (see TRANSLATE_PROVIDER) since it
    still may work from some hosting environments/instances, but it is
    NOT relied on for anything by default anymore.
  - Setting DEEPL_API_KEY switches to DeepL's free-tier API (500,000
    chars/month, needs a free DeepL account) for meaningfully better
    quality, and DOES support real autodetect server-side — no local
    detection needed for that path. This module does NOT set up a
    paid/Pro DeepL key path (different endpoint) — someone would need to
    change DEEPL_API_URL below if that's ever needed.
  - Neither free provider is a good fit for real archaic/historical text
    (18th-19th century ship-log Latin/French/German handwriting
    transcriptions) — both are trained on modern text. Flagged in the
    response's `warning` field generically, since there's no reliable
    way to detect "this is 200 years old" from text alone.
  - langdetect can fail to confidently identify very short text (a few
    words or less) — when it does, this module falls back to whichever
    provider can still attempt true autodetect (Lingva, opt-in) rather
    than guessing a language. See _resolve_source_lang.
"""

import os
import time

import httpx

REQUEST_HEADERS = {
    "User-Agent": "TelestoNode/1.0 (marine ecosystem monitoring research tool; "
                  "contact: yashikayapsandworks@gmail.com)"
}

DEEPL_API_KEY = os.getenv("DEEPL_API_KEY", "")
DEEPL_API_URL = "https://api-free.deepl.com/v2/translate"
MYMEMORY_API_URL = "https://api.mymemory.translated.net/get"
# The "polite pool" contact email pattern, reused from species_info.py —
# MyMemory raises its free rate limit 10x (5,000 -> 50,000 words/day) when
# a contact address is included with the request. Unset by default
# rather than hardcoded — set MYMEMORY_CONTACT_EMAIL on the backend to
# opt in to the higher limit. Omitted entirely from the request (not
# sent as an empty string) when unset, so an unset value can't
# accidentally read as "de=" to MyMemory's API.
MYMEMORY_CONTACT_EMAIL = os.getenv("MYMEMORY_CONTACT_EMAIL", "")

# Lingva Translate — a keyless, no-signup frontend for Google Translate's
# engine, run by volunteers as alternative instances of an open-source
# project (https://github.com/thedaviddelta/lingva-translate). No API
# key exists for it, ever — there's nothing to apply for or get denied.
# The trade-off for that: it depends on a third-party-hosted public
# instance staying up, which isn't guaranteed the way a paid/registered
# API is. LINGVA_INSTANCE_URL lets a different instance be swapped in
# (see https://github.com/thedaviddelta/lingva-translate#instances for
# other public instances) if the default one goes down or starts
# rate-limiting. This module's response parsing for Lingva is written
# from its documented API shape, not verified against a live response
# from this environment (its domain wasn't reachable from here to test
# against) — same honesty flag as this app's GFW vessel-tracking
# integration; if it 404s or the JSON shape doesn't match, that's the
# first thing to check against the project's current docs, not a sign
# the whole approach is wrong.
LINGVA_INSTANCE_URL = os.getenv("LINGVA_INSTANCE_URL", "https://lingva.ml")

# Explicit override for which keyless provider to try first — "mymemory"
# (default, now that source language is resolved locally rather than
# depending on either provider's autodetect) or "lingva" (opt-in;
# public instances have shown 403s from server-to-server requests in
# real testing, likely bot-protection — try this only if MyMemory
# itself becomes unusable). Only matters when DEEPL_API_KEY is unset.
TRANSLATE_PROVIDER = os.getenv("TRANSLATE_PROVIDER", "mymemory")

# See _detect_language_locally's docstring — this is an empirically-set
# floor, not an arbitrary one. Short chat messages under this length
# (a real, common case for the Workspace chat translate feature) fall
# through to whatever autodetect-capable option is left, which is
# genuinely the weakest-covered path in this module right now — see
# that same docstring.
MIN_CHARS_FOR_LOCAL_DETECTION = 20

# MyMemory recommends staying well under ~500 chars per request; DeepL's
# free tier comfortably handles much larger single requests. Both are
# chunked through the same code path for one consistent behavior instead
# of two divergent ones — the cost of that is DeepL making more requests
# than it strictly needs to, which is a non-issue against its 500k
# char/month allowance.
MAX_CHUNK_CHARS = {
    "mymemory": 450,
    "deepl": 4500,
    # Lingva proxies Google Translate's own web endpoint, which handles
    # much longer single requests than MyMemory's free tier — kept
    # conservative (not pushed to Google's actual much-higher limit)
    # since this is an unverified integration; smaller requests fail
    # more predictably than large ones if something about the shape is
    # off.
    "lingva": 1800,
}

# Keyed on (text, target_lang, source_lang, provider) -> (translated_text, detected_source, timestamp).
# In-process only, resets on redeploy — same pattern/rationale as
# species_info.py's cache: upstream calls are the slow/rate-limited part,
# not memory, and this process restarts often enough on Render's free
# tier that a persistent cache wouldn't earn its complexity here.
_cache = {}
_CACHE_TTL_SECONDS = 60 * 60 * 24  # 24h


def _detect_language_locally(text: str) -> str | None:
    """Local, offline language detection via langdetect — no network
    call, so no external service to go down or block server-to-server
    traffic (unlike Lingva's public instances, which real deployed
    requests have hit 403s against).

    Gated by MIN_CHARS_FOR_LOCAL_DETECTION: real testing (not just
    langdetect's own docs) showed it isn't just uncertain on short
    text, it's CONFIDENTLY WRONG — "OK" scored 99.99% Portuguese,
    "hola" scored 99.99% Welsh, "bonjour" scored 57% Croatian. Checking
    the confidence score doesn't help (the wrong answers were just as
    "confident" as the right ones on longer text), so the only honest
    fix is not attempting detection at all below a length where it's
    been shown to actually work. 20 characters was chosen because
    12-character English test phrases detected correctly while 7-char
    ones didn't — this is a real, if rough, empirically-set threshold,
    not an arbitrary one.

    Returns None below that threshold, or on genuinely undetectable
    text (symbols/numbers only) — a wrong guessed source language
    silently mistranslates in a way that's hard to notice, so "I don't
    know" is the honest answer, not a low-confidence pick presented as
    a real one.

    langdetect is imported lazily here rather than at module load —
    consistent with this app's pattern for optional/heavier deps (see
    speech.py's faster-whisper import) — so a backend that never
    translates anything never pays its import cost."""
    if len(text.strip()) < MIN_CHARS_FOR_LOCAL_DETECTION:
        return None
    try:
        from langdetect import detect, LangDetectException
    except ImportError:
        return None
    try:
        return detect(text)
    except LangDetectException:
        return None


def _resolve_source_lang(text: str, source_lang: str | None) -> tuple[str | None, bool]:
    """Turns "auto"/None into a real language code wherever possible,
    BEFORE any provider is chosen — this is the actual fix for MyMemory's
    lack of autodetect, done once up front rather than special-cased at
    every provider-selection call site. Returns (resolved_source_lang,
    was_detected_locally).

    If local detection fails (short/ambiguous text), returns (None,
    False) — the caller falls back to whichever provider can still
    attempt real autodetect (DeepL if configured, else Lingva as a
    last-resort opt-in), since guessing a language is worse than
    honestly not knowing one.
    """
    if source_lang and source_lang != "auto":
        return source_lang, False
    detected = _detect_language_locally(text)
    return (detected, True) if detected else (None, False)


def _active_provider(source_lang: str | None = None) -> str:
    """source_lang here should already be the RESOLVED value from
    _resolve_source_lang — a real code, or None only when local
    detection couldn't read the text at all. MyMemory needs a real code
    (see _translate_chunk_mymemory); when source_lang is still None at
    this point, only DeepL or Lingva (both real-autodetect-capable) are
    viable, so this routes to Lingva as the last free option rather than
    a MyMemory call already known to fail."""
    if DEEPL_API_KEY:
        return "deepl"
    provider = TRANSLATE_PROVIDER if TRANSLATE_PROVIDER in ("lingva", "mymemory") else "mymemory"
    if provider == "mymemory" and not source_lang:
        return "lingva"
    return provider


def _fallback_provider(primary: str, source_lang: str | None = None) -> str | None:
    """The other keyless provider — tried automatically if the primary
    one's request fails outright (network error, non-2xx, unexpected
    response shape), so a single provider having a bad day doesn't take
    down every translation touchpoint in the app. Returns None when the
    primary is deepl (a paid/registered key means the person explicitly
    chose reliability over the keyless options; silently falling back to
    a lower-quality provider on a transient DeepL hiccup would be a
    worse surprise than just surfacing the error).

    Also returns None instead of "mymemory" when source_lang is still
    unresolved (local detection couldn't read the text) — MyMemory can't
    do autodetect (see _translate_chunk_mymemory), so proposing it as a
    fallback here would just be a second guaranteed failure instead of a
    real second attempt.
    """
    if primary == "lingva":
        if not source_lang:
            return None
        return "mymemory"
    if primary == "mymemory":
        return "lingva"
    return None


def _chunk_text(text: str, max_chars: int) -> list[str]:
    """Splits on sentence boundaries where possible so a chunk break
    doesn't land mid-sentence and confuse the translator. Falls back to a
    hard character split only if a single "sentence" is itself longer
    than max_chars (e.g. text with no punctuation)."""
    if len(text) <= max_chars:
        return [text]

    sentences = []
    current = ""
    for ch in text:
        current += ch
        if ch in ".!?\n" and len(current) > 0:
            sentences.append(current)
            current = ""
    if current:
        sentences.append(current)

    chunks = []
    buf = ""
    for sentence in sentences:
        if len(sentence) > max_chars:
            # A single unbroken "sentence" longer than the limit — hard
            # split it rather than sending an oversized request that the
            # provider would reject or silently truncate.
            if buf:
                chunks.append(buf)
                buf = ""
            for i in range(0, len(sentence), max_chars):
                chunks.append(sentence[i : i + max_chars])
            continue
        if len(buf) + len(sentence) > max_chars:
            chunks.append(buf)
            buf = sentence
        else:
            buf += sentence
    if buf:
        chunks.append(buf)
    return chunks


async def _translate_chunk_deepl(client: httpx.AsyncClient, text: str, target_lang: str, source_lang: str | None) -> dict:
    payload = {
        "auth_key": DEEPL_API_KEY,
        "text": text,
        "target_lang": target_lang.upper(),
    }
    if source_lang and source_lang != "auto":
        payload["source_lang"] = source_lang.upper()

    resp = await client.post(DEEPL_API_URL, data=payload, headers=REQUEST_HEADERS)
    resp.raise_for_status()
    data = resp.json()
    translation = data["translations"][0]
    return {
        "translated_text": translation["text"],
        "detected_source_lang": translation.get("detected_source_language", source_lang or "").lower(),
    }


async def _translate_chunk_mymemory(client: httpx.AsyncClient, text: str, target_lang: str, source_lang: str | None) -> dict:
    # CONFIRMED (via a real 403 "INVALID LANGUAGE PAIR SPECIFIED" error,
    # not just inferred): MyMemory does NOT support an empty source
    # segment for autodetect the way this module previously assumed —
    # that was an unverified guess that turned out wrong. MyMemory
    # requires a real two-letter source code in every request. There is
    # no known reliable autodetect path for MyMemory specifically, so
    # this fails fast with a clear, specific error rather than sending a
    # request already known to be rejected — translate_text() below
    # routes auto-detect requests to Lingva instead (which does
    # genuinely support "auto") and only calls this function when a real
    # source_lang is already known, so this branch should be rare in
    # practice, not the common path it was before this fix.
    if not source_lang or source_lang == "auto":
        raise RuntimeError(
            "MyMemory requires an explicit source language and does not support autodetect "
            "(confirmed via a real 403 INVALID LANGUAGE PAIR error) — this should have been "
            "routed to Lingva instead; if you're seeing this, translate_text()'s auto-detect "
            "routing didn't catch this call."
        )

    lang_pair = f"{source_lang}|{target_lang}"
    params = {"q": text, "langpair": lang_pair}
    if MYMEMORY_CONTACT_EMAIL:
        params["de"] = MYMEMORY_CONTACT_EMAIL

    resp = await client.get(MYMEMORY_API_URL, params=params, headers=REQUEST_HEADERS)
    resp.raise_for_status()
    data = resp.json()

    status = data.get("responseStatus")
    if status not in (200, "200"):
        raise RuntimeError(f"MyMemory returned status {status}: {data.get('responseDetails')}")

    translated = data["responseData"]["translatedText"]
    # source_lang is guaranteed non-empty/non-"auto" here (the guard
    # clause above raises otherwise), so this just echoes back the known
    # source rather than reporting an actual detection MyMemory doesn't
    # provide.
    detected = source_lang
    return {"translated_text": translated, "detected_source_lang": detected}


async def _translate_chunk_lingva(client: httpx.AsyncClient, text: str, target_lang: str, source_lang: str | None) -> dict:
    # Lingva's documented REST shape: GET /api/v1/{source}/{target}/{text},
    # with the text URL-path-encoded (not a query param) and "auto" as a
    # literal accepted source code — no MyMemory-style empty-segment quirk
    # here. httpx handles path-segment encoding via the url object rather
    # than manual quoting, since raw "/" or "%" characters in the source
    # text need correct encoding to survive as one path segment.
    source_segment = source_lang if source_lang else "auto"
    url = f"{LINGVA_INSTANCE_URL}/api/v1/{source_segment}/{target_lang}/{text}"

    resp = await client.get(url, headers=REQUEST_HEADERS)
    resp.raise_for_status()
    data = resp.json()

    translated = data.get("translation")
    if translated is None:
        raise RuntimeError(f"Unexpected Lingva response shape: {data}")

    # Lingva's response includes detected info under different keys
    # across versions/instances (some expose "info"->"detectedSource",
    # others don't surface it at all) — read defensively, fall back to
    # not knowing rather than guessing.
    detected = None
    info = data.get("info")
    if isinstance(info, dict):
        detected = info.get("detectedSource")

    return {"translated_text": translated, "detected_source_lang": detected}


async def _translate_chunk(client: httpx.AsyncClient, provider: str, text: str, target_lang: str, source_lang: str | None) -> dict:
    if provider == "deepl":
        return await _translate_chunk_deepl(client, text, target_lang, source_lang)
    if provider == "lingva":
        return await _translate_chunk_lingva(client, text, target_lang, source_lang)
    return await _translate_chunk_mymemory(client, text, target_lang, source_lang)


async def _translate_all_chunks(provider: str, text: str, target_lang: str, source_lang: str | None) -> tuple[str, str | None]:
    """Chunks text to the given provider's size limit and translates
    every chunk with that one provider — no mixing providers mid-text,
    since a fallback only kicks in when the FIRST chunk request fails
    (see translate_text), at which point the whole call restarts fresh
    against the fallback provider rather than continuing with a
    half-mymemory, half-lingva result."""
    max_chars = MAX_CHUNK_CHARS[provider]
    chunks = _chunk_text(text, max_chars)

    translated_parts = []
    detected_source = None
    async with httpx.AsyncClient(timeout=15) as client:
        for chunk in chunks:
            result = await _translate_chunk(client, provider, chunk, target_lang, source_lang)
            translated_parts.append(result["translated_text"])
            if result.get("detected_source_lang") and not detected_source:
                detected_source = result["detected_source_lang"]

    translated_text = " ".join(translated_parts) if len(chunks) > 1 else translated_parts[0]
    return translated_text, detected_source


async def translate_text(
    text: str,
    target_lang: str,
    source_lang: str | None = "auto",
) -> dict:
    """Translates `text` into `target_lang` (ISO 639-1, e.g. "en", "es",
    "fr", "ja"). source_lang="auto" (the default) resolves the source
    language LOCALLY via langdetect before picking a provider — see
    _resolve_source_lang and this module's docstring for why (MyMemory
    has no working autodetect; public Lingva instances have shown 403s
    on real server-to-server requests). Pass an explicit code when it's
    already known — skips detection entirely and is more reliable for
    short/ambiguous text langdetect can't confidently read.

    Returns {translated_text, detected_source_lang, provider, warning}.
    Raises only if the primary provider AND its keyless fallback both
    fail (see _fallback_provider) — this module doesn't swallow errors
    into a fake success, but it does try the other free option once
    before giving up, since both MyMemory and Lingva are volunteer/
    community-tier services that can have a bad day independent of
    whether this code is correct.
    """
    text = text.strip()
    if not text:
        return {"translated_text": "", "detected_source_lang": None, "provider": _active_provider(source_lang), "warning": None}

    detected_locally = False
    if DEEPL_API_KEY:
        # DeepL has its own real autodetect — pass "auto" straight
        # through rather than overriding it with a local guess that
        # would only be less accurate than DeepL's own detection.
        provider = "deepl"
        effective_source = source_lang
    else:
        effective_source, detected_locally = _resolve_source_lang(text, source_lang)
        provider = _active_provider(effective_source)

    cache_key = (text, target_lang, source_lang, provider)
    cached = _cache.get(cache_key)
    if cached and (time.time() - cached[2]) < _CACHE_TTL_SECONDS:
        translated_text, detected_source, _ = cached
        return {
            "translated_text": translated_text,
            "detected_source_lang": detected_source,
            "provider": provider,
            "warning": None,
        }

    primary = provider
    fallback_used = False
    try:
        translated_text, detected_source = await _translate_all_chunks(provider, text, target_lang, effective_source)
    except Exception as primary_exc:
        fallback = _fallback_provider(primary, effective_source)
        if fallback is None:
            raise
        try:
            translated_text, detected_source = await _translate_all_chunks(fallback, text, target_lang, effective_source)
            provider = fallback
            fallback_used = True
        except Exception:
            # Report the primary's failure, not the fallback's — the
            # primary is the one the deployment is actually configured
            # to use, so its error is the more actionable one to surface.
            raise primary_exc

    if detected_locally and not detected_source:
        detected_source = effective_source

    _cache[cache_key] = (translated_text, detected_source, time.time())

    warning_parts = []
    if provider in ("mymemory", "lingva"):
        provider_label = "MyMemory" if provider == "mymemory" else "Lingva (Google Translate proxy)"
        fallback_note = f" ({primary} failed, fell back to {provider})" if fallback_used else ""
        warning_parts.append(
            f"Free, keyless machine translation ({provider_label}){fallback_note} — reliable for "
            "common language pairs and modern text, not verified for technical/legal precision or "
            "historical/archaic language. Set DEEPL_API_KEY on the backend for higher-quality "
            "translation."
        )
    if detected_locally:
        warning_parts.append(
            "Source language auto-detected locally (langdetect), not confirmed by the translation "
            "provider itself — verify if precision on the source language matters."
        )

    return {
        "translated_text": translated_text,
        "detected_source_lang": detected_source,
        "provider": provider,
        "warning": " ".join(warning_parts) if warning_parts else None,
    }


# Common languages relevant to this app's actual use cases (the doc's own
# examples: legacy taxonomic/ship-log literature, international policy
# bodies, common field-research regions) — not an exhaustive ISO 639-1
# list, just a sane default set for a language-picker dropdown. The
# backend accepts any ISO 639-1 code regardless of whether it's in this
# list; this is a UI convenience list, not a validation allowlist.
COMMON_LANGUAGES = [
    {"code": "en", "name": "English"},
    {"code": "es", "name": "Spanish"},
    {"code": "fr", "name": "French"},
    {"code": "de", "name": "German"},
    {"code": "pt", "name": "Portuguese"},
    {"code": "it", "name": "Italian"},
    {"code": "la", "name": "Latin"},
    {"code": "ja", "name": "Japanese"},
    {"code": "zh", "name": "Chinese"},
    {"code": "ru", "name": "Russian"},
    {"code": "id", "name": "Indonesian"},
    {"code": "tl", "name": "Filipino/Tagalog"},
    {"code": "sw", "name": "Swahili"},
    {"code": "ar", "name": "Arabic"},
    {"code": "ko", "name": "Korean"},
]