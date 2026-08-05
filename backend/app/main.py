import json
import math
import re
from typing import List, Optional
import xml.etree.ElementTree as ET
from app.dive_log import parse_uddf, sample_at
from app.gpmf_client import extract_video_telemetry
from dotenv import load_dotenv

# Must run BEFORE importing app.inference or app.alerts, since both read
# env vars (ROBOFLOW_API_KEY, N8N_DETECTION_WEBHOOK_URL) from the
# environment at import time.
load_dotenv()

import os

import cv2
import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel
import requests

import asyncio

from bson import ObjectId
from bson.errors import InvalidId

from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded

from app.alerts import send_detection_alert
from app.cloudinary_client import delete_clip, upload_clip, upload_snapshot
from app.db import get_db, is_connected
from app.inference import clahe_correct, coral_bleaching_ratio, predict_with_roboflow
from app.obis_client import fetch_obis_species_data
from app.optical_flow import estimate_motion_from_frame, reset_motion_tracking
from app.report import generate_mission_report, log_detections
from app.report_email import send_mission_report_email
from app.species_info import get_species_info
from app.telemetry import TelemetrySimulator, MISSION_LAT, MISSION_LNG
from app.weight_estimate import estimate_weight_grams, fishbase_search_url
from datetime import datetime, timezone
from urllib.parse import urlparse

import sys
from pathlib import Path

# Automatically adds the 'backend' folder to Python's module search paths
file_path = Path(__file__).resolve()
backend_dir = file_path.parent.parent  # Points to 'backend' folder
if str(backend_dir) not in sys.path:
    sys.path.insert(0, str(backend_dir))

FRONTEND_ORIGIN = os.getenv("FRONTEND_ORIGIN", "http://localhost:3000")
INTERNAL_SYNC_SECRET = os.getenv("INTERNAL_SYNC_SECRET", "")

app = FastAPI(title="Telesto Node Inference API")

limiter = Limiter(key_func=get_remote_address)
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[FRONTEND_ORIGIN],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class BoundingBox(BaseModel):
    label: str
    confidence: float
    x1: int
    y1: int
    x2: int
    y2: int
    source: Optional[str] = None
    bleaching_ratio: Optional[float] = None


class Classification(BaseModel):
    source: str
    label: str
    confidence: float


class FrameAnalysisResponse(BaseModel):
    boxes: List[BoundingBox]
    classifications: List[Classification] = []
    coral_bleaching_ratio: Optional[float] = None
    # Genuinely video-derived motion (dense optical flow between this
    # frame and the previous one) — see app/optical_flow.py. None on the
    # very first frame of a clip (nothing to compare against yet) or
    # whenever the source has just been reset.
    optical_flow: Optional[dict] = None


class SpeciesSyncRecord(BaseModel):
    scientific_name: str
    latitude: float
    longitude: float
    depth_meters: Optional[float] = None
    country: Optional[str] = None
    source: str  # "obis" or "inaturalist"


class SpeciesSyncPayload(BaseModel):
    records: List[SpeciesSyncRecord]


class WeightEstimateRequest(BaseModel):
    length_cm: float
    a: float
    b: float


def _clean(value):
    if value is None:
        return None
    if isinstance(value, float) and math.isnan(value):
        return None
    if hasattr(value, "item"):
        value = value.item()
        if isinstance(value, float) and math.isnan(value):
            return None
    return value


@app.on_event("startup")
async def warm_up_db():
    """Kick off the first Mongo connection attempt in the background at
    startup instead of on the first incoming request. This means Render's
    health check never has to wait on a live TLS handshake/timeout — it
    just reads whatever is_connected() reports at that moment."""
    get_db()


@app.get("/health")
def health():
    # No get_db() call here on purpose — this must return instantly so
    # Render's health check never blocks on a Mongo TLS timeout. Connection
    # status is populated by warm_up_db() at startup and refreshed lazily
    # elsewhere (e.g. next time a route that actually needs the DB runs).
    return {"status": "ok", "mongodb_connected": is_connected()}


