import struct
import subprocess
import tempfile
import os

GPMF_TYPE_SIZES = {"b": 1, "B": 1, "c": 1, "s": 2, "S": 2, "l": 4, "L": 4, "f": 4, "d": 8}


def _find_gpmd_stream_index(video_path: str) -> int | None:
    result = subprocess.run(
        ["ffprobe", "-v", "quiet", "-print_format", "json", "-show_streams", video_path],
        capture_output=True, text=True, timeout=15,
    )
    if result.returncode != 0:
        return None
    import json
    streams = json.loads(result.stdout).get("streams", [])
    for s in streams:
        if s.get("codec_tag_string") == "gpmd":
            return s.get("index")
    return None


def _extract_raw_gpmf(video_path: str, stream_index: int) -> bytes | None:
    with tempfile.NamedTemporaryFile(suffix=".bin", delete=False) as tmp:
        out_path = tmp.name
    try:
        result = subprocess.run(
            ["ffmpeg", "-y", "-i", video_path, "-codec", "copy",
             "-map", f"0:{stream_index}", "-f", "rawvideo", out_path],
            capture_output=True, timeout=30,
        )
        if result.returncode != 0:
            return None
        with open(out_path, "rb") as f:
            return f.read()
    finally:
        os.unlink(out_path)


def _parse_gpmf_gps5(raw: bytes) -> list[dict]:
    """Minimal GPMF KLV parser targeting the common GPS5 case
    (lat, lon, alt, speed2d, speed3d), scaled by the preceding SCAL entry
    per the GPMF spec. Not a full parser of every GPMF stream type —
    covers the mainstream GoPro Hero5+ GPS case and fails gracefully
    (returns []) on anything it doesn't recognize, rather than crashing
    the upload."""
    points = []
    scale = [1, 1, 1, 1, 1]
    i = 0
    n = len(raw)
    while i + 8 <= n:
        fourcc = raw[i:i+4].decode("ascii", errors="ignore")
        type_char = chr(raw[i+4])
        size = raw[i+5]
        count = struct.unpack(">H", raw[i+6:i+8])[0]
        payload_len = size * count
        payload_start = i + 8
        payload = raw[payload_start:payload_start + payload_len]

        if fourcc == "SCAL" and type_char in ("s", "l") and count >= 1:
            elem_size = GPMF_TYPE_SIZES.get(type_char, 2)
            fmt = ">" + ("h" if type_char == "s" else "l") * count
            try:
                scale = list(struct.unpack(fmt, payload[:elem_size * count]))
            except struct.error:
                pass

        elif fourcc == "GPS5" and type_char == "l":
            elem_count = payload_len // 4
            n_points = elem_count // 5
            try:
                values = struct.unpack(f">{elem_count}l", payload[:elem_count * 4])
                for p in range(n_points):
                    lat, lon, alt, spd2d, spd3d = values[p*5:(p+1)*5]
                    s = scale if len(scale) == 5 else [scale[0]] * 5
                    points.append({
                        "lat": lat / s[0], "lng": lon / s[1],
                        "alt_m": alt / s[2],
                    })
            except struct.error:
                pass

        # Payload is padded to a 4-byte boundary
        padded_len = ((payload_len + 3) // 4) * 4
        i = payload_start + padded_len

    return points


def extract_video_telemetry(video_bytes: bytes, filename_hint: str = "upload.mp4") -> dict:
    with tempfile.NamedTemporaryFile(suffix=os.path.splitext(filename_hint)[1] or ".mp4", delete=False) as tmp:
        tmp.write(video_bytes)
        video_path = tmp.name

    try:
        stream_index = _find_gpmd_stream_index(video_path)
        if stream_index is None:
            return {"has_telemetry": False, "reason": "No GPMF metadata track found in this file"}

        raw = _extract_raw_gpmf(video_path, stream_index)
        if not raw:
            return {"has_telemetry": False, "reason": "GPMF track present but couldn't be extracted"}

        points = _parse_gpmf_gps5(raw)
        if not points:
            return {"has_telemetry": False, "reason": "GPMF track present but no GPS5 data found in it"}

        return {"has_telemetry": True, "source": "gpmf", "gps_points": points, "point_count": len(points)}
    except FileNotFoundError:
        # ffmpeg/ffprobe not installed on this host
        return {"has_telemetry": False, "reason": "ffmpeg not available on this server"}
    finally:
        os.unlink(video_path)