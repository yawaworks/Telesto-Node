"""
Habitat change tracking — aggregates logged detections (species counts,
coral bleaching readings) by location and time period so a researcher can
see whether a site is trending in a direction, not just what's visible
right now. Builds directly on top of app/report.py's detection log, now
that entries carry latitude/longitude (see report.py's log_detections).

Honest limitations, stated up front rather than discovered later:

- Location grouping is a simple lat/lng bounding box around a point, not
  a real geospatial index or query (no 2dsphere index on the detections
  collection). Fine at this app's actual scale; would need revisiting if
  the detections collection grows into the millions of documents.

- Coordinates come from live telemetry when available, but fall back to
  the mission's fixed home coordinates otherwise (see analyze-frame's
  docstring in main.py) — a habitat trend for a location is only as
  trustworthy as the telemetry that was actually live when those frames
  were captured. This module doesn't know which readings had real
  telemetry and which didn't; it just reports what's in the log.

- "Species count" here means distinct species LABELS seen in a period —
  it's a measure of detected diversity, not verified presence (the same
  "unvalidated model" caveat that applies to every YOLO detection
  elsewhere in this app applies to every count here too).

- Bleaching ratio trend is only as good as the coral bleach classifier
  feeding it — same caveat, not re-litigated per-function below.
"""

import math
from collections import defaultdict
from datetime import datetime, timezone


EARTH_RADIUS_KM = 6371.0
COLLECTION_NAME = "detections"


def bounding_box(latitude: float, longitude: float, radius_km: float) -> dict:
    """A simple lat/lng box around a point — not a great-circle radius
    (corners of the box are slightly farther than radius_km from center),
    good enough for "roughly this site" grouping without a geospatial
    index. Longitude degrees shrink toward the poles, so that axis is
    widened by 1/cos(latitude) to keep the box roughly radius_km wide at
    every latitude rather than narrowing near the equator's assumption."""
    lat_delta = (radius_km / EARTH_RADIUS_KM) * (180 / math.pi)
    lng_delta = lat_delta / max(0.15, math.cos(math.radians(latitude)))
    return {
        "min_lat": latitude - lat_delta,
        "max_lat": latitude + lat_delta,
        "min_lng": longitude - lng_delta,
        "max_lng": longitude + lng_delta,
    }


def compute_habitat_trend(entries: list[dict]) -> list[dict]:
    """Buckets already-fetched detection-log entries by calendar month
    and summarizes each bucket. Entries are the same shape
    app/report.py's log_detections writes: timestamp, label, confidence,
    source, owner_email, latitude, longitude.

    Returns a chronologically sorted list of:
      period ("YYYY-MM"), species_count (distinct labels that period,
      excluding the bleaching marker), detection_count, reading_count
      (species + bleaching readings combined), mean_bleaching_ratio
      (None if no bleaching readings that period), bleaching_reading_count
    """
    buckets: dict[str, dict] = defaultdict(
        lambda: {"labels": set(), "detection_count": 0, "bleaching_ratios": []}
    )

    for entry in entries:
        ts = entry.get("timestamp")
        if ts is None:
            continue
        if isinstance(ts, str):
            try:
                ts = datetime.fromisoformat(ts)
            except ValueError:
                continue
        period = ts.strftime("%Y-%m")
        bucket = buckets[period]

        if entry.get("label") == "__coral_bleaching_reading__":
            ratio = entry.get("confidence")
            if ratio is not None:
                bucket["bleaching_ratios"].append(ratio)
        else:
            bucket["labels"].add(entry.get("label"))
            bucket["detection_count"] += 1

    trend = []
    for period in sorted(buckets.keys()):
        b = buckets[period]
        ratios = b["bleaching_ratios"]
        trend.append(
            {
                "period": period,
                "species_count": len(b["labels"]),
                "detection_count": b["detection_count"],
                "bleaching_reading_count": len(ratios),
                "mean_bleaching_ratio": (sum(ratios) / len(ratios)) if ratios else None,
            }
        )
    return trend