@app.post("/analyze-frame", response_model=FrameAnalysisResponse)
@limiter.limit("60/minute")
async def analyze_frame(
    request: Request,
    file: UploadFile = File(...),
    conf_threshold: float = 0.2,
    latitude: float = MISSION_LAT,
    longitude: float = MISSION_LNG,
    alert_email: str | None = None,
):
    """Runs every enabled Roboflow model against this frame (marine-fishes
    species detection + the coral bleach classifier by default), merging
    results into one response, and logs the detections for the mission
    report export.

    latitude/longitude are optional and come from the frontend's live
    telemetry (useTelemetry) so detection alerts carry a real position.
    They default to the mission's home coordinates (Great Barrier Reef)
    if the frontend hasn't sent them yet — same fallback used everywhere
    else telemetry is referenced in this app.

    alert_email is the currently logged-in researcher's session email,
    sent by the frontend so detection alerts go to whoever is actually
    running THIS mission, not one hardcoded inbox.
    """
    raw_bytes = await file.read()
    np_arr = np.frombuffer(raw_bytes, np.uint8)
    frame = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)

    frame = clahe_correct(frame)

    # Runs against the same CLAHE-corrected frame Roboflow sees, purely
    # from pixel motion — no simulated fallback if this comes back None,
    # the frontend just doesn't show a motion reading for that frame.
    motion = estimate_motion_from_frame(frame)

    try:
        result = predict_with_roboflow(frame, conf_threshold=conf_threshold)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Roboflow inference failed: {exc}")

    boxes = [BoundingBox(**b) for b in result["boxes"]]
    classifications = [Classification(**c) for c in result["classifications"]]

    bleach_result = next(
        (c for c in classifications if c.source == "coral_bleach"), None
    )
    if bleach_result is not None:
        is_bleached = "bleach" in bleach_result.label.lower()
        frame_ratio = bleach_result.confidence if is_bleached else 1 - bleach_result.confidence
    else:
        coral_boxes = [b for b in boxes if "coral" in b.label.lower()]
        if coral_boxes:
            ratios = []
            for b in coral_boxes:
                crop = frame[max(0, b.y1):max(0, b.y2), max(0, b.x1):max(0, b.x2)]
                if crop.size > 0:
                    ratios.append(coral_bleaching_ratio(crop))
            frame_ratio = sum(ratios) / len(ratios) if ratios else None
        else:
            frame_ratio = None

    log_detections(result["boxes"], frame_ratio)

    # Fire detection alerts directly via Resend (no n8n in the path)
    # without blocking the response the frontend is waiting on.
    # send_detection_alert internally filters by confidence threshold and
    # applies a per-(species, recipient) cooldown, so this is safe to call
    # for every box on every frame.
    for box in boxes:
        asyncio.create_task(
            send_detection_alert(
                species=box.label,
                confidence=box.confidence,
                latitude=latitude,
                longitude=longitude,
                to_email=alert_email,
            )
        )

    return FrameAnalysisResponse(
        boxes=boxes, classifications=classifications, coral_bleaching_ratio=frame_ratio,
        optical_flow=motion,
    )


@app.post("/reset-motion-tracking")
@limiter.limit("30/minute")
async def reset_motion_tracking_endpoint(request: Request):
    """Call whenever the video source changes (default clip <-> upload
    <-> webcam <-> URL) — otherwise optical flow compares the first frame
    of the new source against the last frame of whatever was playing
    before, and reports meaningless motion for one frame."""
    reset_motion_tracking()
    return {"reset": True}


class SnapshotResponse(BaseModel):
    url: str
    public_id: str
    saved_to_db: bool


class ClipResponse(BaseModel):
    id: str
    url: str
    name: str
    shared: bool
    owner_email: str
    created_at: str


@app.post("/clips", response_model=ClipResponse)
@limiter.limit("10/minute")
async def save_clip(
    request: Request,
    file: UploadFile = File(...),
    name: str = "Untitled clip",
    owner_email: str = "",
    shared: bool = False,
):
    """Saves a video to the researcher's personal library, or the shared
    team library if `shared=True`. This is the one-time "manual work" a
    researcher does when they first bring a clip in — after this, loading
    it again is just a click from the My Clips / Team Clips panel, never
    a re-upload."""
    if not owner_email:
        raise HTTPException(status_code=400, detail="owner_email is required")

    raw_bytes = await file.read()

    try:
        upload_result = upload_clip(raw_bytes, filename=file.filename or "clip.mp4")
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Cloudinary upload failed: {exc}")

    db = get_db()
    if db is None:
        raise HTTPException(
            status_code=503,
            detail="Clip library is unavailable right now (database not connected). "
                   "The video wasn't saved — try again shortly.",
        )

    record = {
        "url": upload_result["url"],
        "public_id": upload_result["public_id"],
        "name": name,
        "owner_email": owner_email,
        "shared": shared,
        "created_at": datetime.now(timezone.utc),
    }
    result = db["clips"].insert_one(record)

    return ClipResponse(
        id=str(result.inserted_id),
        url=record["url"],
        name=record["name"],
        shared=record["shared"],
        owner_email=record["owner_email"],
        created_at=record["created_at"].isoformat(),
    )


