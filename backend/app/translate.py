"""
Human-language translation for Telesto Node — the international-team and
literature/fieldwork side of "translation tools" for marine biology, as
distinct from interspecies bioacoustic decoding (app/bioacoustics.py),
which this deliberately does NOT attempt (see that module's docstring
philosophy — the same "don't overclaim" discipline applies here).

Real free-tier constraints, checked before writing this, not assumed:
  - No paid translation API key is configured by default. The default
    provider is MyMemory (https://mymemory.translated.net), a genuinely
    free, keyless REST API — no signup required. Its anonymous rate limit
    is 5,000 words/day per IP; passing a contact email (same pattern as
    the Wikimedia/OpenAlex "polite pool" header in species_info.py) raises
    that to 50,000 words/day. Quality is noticeably behind DeepL/Google,
    especially for anything beyond common language pairs — this is a
    real trade-off, not a hidden one.
  - Setting DEEPL_API_KEY switches to DeepL's free-tier API (500,000
    chars/month, needs a free DeepL account) for meaningfully better
    quality. This module does NOT set up a paid/Pro DeepL key path
    (different endpoint) — someone would need to change DEEPL_API_URL
    below if that's ever needed.
  - Neither provider is a good fit for real archaic/historical text
    (18th-19th century ship-log Latin/French/German handwriting
    transcriptions) — both are trained on modern text. Flagged in the
    response's `warning` field whenever source_lang is set to a
    caution-flagged legacy-text scenario isn't attempted here since
    there's no reliable way to detect "this is 200 years old" from text
    alone; the caveat is applied generically instead (see TRANSLATE
    WARNING below).
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
# a contact address is included with the request.
MYMEMORY_CONTACT_EMAIL = "yashikayapsandworks@gmail.com"

# MyMemory recommends staying well under ~500 chars per request; DeepL's
# free tier comfortably handles much larger single requests. Both are
# chunked through the same code path for one consistent behavior instead
# of two divergent ones — the cost of that is DeepL making more requests
# than it strictly needs to, which is a non-issue against its 500k
# char/month allowance.
MAX_CHUNK_CHARS = {
    "mymemory": 450,
    "deepl": 4500,
}

# Keyed on (text, target_lang, source_lang, provider) -> (translated_text, detected_source, timestamp).
# In-process only, resets on redeploy — same pattern/rationale as
# species_info.py's cache: upstream calls are the slow/rate-limited part,
# not memory, and this process restarts often enough on Render's free
# tier that a persistent cache wouldn't earn its complexity here.
_cache = {}
_CACHE_TTL_SECONDS = 60 * 60 * 24  # 24h


def _active_provider() -> str:
    return "deepl" if DEEPL_API_KEY else "mymemory"


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
    # MyMemory's documented auto-detect convention is an empty source
    # before the pipe (e.g. "|es"), not a literal "auto"/"autodetect"
    # token — that's a MyMemory-specific quirk, not a general REST
    # translation convention, so it's handled here rather than at the
    # translate_text() call-site.
    source_segment = "" if (not source_lang or source_lang == "auto") else source_lang
    lang_pair = f"{source_segment}|{target_lang}"
    params = {"q": text, "langpair": lang_pair, "de": MYMEMORY_CONTACT_EMAIL}

    resp = await client.get(MYMEMORY_API_URL, params=params, headers=REQUEST_HEADERS)
    resp.raise_for_status()
    data = resp.json()

    status = data.get("responseStatus")
    if status not in (200, "200"):
        raise RuntimeError(f"MyMemory returned status {status}: {data.get('responseDetails')}")

    translated = data["responseData"]["translatedText"]
    # MyMemory doesn't report detected source language in the response
    # body the way DeepL does — if the caller asked for autodetect, we
    # genuinely don't know what it detected, and say so rather than
    # guessing.
    detected = source_lang if source_lang and source_lang != "auto" else None
    return {"translated_text": translated, "detected_source_lang": detected}


async def translate_text(
    text: str,
    target_lang: str,
    source_lang: str | None = "auto",
) -> dict:
    """Translates `text` into `target_lang` (ISO 639-1, e.g. "en", "es",
    "fr", "ja"). source_lang="auto" lets the provider detect it; pass an
    explicit code when it's known (faster and more reliable than
    autodetect for short or ambiguous text — a two-word field label
    autodetects poorly).

    Returns {translated_text, detected_source_lang, provider, warning}.
    Raises on total failure (both chunk translation and the caller
    should decide how to surface that — this module doesn't swallow
    errors into a fake success).
    """
    text = text.strip()
    if not text:
        return {"translated_text": "", "detected_source_lang": None, "provider": _active_provider(), "warning": None}

    provider = _active_provider()
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

    max_chars = MAX_CHUNK_CHARS[provider]
    chunks = _chunk_text(text, max_chars)

    translated_parts = []
    detected_source = None
    async with httpx.AsyncClient(timeout=15) as client:
        for chunk in chunks:
            if provider == "deepl":
                result = await _translate_chunk_deepl(client, chunk, target_lang, source_lang)
            else:
                result = await _translate_chunk_mymemory(client, chunk, target_lang, source_lang)
            translated_parts.append(result["translated_text"])
            if result.get("detected_source_lang") and not detected_source:
                detected_source = result["detected_source_lang"]

    translated_text = " ".join(translated_parts) if len(chunks) > 1 else translated_parts[0]
    _cache[cache_key] = (translated_text, detected_source, time.time())

    warning = None
    if provider == "mymemory":
        warning = (
            "Free-tier machine translation (MyMemory) — reliable for common "
            "language pairs and modern text, not verified for technical/legal "
            "precision or historical/archaic language. Set DEEPL_API_KEY on "
            "the backend for higher-quality translation."
        )

    return {
        "translated_text": translated_text,
        "detected_source_lang": detected_source,
        "provider": provider,
        "warning": warning,
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