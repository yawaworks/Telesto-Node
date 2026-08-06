"""
Speech-to-text for the fieldwork/interview translator — transcribes
recorded speech so the text can be fed straight into app/translate.py.
Third and last of the three human-language translation touchpoints
(chat, Species Inspector, this).

Uses faster-whisper (a CTranslate2 reimplementation of OpenAI's Whisper).
The MODEL is free and open-weight — no API key, no account, no
per-request charge. That's different from OpenAI's hosted Whisper API,
which does bill per minute; this runs entirely in-process on the backend
instead, the same way SurfPerch and the YOLO detector already do.

Real free-tier constraint, checked before writing this, not assumed:
Render's free tier caps out around 512MB RAM, and this backend already
loads YOLO and SurfPerch on demand. Whisper's "tiny" model (~75MB of
weights, ~39M parameters, int8-quantized here) is the only size with a
realistic chance of coexisting with those on a free instance — "base"
and larger are meaningfully bigger and untested in this deployment.
Lazy-loaded on first request, same pattern as the other two models, so
an app that never opens the translator never pays the memory cost. Set
WHISPER_MODEL_SIZE to move up to "base" or "small" if the instance has
more headroom than Render's free tier (a paid Render plan, or self-host).

Honest quality expectation: Whisper "tiny" is noticeably behind "small"
or "medium" on accented speech, background noise, and non-English
audio — exactly the wind/boat-engine/surf conditions real fieldwork
interviews happen in. This is the free/lightweight end of a genuine
quality-vs-resource trade-off, not a hidden limitation.
"""

import io
import os

import numpy as np

WHISPER_SAMPLE_RATE = 16000  # Whisper's fixed expected input rate — not SurfPerch's 32kHz
WHISPER_MODEL_SIZE = os.getenv("WHISPER_MODEL_SIZE", "tiny")

_model = None


def _get_model():
    """Lazy singleton — faster-whisper isn't imported or loaded until the
    first actual transcription request, so the backend's baseline memory
    footprint (with YOLO/SurfPerch also lazy-loaded) doesn't include it
    unless the fieldwork translator is actually opened."""
    global _model
    if _model is None:
        from faster_whisper import WhisperModel

        _model = WhisperModel(WHISPER_MODEL_SIZE, device="cpu", compute_type="int8")
    return _model


def _load_waveform_16k(audio_bytes: bytes) -> np.ndarray:
    """Decodes uploaded audio to mono 16kHz — Whisper's fixed expected
    rate, different from SurfPerch's 32kHz (app/bioacoustics.py has its
    own loader at that rate; this one is intentionally separate rather
    than shared, since the two models need different sample rates)."""
    import librosa

    try:
        waveform, _ = librosa.load(io.BytesIO(audio_bytes), sr=WHISPER_SAMPLE_RATE, mono=True)
    except Exception as exc:
        raise ValueError(f"Couldn't decode audio: {exc}")
    return waveform.astype(np.float32)


def transcribe_audio(audio_bytes: bytes, language: str | None = None) -> dict:
    """Transcribes recorded speech to text.

    language: an ISO 639-1 code if known (e.g. "en", "tl") — skips
    Whisper's own language-detection pass and is both faster and more
    reliable for short clips, which autodetect handles poorly. Leave
    None to let Whisper detect it (reported back in detected_language).

    Returns {text, detected_language, duration_seconds, model_size}.
    Raises ValueError on undecodable audio, RuntimeError on transcription
    failure — the caller turns either into a clean HTTP error rather than
    a raw stack trace, same pattern as app/bioacoustics.py's routes."""
    waveform = _load_waveform_16k(audio_bytes)
    duration_seconds = len(waveform) / WHISPER_SAMPLE_RATE

    try:
        model = _get_model()
        segments, info = model.transcribe(
            waveform,
            language=language,
            beam_size=1,  # greedy-ish decoding — speed over marginal accuracy gains on CPU
            vad_filter=True,  # skips silence, which fieldwork recordings (mic left running) tend to have plenty of
        )
        text = " ".join(segment.text.strip() for segment in segments).strip()
    except Exception as exc:
        raise RuntimeError(f"Transcription failed: {exc}")

    return {
        "text": text,
        "detected_language": info.language,
        "duration_seconds": duration_seconds,
        "model_size": WHISPER_MODEL_SIZE,
    }