@app.get("/clips", response_model=List[ClipResponse])
@limiter.limit("60/minute")
async def list_clips(request: Request, scope: str = "mine", owner_email: str = ""):
    """scope="mine" returns only this researcher's own clips (requires
    owner_email). scope="shared" returns every clip anyone has marked
    shared, regardless of who's asking."""
    db = get_db()
    if db is None:
        return []  # Degrade to an empty library rather than erroring the whole page

    if scope == "shared":
        query = {"shared": True}
    else:
        if not owner_email:
            raise HTTPException(status_code=400, detail="owner_email is required for scope=mine")
        query = {"owner_email": owner_email}

    docs = db["clips"].find(query).sort("created_at", -1).limit(100)
    return [
        ClipResponse(
            id=str(doc["_id"]),
            url=doc["url"],
            name=doc.get("name", "Untitled clip"),
            shared=doc.get("shared", False),
            owner_email=doc.get("owner_email", ""),
            created_at=doc["created_at"].isoformat() if doc.get("created_at") else "",
        )
        for doc in docs
    ]


@app.delete("/clips/{clip_id}")
@limiter.limit("20/minute")
async def remove_clip(request: Request, clip_id: str, owner_email: str):
    """Deletes a clip from both Mongo and Cloudinary. Ownership-checked:
    only the researcher who originally saved a clip can delete it, even if
    it's currently shared with the team — sharing makes a clip visible to
    others, it doesn't hand over deletion rights."""
    db = get_db()
    if db is None:
        raise HTTPException(status_code=503, detail="Clip library is unavailable right now")

    try:
        oid = ObjectId(clip_id)
    except InvalidId:
        raise HTTPException(status_code=400, detail="Invalid clip id")

    doc = db["clips"].find_one({"_id": oid})
    if doc is None:
        raise HTTPException(status_code=404, detail="Clip not found")

    if doc.get("owner_email") != owner_email:
        raise HTTPException(status_code=403, detail="Only the clip's owner can delete it")

    try:
        delete_clip(doc["public_id"])
    except Exception as exc:
        # Still remove the DB record even if Cloudinary cleanup fails —
        # a dangling unlisted file in Cloudinary is a much smaller problem
        # than a clip the researcher can't get rid of from their library.
        print(f"[clips] Cloudinary delete failed for {doc['public_id']}: {exc}")

    db["clips"].delete_one({"_id": oid})
    return {"deleted": True}


@app.post("/snapshot", response_model=SnapshotResponse)
@limiter.limit("30/minute")
async def create_snapshot(
    request: Request,
    file: UploadFile = File(...),
    depth: str = Form(""),
    coords: str = Form(""),
    temp: str = Form(""),
    salinity: str = Form(""),
    heading: str = Form(""),
    species_query: str = Form(""),
    measurements: str = Form(""),  # JSON array of "X.X cm" labels, researcher-calibrated, this frame only
):
    """Uploads a Discovery Snapshot (triggered by the gamepad's 'A' button)
    to Cloudinary, then logs a record of it — image URL plus whatever
    mission telemetry/species context and researcher measurements were active
    at capture time — to Mongo if it's connected. Falls back to upload-only
    (no DB record) if Mongo is currently down, same graceful-degradation
    pattern used elsewhere in this API."""
    raw_bytes = await file.read()

    try:
        upload_result = upload_snapshot(raw_bytes, filename=file.filename or "snapshot.jpg")
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Cloudinary upload failed: {exc}")

    saved_to_db = False
    db = get_db()
    if db is not None:
        try:
            parsed_measurements = json.loads(measurements) if measurements else []
        except Exception:
            parsed_measurements = []

        try:
            db["snapshots"].insert_one(
                {
                    "url": upload_result["url"],
                    "public_id": upload_result["public_id"],
                    "captured_at": datetime.now(timezone.utc),
                    "telemetry": {
                        "depth": depth,
                        "coords": coords,
                        "temp": temp,
                        "salinity": salinity,
                        "heading": heading,
                    },
                    "species_query": species_query,
                    "measurements": parsed_measurements,
                }
            )
            saved_to_db = True
        except Exception as exc:
            # Upload already succeeded — don't fail the whole request just
            # because the DB write didn't. The image is safe either way.
            print(f"[snapshot] Cloudinary upload OK but Mongo write failed: {exc}")

    return SnapshotResponse(
        url=upload_result["url"],
        public_id=upload_result["public_id"],
        saved_to_db=saved_to_db,
    )


