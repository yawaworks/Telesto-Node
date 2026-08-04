import xml.etree.ElementTree as ET

# UDDF (Universal Dive Data Format) namespace varies by exporting app —
# strip it defensively rather than hardcoding one URI.
def _local(tag):
    return tag.split("}")[-1] if "}" in tag else tag


def parse_uddf(file_bytes: bytes) -> list[dict]:
    """Parses the first dive's waypoint samples out of a UDDF export
    (Shearwater Cloud, Garmin Connect, Suunto, Subsurface all support
    this as a common interchange format). Returns a real, sensor-sourced
    timeline — not simulated — of {elapsed_seconds, depth_m, temp_c}.
    Degrades to an empty list (not an error) for any dive/waypoint it
    can't parse, since partial real data beats none.
    """
    root = ET.fromstring(file_bytes)
    samples = []

    for waypoint in root.iter():
        if _local(waypoint.tag) != "waypoint":
            continue
        entry = {}
        for child in waypoint:
            tag = _local(child.tag)
            try:
                value = float(child.text)
            except (TypeError, ValueError):
                continue
            if tag == "divetime":
                entry["elapsed_seconds"] = value
            elif tag == "depth":
                entry["depth_m"] = value
            elif tag == "temperature":
                # UDDF spec stores temperature in Kelvin
                entry["temp_c"] = round(value - 273.15, 1)
        if "elapsed_seconds" in entry and "depth_m" in entry:
            samples.append(entry)

    samples.sort(key=lambda s: s["elapsed_seconds"])
    return samples


def sample_at(samples: list[dict], elapsed_seconds: float) -> dict | None:
    """Nearest-sample lookup — good enough for HUD display, no need for
    interpolation given typical UDDF sampling intervals (often 10-30s)."""
    if not samples:
        return None
    return min(samples, key=lambda s: abs(s["elapsed_seconds"] - elapsed_seconds))