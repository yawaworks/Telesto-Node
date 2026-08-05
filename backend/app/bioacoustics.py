"""
Bioacoustic analysis for the Team Workspace: wraps Google's SurfPerch —
an EfficientNet-based embedding model from Google Research, specifically
domain-adapted for coral reef / marine bioacoustics on top of their bird
vocalization model Perch (https://www.kaggle.com/models/google/surfperch)
— to turn audio into embeddings, then finds moments in a longer
recording that sound acoustically similar to a short reference clip a
researcher provides (e.g. "this is what a snapping shrimp sounds like").

This is deliberately NOT framed as a species classifier. SurfPerch ships
embeddings, not calibrated marine-species labels — what's built here is
nearest-neighbor similarity search over those embeddings, the same core
technique Google's own perch-hoplite tooling is built around. Every
result is labeled "similarity search, not confirmed identification" for
the same reason the YOLO species detector and coral bleach classifier
elsewhere in this app carry "unvalidated model" tags: a resemblance
score is not a verified label, and presenting it as one would be
exactly the kind of overclaiming this project has deliberately avoided
everywhere else.

Real free-tier constraints, checked before writing this, not assumed:
  - ffmpeg is already installed via the backend Dockerfile (for GoPro
    GPMF metadata) — video audio-track extraction is NOT a new problem.
  - tensorflow-cpu + tensorflow-hub add real memory overhead on top of
    the OpenCV/Roboflow pipeline already running in this process on
    Render's free 512MB instance. This has NOT been load-tested against
    that ceiling — it may simply not fit alongside everything else this
    backend already does. Test locally with real audio before trusting
    it in production; if it doesn't fit, running this as an offline
    script (same pattern as validate_model.py) against downloaded clips
    is the fallback, not a live endpoint.
  - The model downloads from Kaggle Models on first use and stays
    cached in memory for the life of the process — the first request
    after a cold start will be slow (model fetch + load), not just the
    usual Render cold-start delay.
"""

import io
from typing import List, Tuple

import numpy as np

SAMPLE_RATE = 32000  # SurfPerch's expected input rate
WINDOW_SECONDS = 5  # SurfPerch embeds fixed 5-second windows

_model = None


def _get_model():
    """Lazily loads SurfPerch on first use, not at process import time —
    keeps this heavy dependency off the startup/import path for every
    other endpoint in the app that has nothing to do with audio, so a
    broken or slow model fetch can't take down unrelated routes."""
    global _model
    if _model is None:
        import tensorflow_hub as hub  # imported lazily for the same reason

        _model = hub.load("https://www.kaggle.com/models/google/surfperch/TensorFlow2/1/1")
    return _model


def load_waveform(audio_bytes: bytes) -> np.ndarray:
    """Decodes an uploaded audio file (wav/mp3/flac/m4a — anything
    librosa's soundfile/audioread backends support, which includes
    audio extracted from video via ffmpeg upstream) to a mono 32kHz
    waveform. Raises a plain ValueError on anything unreadable so the
    caller can turn it into a clean 400 instead of a raw stack trace."""
    import librosa  # lazy import, same reasoning as the model load

    try:
        waveform, _ = librosa.load(io.BytesIO(audio_bytes), sr=SAMPLE_RATE, mono=True)
    except Exception as exc:
        raise ValueError(f"Couldn't decode audio: {exc}")
    return waveform.astype(np.float32)


def embed_windows(waveform: np.ndarray) -> List[Tuple[float, np.ndarray]]:
    """Splits a waveform into fixed 5-second windows (zero-padding the
    final short window rather than dropping it) and returns
    (start_seconds, embedding) for each, pooled to a single vector per
    window."""
    model = _get_model()
    window_len = SAMPLE_RATE * WINDOW_SECONDS
    results = []

    for start_sample in range(0, len(waveform), window_len):
        chunk = waveform[start_sample : start_sample + window_len]
        if len(chunk) < window_len:
            chunk = np.pad(chunk, (0, window_len - len(chunk)))
        outputs = model.signatures["serving_default"](inputs=chunk[np.newaxis, :])
        embedding = np.asarray(outputs["output_0"])[0]
        # Pool any extra time/spatial dimensions down to one vector per window.
        embedding = embedding.reshape(-1, embedding.shape[-1]).mean(axis=0)
        results.append((start_sample / SAMPLE_RATE, embedding))

    return results


def cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
    denom = (np.linalg.norm(a) * np.linalg.norm(b)) or 1e-8
    return float(np.dot(a, b) / denom)


def find_similar_windows(
    waveform: np.ndarray,
    reference_embedding: np.ndarray,
    threshold: float = 0.6,
) -> List[dict]:
    """Compares every window of `waveform` against a single reference
    embedding, returning windows at or above `threshold` sorted by
    similarity, highest first. threshold=0.6 is a starting guess, not a
    calibrated value — expect to tune it against real labeled examples,
    the same honest gap already flagged for the YOLO detector's
    CONF_THRESHOLD (Section 10.3 of the plan doc)."""
    matches = []
    for start_seconds, embedding in embed_windows(waveform):
        score = cosine_similarity(embedding, reference_embedding)
        if score >= threshold:
            matches.append({"start_seconds": start_seconds, "score": score})
    return sorted(matches, key=lambda m: m["score"], reverse=True)


def embedding_to_list(embedding: np.ndarray) -> List[float]:
    return embedding.astype(float).tolist()


def embedding_from_list(values: List[float]) -> np.ndarray:
    return np.array(values, dtype=np.float32)