@app.post("/extract-video-metadata")
@limiter.limit("10/minute")
async def extract_video_metadata(request: Request, file: UploadFile = File(...)):
    """Extracts telemetry streams (e.g., GPMF metadata from GoPro or action cameras)
    embedded in an uploaded video file."""
    raw_bytes = await file.read()
    return extract_video_telemetry(raw_bytes, filename_hint=file.filename or "upload.mp4")


@app.post("/estimate-weight")
@limiter.limit("60/minute")
def estimate_weight(request: Request, payload: WeightEstimateRequest):
    """Calculates estimated fish weight in grams using the standard length-weight
    relationship formula: W = a * L^b."""
    return {"weight_g": estimate_weight_grams(payload.length_cm, payload.a, payload.b)}


@app.get("/fishbase-link")
@limiter.limit("60/minute")
def fishbase_link(request: Request, scientific_name: str):
    """Generates a direct search URL to FishBase for a given species' scientific name."""
    return {"url": fishbase_search_url(scientific_name)}


@app.get("/export-report")
@limiter.limit("10/minute")
async def export_report(
    request: Request,
    depth: str = "42.6 m",
    coords: str = "11.3500 N, 144.2400 E",
    temp: str = "17.2°C",
    salinity: str = "34.9 PSU",
    heading: str = "086°",
):
    """Generates a PDF mission report summarizing every species detected and
    the average coral bleaching reading logged so far this session."""
    telemetry = {
        "depth": depth,
        "coords": coords,
        "temp": temp,
        "salinity": salinity,
        "heading": heading,
    }
    pdf_bytes = generate_mission_report(telemetry)
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={
            "Content-Disposition": 'attachment; filename="telesto-node-mission-report.pdf"'
        },
    )


class EmailReportRequest(BaseModel):
    depth: str = "42.6 m"
    coords: str = "11.3500 N, 144.2400 E"
    temp: str = "17.2°C"
    salinity: str = "34.9 PSU"
    heading: str = "086°"
    recipient_email: str


@app.post("/send-mission-report-email")
@limiter.limit("10/minute")
async def send_mission_report_email_endpoint(request: Request, payload: EmailReportRequest):
    """Generates the same PDF as /export-report and emails it to the
    given recipient via Resend, directly — no n8n workflow involved.
    Replaces the old "Mission Report Email" n8n workflow (Webhook ->
    Fetch Report PDF -> PDF to Base64 -> Send Report Email) with three
    lines of Python, since the backend already has everything it needs
    (the PDF generator, and now the Resend call) without an external
    hosting dependency in between.
    """
    telemetry = {
        "depth": payload.depth,
        "coords": payload.coords,
        "temp": payload.temp,
        "salinity": payload.salinity,
        "heading": payload.heading,
    }
    pdf_bytes = generate_mission_report(telemetry)

    try:
        await send_mission_report_email(pdf_bytes, payload.recipient_email)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Failed to send report email: {exc}")

    return {"status": "report_sent"}


ALLOWED_VIDEO_HOSTS_NOTE = (
    "Restricted to a known set of trusted video hosts to prevent this "
    "endpoint from being used as an open proxy. Add more via the "
    "ALLOWED_VIDEO_HOSTS env var (comma-separated hostnames) if needed."
)

_DEFAULT_ALLOWED_VIDEO_HOSTS = {
    "res.cloudinary.com",  # required — Clip Library loads saved clips through this proxy
    "www.noaa.gov",
    "oceanexplorer.noaa.gov",
    "www.ncei.noaa.gov",
}
_env_hosts = os.getenv("ALLOWED_VIDEO_HOSTS", "")
ALLOWED_VIDEO_HOSTS = _DEFAULT_ALLOWED_VIDEO_HOSTS | {
    h.strip().lower() for h in _env_hosts.split(",") if h.strip()
}


