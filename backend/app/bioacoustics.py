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


# ---------------------------------------------------------------------------
# Soundscape & signal-level metrics.
#
# Everything below this line is plain numpy/scipy signal processing on the
# raw waveform — none of it touches SurfPerch. That's a deliberate split:
# these numbers are directly computed from the audio's actual energy and
# frequency content, not model output, so they carry a fundamentally
# different confidence level than the similarity-search matches above.
# The UI is expected to label these as "measured from this recording", the
# same way real telemetry is styled differently from simulated telemetry
# and model detections elsewhere in this app.
#
# IMPORTANT CALIBRATION CAVEAT: true Sound Pressure Level (dB re 1 uPa)
# requires knowing the hydrophone's sensitivity (dB re 1V/uPa) and the
# recording chain's gain — neither of which is recoverable from a generic
# uploaded audio file. Every level computed here is relative (dBFS, full
# scale = 0 dB) unless the caller supplies calibration_offset_db, in which
# case SPL_calibrated = dBFS + calibration_offset_db. Without that offset,
# these numbers are directly comparable to each other (same recording
# chain, same session) but NOT to another hydrophone's numbers, and
# should never be presented to a researcher as calibrated SPL.
# ---------------------------------------------------------------------------

# NDSI band convention used throughout, from Kasten et al. 2012 (the paper
# that introduced NDSI) — anthrophony 0.2-2kHz, biophony 2-8kHz. This is
# the same convention referenced in the plan doc's own NDSI section.
ANTHROPHONY_BAND_HZ = (200, 2000)
BIOPHONY_BAND_HZ = (2000, 8000)

# There is no standard geophony frequency band in the ecoacoustics
# literature the way there is for NDSI's bio/anthro split — geophony
# (wind, rain, surf, seismic/ice noise) occupies a wide and
# environment-dependent range that commonly overlaps anthrophony below
# ~200 Hz. This low band is a provisional convention for this app only,
# not a validated standard, and is labeled as such everywhere it's
# returned. Real geophony attribution would need auxiliary data (wind
# speed, sea state) this app doesn't have.
GEOPHONY_BAND_HZ = (10, 200)


def _band_energy(psd: np.ndarray, freqs: np.ndarray, band: Tuple[float, float]) -> float:
    """Sums linear power within [band[0], band[1]) Hz from a PSD array."""
    mask = (freqs >= band[0]) & (freqs < band[1])
    if not np.any(mask):
        return 0.0
    return float(np.sum(psd[mask]))


def compute_psd(waveform: np.ndarray, sr: int = SAMPLE_RATE) -> dict:
    """Power Spectral Density via Welch's method — the standard estimator
    for PSD (averages overlapping FFT segments to reduce variance vs a
    single raw FFT). Returns linear PSD (for band-energy math elsewhere)
    plus a dB re 1 (dBFS-relative) version for display.

    nperseg=4096 gives ~7.8 Hz frequency resolution at 32kHz — coarse
    enough to be stable on short clips, fine enough to separate the
    biophony/anthrophony bands cleanly.
    """
    from scipy.signal import welch

    nperseg = min(4096, len(waveform)) or 1
    freqs, psd = welch(waveform, fs=sr, nperseg=nperseg)
    psd_db = 10 * np.log10(psd + 1e-20)
    return {"freqs": freqs, "psd": psd, "psd_db": psd_db}


def compute_spectrogram(waveform: np.ndarray, sr: int = SAMPLE_RATE, n_fft: int = 1024, hop_length: int = 512):
    """STFT magnitude spectrogram (frequency x time), used by the
    time-varying indices below (ACI, entropy, ADI/AEI). Uses scipy
    directly rather than librosa.stft so this module only needs scipy —
    librosa is still used elsewhere in this file for audio decoding."""
    from scipy.signal import stft

    freqs, times, Zxx = stft(waveform, fs=sr, nperseg=n_fft, noverlap=n_fft - hop_length)
    magnitude = np.abs(Zxx)
    return freqs, times, magnitude