@app.get("/proxy-video")
@limiter.limit("20/minute")
async def proxy_video(request: Request, url: str):
    """Fetches a remote video on the server's behalf and re-serves it with
    permissive CORS headers, so footage from hosts that don't allow direct
    cross-origin canvas capture (e.g. NOAA's archive) can still be played
    and analyzed without the researcher needing to manually download and
    re-upload the file first. Supports Range requests for proper seeking.

    Restricted to ALLOWED_VIDEO_HOSTS to prevent this from being usable as
    an open proxy to fetch arbitrary URLs through this server.
    """
    if not url.lower().startswith(("http://", "https://")):
        raise HTTPException(status_code=400, detail="Only http(s) URLs are supported")

    hostname = (urlparse(url).hostname or "").lower()
    if hostname not in ALLOWED_VIDEO_HOSTS:
        raise HTTPException(
            status_code=403,
            detail=f"Host '{hostname}' is not on the allowed video host list. "
                   f"Contact an admin to add it via ALLOWED_VIDEO_HOSTS.",
        )

    upstream_headers = {}
    range_header = request.headers.get("range")
    if range_header:
        upstream_headers["Range"] = range_header

    try:
        upstream = requests.get(url, headers=upstream_headers, stream=True, timeout=15)
    except requests.RequestException as exc:
        raise HTTPException(status_code=502, detail=f"Failed to fetch source video: {exc}")

    if upstream.status_code not in (200, 206):
        raise HTTPException(
            status_code=502,
            detail=f"Source video host returned status {upstream.status_code}",
        )

    response_headers = {
        "Accept-Ranges": "bytes",
        "Access-Control-Allow-Origin": "*",
    }
    for header in ("Content-Type", "Content-Length", "Content-Range"):
        if header in upstream.headers:
            response_headers[header] = upstream.headers[header]

    def stream_body():
        try:
            for chunk in upstream.iter_content(chunk_size=64 * 1024):
                if chunk:
                    yield chunk
        finally:
            upstream.close()

    return StreamingResponse(
        stream_body(),
        status_code=upstream.status_code,
        headers=response_headers,
        media_type=upstream.headers.get("Content-Type", "video/mp4"),
    )


@app.get("/species-data")
@limiter.limit("30/minute")
async def species_data(request: Request, scientific_name: str, max_records: int = 200):
    """Serves species location data as GeoJSON for the bathymetry map.

    Checks the species_cache Mongo collection first (populated every 6
    hours by the "Species Data Sync" GitHub Actions workflow) — a cache
    hit avoids hitting OBIS live and returns near-instantly. Falls back
    to a live OBIS fetch on a cache miss, since the sync workflow
    currently only keeps one species (Acropora cervicornis) fresh; a
    researcher searching any other species should still get real
    results, just without the speed benefit until that species is added
    to the sync.
    """
    db = get_db()
    features = []

    if db is not None:
        cached_docs = list(
            db["species_cache"]
            .find(
                {
                    "scientific_name": {
                        "$regex": f"^{re.escape(scientific_name)}$",
                        "$options": "i",
                    }
                }
            )
            .limit(max_records)
        )
        for doc in cached_docs:
            lat = _clean(doc.get("latitude"))
            lng = _clean(doc.get("longitude"))
            if lat is None or lng is None:
                continue
            features.append(
                {
                    "type": "Feature",
                    "geometry": {"type": "Point", "coordinates": [lng, lat]},
                    "properties": {
                        "scientificName": doc.get("scientific_name"),
                        "depth_meters": _clean(doc.get("depth_meters")),
                        "country": doc.get("country"),
                        "source": doc.get("source"),
                    },
                }
            )

    if features:
        return {"type": "FeatureCollection", "features": features, "cached": True}

    # Cache miss — fall back to a live OBIS lookup rather than returning
    # nothing just because this species hasn't been synced yet.
    df = fetch_obis_species_data(scientific_name, max_records=max_records)

    if df is None or df.empty:
        raise HTTPException(
            status_code=404,
            detail=f"No records found for '{scientific_name}' (not cached, and no live OBIS results)",
        )

    for _, row in df.iterrows():
        lat = _clean(row["latitude"])
        lng = _clean(row["longitude"])
        if lat is None or lng is None:
            continue

        features.append(
            {
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [lng, lat]},
                "properties": {
                    "scientificName": _clean(row.get("scientificName")),
                    "depth_meters": _clean(row.get("depth_meters")),
                    "country": _clean(row.get("country")),
                },
            }
        )

    return {"type": "FeatureCollection", "features": features, "cached": False}


@app.get("/species-info")
@limiter.limit("30/minute")
async def species_info(request: Request, name: str):
    """Looks up a detected species by its model label (e.g.
    "Regal Tang_Paracanthurus hepatus") and returns Wikipedia summary
    text, taxon rank/kingdom, a reference diagram image (if Wikipedia has
    one), and related research papers (via OpenAlex). Backs the click-to-
    inspect "Species Inspector" modal in DetectionOverlay.js.

    This is a genuinely separate concern from /species-data (which serves
    OBIS occurrence points for the bathymetry map) — species-info is
    about a single species' identity/reference material, not where it's
    been sighted geographically.
    """
    try:
        return await get_species_info(name)
    except Exception as exc:
        # get_species_info's own sub-fetches (Wikipedia/OBIS/OpenAlex)
        # already catch their own errors and degrade individually — this
        # is a last-resort net for anything unexpected slipping through,
        # so a stray bug in one data source can't 500 the whole modal.
        print(f"[species-info] Unexpected failure for '{name}': {exc}")
        return {"query": name, "error": "Species lookup temporarily unavailable"}


@app.post("/internal/species-sync")
@limiter.limit("10/minute")
async def species_sync(request: Request, payload: SpeciesSyncPayload):
    """Internal-only endpoint for the n8n scheduled sync workflow to push
    normalized OBIS/iNaturalist records into Mongo. Not meant for the
    frontend — protected by a shared secret header rather than user auth,
    since n8n has no session/login of its own.

    Replaces hitting OBIS live on every map load: the frontend's
    /species-data can be pointed at this cache instead once it's
    populated, cutting both latency and OBIS API load.
    """
    provided_secret = request.headers.get("x-sync-secret", "")
    if not INTERNAL_SYNC_SECRET or provided_secret != INTERNAL_SYNC_SECRET:
        raise HTTPException(status_code=403, detail="Invalid or missing sync secret")

    db = get_db()
    if db is None:
        raise HTTPException(status_code=503, detail="Database unavailable — sync deferred")

    now = datetime.now(timezone.utc)
    upserted = 0
    for record in payload.records:
        db["species_cache"].update_one(
            {
                "scientific_name": record.scientific_name,
                "latitude": record.latitude,
                "longitude": record.longitude,
                "source": record.source,
            },
            {
                "$set": {
                    "depth_meters": record.depth_meters,
                    "country": record.country,
                    "synced_at": now,
                }
            },
            upsert=True,
        )
        upserted += 1

    return {"synced": upserted, "synced_at": now.isoformat()}


@app.websocket("/ws/telemetry")
async def telemetry_socket(websocket: WebSocket):
    """Streams simulated but realistic ROV telemetry (depth, temp, salinity,
    heading, coordinates) once per second, so the HUD reflects live-feeling
    sensor drift instead of frozen numbers. Swap TelemetrySimulator for a
    real sensor/ROV data source when one is available — the message shape
    stays the same either way."""
    await websocket.accept()
    simulator = TelemetrySimulator()
    try:
        while True:
            await websocket.send_json(await simulator.tick())
            await asyncio.sleep(1)
    except WebSocketDisconnect:
        pass


class DiveLogUploadResponse(BaseModel):
    id: str
    sample_count: int
    duration_seconds: float
    depth_range_m: List[float]
    has_temp: bool

@app.post("/dive-log", response_model=DiveLogUploadResponse)
@limiter.limit("10/minute")
async def upload_dive_log(request: Request, file: UploadFile = File(...), owner_email: str = ""):
    raw = await file.read()
    try:
        samples = parse_uddf(raw)
    except ET.ParseError:
        raise HTTPException(status_code=400, detail="Couldn't parse that file as UDDF XML")
    if not samples:
        raise HTTPException(status_code=400, detail="No depth/time waypoints found in this file")

    db = get_db()
    if db is None:
        raise HTTPException(status_code=503, detail="Dive log storage unavailable right now")

    depths = [s["depth_m"] for s in samples]
    doc = {
        "owner_email": owner_email,
        "samples": samples,
        "uploaded_at": datetime.now(timezone.utc),
    }
    result = db["dive_logs"].insert_one(doc)

    return DiveLogUploadResponse(
        id=str(result.inserted_id),
        sample_count=len(samples),
        duration_seconds=samples[-1]["elapsed_seconds"],
        depth_range_m=[min(depths), max(depths)],
        has_temp=any("temp_c" in s for s in samples),
    )

@app.get("/dive-log/{dive_log_id}/at")
@limiter.limit("120/minute")
async def dive_log_at(request: Request, dive_log_id: str, elapsed_seconds: float):
    db = get_db()
    if db is None:
        raise HTTPException(status_code=503, detail="Dive log storage unavailable right now")
    try:
        oid = ObjectId(dive_log_id)
    except InvalidId:
        raise HTTPException(status_code=400, detail="Invalid dive log id")
    doc = db["dive_logs"].find_one({"_id": oid})
    if doc is None:
        raise HTTPException(status_code=404, detail="Dive log not found")
    sample = sample_at(doc["samples"], elapsed_seconds)
    if sample is None:
        raise HTTPException(status_code=404, detail="No samples in this log")
    return {"depth_m": sample.get("depth_m"), "temp_c": sample.get("temp_c"), "source": "dive_log"}