def compute_relative_spl(waveform: np.ndarray, calibration_offset_db: float | None = None) -> dict:
    """RMS and peak level in dBFS (0 dB = full scale, negative = quieter).
    If calibration_offset_db is provided (the hydrophone's known
    sensitivity-derived offset), also returns a calibrated SPL re 1 uPa.
    Otherwise spl_calibrated is None and the caller MUST present these as
    relative levels, not absolute SPL — see the module-level caveat."""
    rms = float(np.sqrt(np.mean(waveform.astype(np.float64) ** 2)) + 1e-12)
    peak = float(np.max(np.abs(waveform)) + 1e-12)
    rms_dbfs = 20 * np.log10(rms)
    peak_dbfs = 20 * np.log10(peak)
    return {
        "rms_dbfs": rms_dbfs,
        "peak_dbfs": peak_dbfs,
        "spl_calibrated_db": (rms_dbfs + calibration_offset_db) if calibration_offset_db is not None else None,
        "calibrated": calibration_offset_db is not None,
    }


def compute_percentile_levels(waveform: np.ndarray, sr: int = SAMPLE_RATE, window_ms: float = 1000.0) -> dict:
    """L10/L50/L90 — the level exceeded 10%/50%/90% of the time, computed
    from short-time RMS (dBFS) over non-overlapping windows across the
    whole clip. L10 captures loud transients, L90 approximates the
    continuous background floor; the gap between them (L10 - L90) is a
    quick read on how "spiky" vs. steady the recording is."""
    window_len = max(1, int(sr * window_ms / 1000.0))
    n_windows = max(1, len(waveform) // window_len)
    levels = []
    for i in range(n_windows):
        chunk = waveform[i * window_len : (i + 1) * window_len]
        if len(chunk) == 0:
            continue
        rms = float(np.sqrt(np.mean(chunk.astype(np.float64) ** 2)) + 1e-12)
        levels.append(20 * np.log10(rms))
    if not levels:
        return {"l10_db": None, "l50_db": None, "l90_db": None, "windows": 0}
    levels = np.array(levels)
    return {
        # Exceeded 10% of the time == the 90th percentile of the level
        # distribution (higher percentile = louder, exceeded less often).
        "l10_db": float(np.percentile(levels, 90)),
        "l50_db": float(np.percentile(levels, 50)),
        "l90_db": float(np.percentile(levels, 10)),
        "windows": len(levels),
    }


def compute_ndsi(waveform: np.ndarray, sr: int = SAMPLE_RATE) -> dict:
    """Normalized Difference Soundscape Index: (biophony - anthrophony) /
    (biophony + anthrophony), using the Kasten et al. 2012 band
    convention (2-8kHz biophony, 0.2-2kHz anthrophony). +1 = purely
    biophonic, -1 = dominated by low-frequency human noise. Also returns
    a provisional geophony reading from GEOPHONY_BAND_HZ — see the
    module-level note on why that band isn't a validated standard."""
    psd_result = compute_psd(waveform, sr)
    freqs, psd = psd_result["freqs"], psd_result["psd"]

    bio = _band_energy(psd, freqs, BIOPHONY_BAND_HZ)
    anthro = _band_energy(psd, freqs, ANTHROPHONY_BAND_HZ)
    geo = _band_energy(psd, freqs, GEOPHONY_BAND_HZ)
    total = bio + anthro + geo

    denom = (bio + anthro) or 1e-20
    ndsi = (bio - anthro) / denom

    return {
        "ndsi": float(ndsi),
        "biophony_fraction": float(bio / total) if total else None,
        "anthrophony_fraction": float(anthro / total) if total else None,
        "geophony_fraction_provisional": float(geo / total) if total else None,
        "geophony_band_is_provisional": True,
    }


def compute_bioacoustic_index(waveform: np.ndarray, sr: int = SAMPLE_RATE, band: Tuple[float, float] = BIOPHONY_BAND_HZ) -> float:
    """Bioacoustic Index (Boelman et al. 2007): area under the PSD curve
    within `band`, above that band's own minimum dB level, in dB. A proxy
    for vocal-animal abundance/activity within the band — higher means
    more consistently energetic biological sound, not more species."""
    psd_result = compute_psd(waveform, sr)
    freqs, psd_db = psd_result["freqs"], psd_result["psd_db"]
    mask = (freqs >= band[0]) & (freqs < band[1])
    if not np.any(mask):
        return 0.0
    band_db = psd_db[mask]
    band_freqs = freqs[mask]
    floor = np.min(band_db)
    # Trapezoidal area of (level - floor) across the band's frequency bins.
    # Computed by hand rather than via np.trapz/np.trapezoid since that
    # function's name changed between numpy major versions (trapz was
    # removed in numpy 2.x in favor of trapezoid) — this pins the app to
    # nothing but basic array ops regardless of which numpy is installed.
    heights = band_db - floor
    widths = np.diff(band_freqs)
    if len(widths) == 0:
        return 0.0
    return float(np.sum((heights[:-1] + heights[1:]) / 2.0 * widths))


def compute_acoustic_complexity_index(waveform: np.ndarray, sr: int = SAMPLE_RATE) -> float:
    """ACI (Pieretti et al. 2011): sums the absolute frame-to-frame
    change in amplitude within each frequency bin, normalized by that
    bin's total amplitude, then summed across bins. High ACI = lots of
    irregular amplitude fluctuation over time (a busy biological chorus);
    a low, steady tone or continuous noise yields low ACI."""
    _, _, magnitude = compute_spectrogram(waveform, sr)
    if magnitude.shape[1] < 2:
        return 0.0
    diffs = np.abs(np.diff(magnitude, axis=1))
    bin_sums = np.sum(magnitude[:, 1:], axis=1)
    bin_sums = np.where(bin_sums == 0, 1e-20, bin_sums)
    aci_per_bin = np.sum(diffs, axis=1) / bin_sums
    return float(np.sum(aci_per_bin))


def compute_acoustic_entropy(waveform: np.ndarray, sr: int = SAMPLE_RATE) -> dict:
    """Acoustic entropy (Sueur et al. 2008): spectral entropy Hf (energy
    distribution across frequency bins, averaged over time) and temporal
    entropy Ht (energy distribution across time, averaged over frequency
    bins), each a normalized Shannon entropy in [0, 1]. Overall H = Ht *
    Hf. A single pure tone yields low Hf; a broadband chorus of many
    species yields high Hf. A constant drone yields low Ht; an
    intermittent, bursty soundscape yields high Ht."""
    _, _, magnitude = compute_spectrogram(waveform, sr)
    power = magnitude ** 2

    def _normalized_entropy(dist: np.ndarray) -> float:
        dist = dist / (np.sum(dist) + 1e-20)
        dist = dist[dist > 0]
        if len(dist) <= 1:
            return 0.0
        entropy = -np.sum(dist * np.log(dist))
        return float(entropy / np.log(len(dist)))

    spectral_profile = np.mean(power, axis=1)  # energy per frequency bin
    temporal_profile = np.mean(power, axis=0)  # energy per time frame

    hf = _normalized_entropy(spectral_profile)
    ht = _normalized_entropy(temporal_profile)
    return {"spectral_entropy_hf": hf, "temporal_entropy_ht": ht, "total_entropy_h": hf * ht}


def compute_diversity_evenness(
    waveform: np.ndarray,
    sr: int = SAMPLE_RATE,
    band_width_hz: float = 1000.0,
    max_freq_hz: float = 12000.0,
    db_threshold: float = -50.0,
) -> dict:
    """ADI / AEI, following the Villanueva-Rivera et al. 2011 approach:
    split [0, max_freq_hz) into band_width_hz-wide bins, and within each
    bin measure the proportion of spectrogram frames where that bin's
    level exceeds db_threshold below the bin's own peak. ADI is the
    Shannon diversity of those proportions across bins (higher = energy
    spread more evenly across many bands = acoustically richer);
    AEI is Pielou's evenness (ADI normalized by the maximum possible
    diversity for that many bins), in [0, 1] — closer to 1 means bands
    are contributing near-equally, closer to 0 means one or two bands
    dominate.

    db_threshold=-50 is the value used in the original ADI/AEI papers as
    a reasonable default, not something tuned against this app's data —
    treat it as a starting point, same as the YOLO confidence slider."""
    freqs, _, magnitude = compute_spectrogram(waveform, sr)
    magnitude_db = 20 * np.log10(magnitude + 1e-12)

    bands = np.arange(0, max_freq_hz, band_width_hz)
    proportions = []
    for low in bands:
        high = low + band_width_hz
        mask = (freqs >= low) & (freqs < high)
        if not np.any(mask):
            proportions.append(0.0)
            continue
        band_db = magnitude_db[mask, :]
        peak = np.max(band_db)
        active = np.mean(band_db >= (peak - abs(db_threshold)))
        proportions.append(float(active))

    proportions = np.array(proportions)
    total = np.sum(proportions)
    if total <= 0:
        return {"adi": 0.0, "aei": 0.0, "band_width_hz": band_width_hz, "bands": len(bands)}

    p = proportions / total
    p_nonzero = p[p > 0]
    adi = float(-np.sum(p_nonzero * np.log(p_nonzero)))
    max_diversity = np.log(len(bands)) or 1e-20
    aei = float(adi / max_diversity)
    return {"adi": adi, "aei": aei, "band_width_hz": band_width_hz, "bands": len(bands)}


def detect_pulses(waveform: np.ndarray, sr: int = SAMPLE_RATE, min_gap_ms: float = 20.0) -> np.ndarray:
    """Onset detection via peak-picking on the Hilbert envelope — good
    enough for clearly separated impulsive sounds (echolocation clicks,
    snapping shrimp, fish drumming pulses); it will under-detect calls
    that ramp up gradually rather than click on sharply. Returns pulse
    timestamps in seconds. This is a simple energy-envelope detector, not
    a trained click classifier — treat pulse counts as approximate."""
    from scipy.signal import hilbert, find_peaks

    envelope = np.abs(hilbert(waveform))
    # Smooth slightly so envelope noise doesn't register as separate peaks.
    smooth_len = max(1, int(sr * 0.001))
    if smooth_len > 1:
        kernel = np.ones(smooth_len) / smooth_len
        envelope = np.convolve(envelope, kernel, mode="same")

    if np.max(envelope) <= 0:
        return np.array([])

    min_distance = max(1, int(sr * min_gap_ms / 1000.0))
    threshold = np.mean(envelope) + 2 * np.std(envelope)
    peaks, _ = find_peaks(envelope, height=threshold, distance=min_distance)
    return peaks / sr


def compute_ici_prr(pulse_times: np.ndarray) -> dict:
    """Inter-Click Interval (ms, per consecutive pulse pair) and Pulse
    Repetition Rate (pulses/second, from the mean ICI). None/empty when
    fewer than 2 pulses were detected — PRR needs at least one interval."""
    if len(pulse_times) < 2:
        return {"ici_ms": [], "mean_ici_ms": None, "prr_hz": None, "pulse_count": len(pulse_times)}
    ici_s = np.diff(pulse_times)
    ici_ms = (ici_s * 1000).tolist()
    mean_ici_ms = float(np.mean(ici_ms))
    prr_hz = float(1000.0 / mean_ici_ms) if mean_ici_ms > 0 else None
    return {"ici_ms": ici_ms, "mean_ici_ms": mean_ici_ms, "prr_hz": prr_hz, "pulse_count": len(pulse_times)}


# ---------------------------------------------------------------------------
# Rhythm pattern tooling — acoustic-context support for interspecies
# research, NOT a translator. This is deliberately limited to what's
# honestly buildable without a CETI/Earth-Species-scale labeled dataset:
# quantitative comparison of click-train timing structure (the same raw
# material sperm whale coda research starts from — tempo, "rubato",
# extra clicks/"ornamentation") plus a place to attach the behavioral
# context (depth, movement, feeding, social activity) that gives those
# patterns any research meaning at all. It does not label, classify, or
# interpret what a pattern "means" — that judgment stays with the
# researcher, the same division of labor as the YOLO detector (unvalidated
# detection, not confirmed identification) and SurfPerch (similarity
# search, not species classification) elsewhere in this app.
# ---------------------------------------------------------------------------


def compute_rhythm_signature(ici_ms: List[float]) -> dict:
    """Summarizes a click train's timing structure: click count, mean ICI,
    and ICI coefficient of variation (std/mean) — a simple, standard proxy
    for tempo variability ("rubato" in the sperm-whale-coda literature).
    A CV near 0 means near-metronomic spacing; a higher CV means the
    clicks speed up/slow down within the train. This is descriptive, not
    a classifier — it doesn't assign a coda "type" or name a pattern."""
    if len(ici_ms) < 1:
        return {"click_count": 0, "mean_ici_ms": None, "ici_cv": None}
    ici = np.array(ici_ms, dtype=np.float64)
    mean_ici = float(np.mean(ici))
    cv = float(np.std(ici) / mean_ici) if mean_ici > 0 else None
    return {
        # click_count here means "clicks in this train after the first"
        # i.e. len(ici_ms) + 1 pulses produced len(ici_ms) intervals.
        "click_count": len(ici) + 1,
        "mean_ici_ms": mean_ici,
        "ici_cv": cv,
    }


def _dtw_distance(a: np.ndarray, b: np.ndarray) -> float:
    """Standard dynamic time warping distance between two 1D sequences —
    allows sequences of different lengths to align with local stretching,
    which is exactly what's needed to compare click trains that differ in
    "ornamentation" (extra clicks) or tempo without requiring the two
    trains to have identical click counts. O(len(a) * len(b)); click
    trains here are at most a few dozen intervals long, so this is cheap
    regardless of implementation efficiency."""
    n, m = len(a), len(b)
    if n == 0 or m == 0:
        return float("inf")
    cost = np.full((n + 1, m + 1), np.inf)
    cost[0, 0] = 0.0
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            d = abs(a[i - 1] - b[j - 1])
            cost[i, j] = d + min(cost[i - 1, j], cost[i, j - 1], cost[i - 1, j - 1])
    return float(cost[n, m])


def compare_rhythm(ici_a_ms: List[float], ici_b_ms: List[float]) -> dict:
    """Compares two click trains' ICI sequences two ways:

    - raw_dtw: DTW distance (ms) on the actual millisecond intervals —
      captures absolute tempo differences (a faster train and a slower
      train with the same *shape* still score as different here).
    - normalized_dtw / shape_similarity: DTW distance after scaling each
      sequence by its own mean ICI first, so overall tempo is factored
      out and only the relative rhythm *shape* is compared (two trains
      with the same accelerate/decelerate pattern at different absolute
      speeds score as similar here even though raw_dtw would separate
      them). shape_similarity is 1 / (1 + normalized_dtw), in (0, 1],
      higher = more similar shape — a convenience score, not a
      probability or confidence level.

    Both numbers are provided because "similar" means different things
    depending on what a researcher is actually asking (same individual's
    call sped up vs. a genuinely different pattern) — this doesn't decide
    that for them.

    Returns None-valued fields if either sequence is empty (fewer than 2
    detected pulses in that clip — nothing to compare)."""
    if not ici_a_ms or not ici_b_ms:
        return {
            "raw_dtw_ms": None,
            "normalized_dtw": None,
            "shape_similarity": None,
            "warning": "At least one clip had fewer than 2 detected pulses — nothing to compare.",
        }

    a = np.array(ici_a_ms, dtype=np.float64)
    b = np.array(ici_b_ms, dtype=np.float64)

    raw_dtw = _dtw_distance(a, b)

    mean_a = np.mean(a) or 1e-9
    mean_b = np.mean(b) or 1e-9
    normalized_dtw = _dtw_distance(a / mean_a, b / mean_b)
    # Normalize the DTW distance by path-relevant scale before converting
    # to a similarity score, so it isn't dominated by sequence length
    # alone (a longer comparison accumulates more path cost even at
    # identical per-step similarity).
    shape_similarity = float(1.0 / (1.0 + normalized_dtw / max(len(a), len(b))))

    return {
        "raw_dtw_ms": raw_dtw,
        "normalized_dtw": normalized_dtw,
        "shape_similarity": shape_similarity,
        "warning": (
            "Timing-structure comparison only — this measures how similar the "
            "click-train rhythms are, not whether they're the same call type, "
            "individual, or species. Verify by ear and against behavioral "
            "context before drawing conclusions."
        ),
    }


def compute_call_rate(pulse_times: np.ndarray, duration_s: float) -> float | None:
    """Pulses per minute across the whole clip — a coarser, more robust
    companion to PRR (which reflects only the spacing within a pulse
    train, not how much of the recording actually had activity)."""
    if duration_s <= 0:
        return None
    return float(len(pulse_times) / duration_s * 60.0)


def compute_peak_frequency_bandwidth(waveform: np.ndarray, sr: int = SAMPLE_RATE) -> dict:
    """Peak frequency (the frequency bin with the most energy, via Welch
    PSD) plus -3dB and -10dB bandwidth: the contiguous frequency range
    around the peak that stays within 3dB / 10dB of it. -3dB bandwidth is
    the tighter, more standard definition; -10dB is included since it's
    explicitly called out in the plan doc and is more forgiving for
    noisier field recordings."""
    psd_result = compute_psd(waveform, sr)
    freqs, psd_db = psd_result["freqs"], psd_result["psd_db"]
    if len(freqs) == 0:
        return {"peak_frequency_hz": None, "bandwidth_3db_hz": None, "bandwidth_10db_hz": None}

    peak_idx = int(np.argmax(psd_db))
    peak_freq = float(freqs[peak_idx])
    peak_level = psd_db[peak_idx]

    def _bandwidth(db_down: float) -> float:
        above = psd_db >= (peak_level - db_down)
        # Walk outward from the peak so the bandwidth is the contiguous
        # region around it, not every disconnected bin that happens to
        # clear the threshold elsewhere in the spectrum.
        lo = peak_idx
        while lo > 0 and above[lo - 1]:
            lo -= 1
        hi = peak_idx
        while hi < len(above) - 1 and above[hi + 1]:
            hi += 1
        return float(freqs[hi] - freqs[lo])

    return {
        "peak_frequency_hz": peak_freq,
        "bandwidth_3db_hz": _bandwidth(3.0),
        "bandwidth_10db_hz": _bandwidth(10.0),
    }


def compute_duty_cycle(waveform: np.ndarray, sr: int = SAMPLE_RATE) -> float:
    """Fraction of the clip where signal energy is meaningfully above the
    background floor (Otsu-free heuristic: envelope above mean + 1
    std-dev counts as "active"). An estimate of energetic investment in
    acoustic activity, not a true onset/offset segmentation — a proper
    duty cycle needs per-call boundaries this detector doesn't produce."""
    from scipy.signal import hilbert

    envelope = np.abs(hilbert(waveform))
    if len(envelope) == 0 or np.max(envelope) <= 0:
        return 0.0
    threshold = np.mean(envelope) + np.std(envelope)
    return float(np.mean(envelope >= threshold))


def compute_snr(waveform: np.ndarray, sr: int = SAMPLE_RATE, window_ms: float = 1000.0) -> float | None:
    """A pragmatic SNR estimate: dB difference between the loudest and
    quietest short-time RMS windows in the clip (L10 - L90, reusing
    compute_percentile_levels), treating the quiet windows as a proxy for
    the noise floor and loud windows as signal. This is a soundscape-wide
    approximation, not a per-call SNR against a known noise reference —
    label it accordingly."""
    levels = compute_percentile_levels(waveform, sr, window_ms)
    if levels["l10_db"] is None or levels["l90_db"] is None:
        return None
    return float(levels["l10_db"] - levels["l90_db"])


def analyze_soundscape(
    waveform: np.ndarray,
    sr: int = SAMPLE_RATE,
    calibration_offset_db: float | None = None,
) -> dict:
    """Runs every metric above on one waveform and returns a single
    grouped dict, organized the same way as the plan doc: signal-level
    metrics, ecoacoustic/soundscape indices, and noise/level metrics.
    This is the function the /acoustic-metrics route and the channel
    acoustic-analysis route both call."""
    duration_s = len(waveform) / sr if sr else 0.0
    pulses = detect_pulses(waveform, sr)
    ici_result = compute_ici_prr(pulses)

    return {
        "duration_seconds": duration_s,
        "signal_metrics": {
            **compute_peak_frequency_bandwidth(waveform, sr),
            **ici_result,
            "rhythm_signature": compute_rhythm_signature(ici_result["ici_ms"]),
            "prr_note": "PRR reflects spacing within detected pulses only, not overall activity — see call_rate_per_min for that.",
            "call_rate_per_min": compute_call_rate(pulses, duration_s),
            "duty_cycle_estimate": compute_duty_cycle(waveform, sr),
            "pulse_detection_note": (
                "Pulses found via envelope peak-picking, not a trained click "
                "detector — treat counts/timings as approximate, especially "
                "for calls that ramp up gradually rather than click sharply."
            ),
        },
        "soundscape_indices": {
            "aci": compute_acoustic_complexity_index(waveform, sr),
            **compute_acoustic_entropy(waveform, sr),
            "bioacoustic_index": compute_bioacoustic_index(waveform, sr),
            **compute_diversity_evenness(waveform, sr),
            **compute_ndsi(waveform, sr),
        },
        "level_metrics": {
            **compute_relative_spl(waveform, calibration_offset_db),
            **compute_percentile_levels(waveform, sr),
            "snr_estimate_db": compute_snr(waveform, sr),
            "calibration_note": (
                "Levels are relative (dBFS) unless calibration_offset_db was "
                "supplied — true SPL re 1 uPa needs the hydrophone's known "
                "sensitivity, which this app has no way to verify from an "
                "uploaded file alone."
            ),
        },
    }