# ---------------------------------------------------------------------------
# Team Workspace: channels, messages, presence
#
# Realtime is deliberately polling-based rather than a managed pub/sub
# service (Pusher/Ably) — Vercel can't hold long-lived WebSocket
# connections and this backend is already up 24/7 for free on Render, so
# there's no reason to add a paid third-party dependency just for a small
# research team's chat. The frontend polls GET /channels/{id}/messages on
# an interval and pings POST /presence/heartbeat periodically instead.
#
# Auth follows the same trust model as the rest of this API (see /clips,
# /snapshot): the frontend already gates access behind a NextAuth session,
# so the backend takes the researcher's email as a plain field/param rather
# than verifying a bearer token itself.
# ---------------------------------------------------------------------------

PRESENCE_ONLINE_WINDOW_SECONDS = 60


class ChannelCreateRequest(BaseModel):
    name: str
    type: str = "project"  # "project" | "general"
    member_emails: List[str] = []
    created_by: str


class ChannelResponse(BaseModel):
    id: str
    name: str
    type: str
    members: List[str]
    created_by: str
    created_at: str


class ChannelMemberRequest(BaseModel):
    email: str
    added_by: str


class MessageCreateRequest(BaseModel):
    sender_email: str
    text: str
    attachments: List[str] = []


class MessageResponse(BaseModel):
    id: str
    channel_id: str
    sender_email: str
    text: str
    attachments: List[str]
    created_at: str


class HeartbeatRequest(BaseModel):
    email: str


class PresenceEntry(BaseModel):
    email: str
    online: bool
    last_seen: Optional[str] = None


def _channel_to_response(doc) -> ChannelResponse:
    return ChannelResponse(
        id=str(doc["_id"]),
        name=doc.get("name", "Untitled channel"),
        type=doc.get("type", "project"),
        members=doc.get("members", []),
        created_by=doc.get("created_by", ""),
        created_at=doc["created_at"].isoformat() if doc.get("created_at") else "",
    )


def _require_channel(db, channel_id: str):
    try:
        oid = ObjectId(channel_id)
    except InvalidId:
        raise HTTPException(status_code=400, detail="Invalid channel id")
    doc = db["channels"].find_one({"_id": oid})
    if doc is None:
        raise HTTPException(status_code=404, detail="Channel not found")
    return oid, doc


@app.post("/channels", response_model=ChannelResponse)
@limiter.limit("10/minute")
async def create_channel(request: Request, payload: ChannelCreateRequest):
    """Creates a channel and folds the creator into the member list even if
    they forgot to include themselves — a channel its own creator can't see
    is a bug, not an edge case worth erroring over."""
    db = get_db()
    if db is None:
        raise HTTPException(status_code=503, detail="Team workspace is unavailable right now (database not connected)")

    members = list(dict.fromkeys([*payload.member_emails, payload.created_by]))  # de-duped, order-preserved
    record = {
        "name": payload.name,
        "type": payload.type,
        "members": members,
        "created_by": payload.created_by,
        "created_at": datetime.now(timezone.utc),
    }
    result = db["channels"].insert_one(record)
    record["_id"] = result.inserted_id
    return _channel_to_response(record)


@app.get("/channels", response_model=List[ChannelResponse])
@limiter.limit("60/minute")
async def list_channels(request: Request, member_email: str):
    """Every channel the given researcher belongs to. No member_email, no
    list — there's no "browse all channels" mode, matching how a Teams
    sidebar only ever shows what you're already in."""
    if not member_email:
        raise HTTPException(status_code=400, detail="member_email is required")

    db = get_db()
    if db is None:
        return []  # Degrade to an empty workspace rather than erroring the whole page

    docs = db["channels"].find({"members": member_email}).sort("created_at", 1).limit(200)
    return [_channel_to_response(doc) for doc in docs]


@app.post("/channels/{channel_id}/members", response_model=ChannelResponse)
@limiter.limit("20/minute")
async def add_channel_member(request: Request, channel_id: str, payload: ChannelMemberRequest):
    """Only an existing member can add someone else — prevents a channel
    from being joined by anyone who merely guesses its id."""
    db = get_db()
    if db is None:
        raise HTTPException(status_code=503, detail="Team workspace is unavailable right now")

    oid, doc = _require_channel(db, channel_id)
    if payload.added_by not in doc.get("members", []):
        raise HTTPException(status_code=403, detail="Only current channel members can add someone else")

    db["channels"].update_one({"_id": oid}, {"$addToSet": {"members": payload.email}})
    doc = db["channels"].find_one({"_id": oid})
    return _channel_to_response(doc)


@app.post("/channels/{channel_id}/messages", response_model=MessageResponse)
@limiter.limit("60/minute")
async def post_message(request: Request, channel_id: str, payload: MessageCreateRequest):
    db = get_db()
    if db is None:
        raise HTTPException(status_code=503, detail="Team workspace is unavailable right now")

    oid, doc = _require_channel(db, channel_id)
    if payload.sender_email not in doc.get("members", []):
        raise HTTPException(status_code=403, detail="Only channel members can post messages")
    if not payload.text.strip() and not payload.attachments:
        raise HTTPException(status_code=400, detail="Message needs text or an attachment")

    record = {
        "channel_id": oid,
        "sender_email": payload.sender_email,
        "text": payload.text,
        "attachments": payload.attachments,
        "created_at": datetime.now(timezone.utc),
    }
    result = db["messages"].insert_one(record)

    return MessageResponse(
        id=str(result.inserted_id),
        channel_id=channel_id,
        sender_email=record["sender_email"],
        text=record["text"],
        attachments=record["attachments"],
        created_at=record["created_at"].isoformat(),
    )


@app.get("/channels/{channel_id}/messages", response_model=List[MessageResponse])
@limiter.limit("120/minute")
async def list_messages(
    request: Request,
    channel_id: str,
    requester_email: str,
    since: Optional[str] = None,
    limit: int = 200,
):
    """The polling endpoint the frontend hits every few seconds while a
    channel is open. Pass `since` (an ISO timestamp, normally the
    created_at of the last message already rendered) to fetch only what's
    new since the last poll instead of re-fetching the whole history."""
    db = get_db()
    if db is None:
        return []  # Degrade to an empty channel rather than erroring the whole page

    oid, doc = _require_channel(db, channel_id)
    if requester_email not in doc.get("members", []):
        raise HTTPException(status_code=403, detail="Only channel members can view messages")

    query = {"channel_id": oid}
    if since:
        try:
            since_dt = datetime.fromisoformat(since.replace("Z", "+00:00"))
            query["created_at"] = {"$gt": since_dt}
        except ValueError:
            raise HTTPException(status_code=400, detail="since must be an ISO timestamp")

    docs = db["messages"].find(query).sort("created_at", 1).limit(min(limit, 500))
    return [
        MessageResponse(
            id=str(m["_id"]),
            channel_id=str(m["channel_id"]),
            sender_email=m.get("sender_email", ""),
            text=m.get("text", ""),
            attachments=m.get("attachments", []),
            created_at=m["created_at"].isoformat() if m.get("created_at") else "",
        )
        for m in docs
    ]


@app.post("/presence/heartbeat")
@limiter.limit("120/minute")
async def presence_heartbeat(request: Request, payload: HeartbeatRequest):
    """Fire-and-forget ping the frontend sends every ~30s while a
    researcher has the workspace open in an active tab. Deliberately not
    persisted as history — just the single latest lastSeen per email,
    upserted in place."""
    db = get_db()
    if db is None:
        # Presence is a nice-to-have, not core data — don't error the tab
        # over it just because the DB is briefly down.
        return {"ok": False}

    db["presence"].update_one(
        {"email": payload.email},
        {"$set": {"email": payload.email, "last_seen": datetime.now(timezone.utc)}},
        upsert=True,
    )
    return {"ok": True}


@app.get("/presence", response_model=List[PresenceEntry])
@limiter.limit("120/minute")
async def get_presence(request: Request, emails: str):
    """emails is a comma-separated list, e.g. from a channel's member
    list. Anyone whose last heartbeat was within the online window is
    reported online; anyone with no heartbeat on record at all is reported
    offline with no last_seen rather than omitted, so the frontend can
    still render them in the member list."""
    requested = [e.strip() for e in emails.split(",") if e.strip()]
    if not requested:
        return []

    db = get_db()
    if db is None:
        return [PresenceEntry(email=e, online=False, last_seen=None) for e in requested]

    docs = {d["email"]: d for d in db["presence"].find({"email": {"$in": requested}})}
    now = datetime.now(timezone.utc)

    results = []
    for email in requested:
        doc = docs.get(email)
        if doc is None:
            results.append(PresenceEntry(email=email, online=False, last_seen=None))
            continue
        last_seen = doc["last_seen"]
        online = (now - last_seen).total_seconds() < PRESENCE_ONLINE_WINDOW_SECONDS
        results.append(PresenceEntry(email=email, online=online, last_seen=last_seen.isoformat()))
    return results