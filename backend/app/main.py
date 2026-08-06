import json
import math
import re
import hashlib
import hmac
import secrets
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
from app.cloudinary_client import delete_clip, upload_clip, upload_snapshot, upload_chat_attachment
from app.db import get_db, is_connected
from app.inference import clahe_correct, coral_bleaching_ratio, predict_with_roboflow
from app.obis_client import fetch_obis_species_data
from app.optical_flow import estimate_motion_from_frame, reset_motion_tracking
from app.report import generate_mission_report, log_detections
from app.report_email import send_mission_report_email
from app.species_info import get_species_info
from app.telemetry import TelemetrySimulator, MISSION_LAT, MISSION_LNG
from app.weight_estimate import estimate_weight_grams, fishbase_search_url
from app.bioacoustics import (
    SAMPLE_RATE,
    WINDOW_SECONDS,
    analyze_soundscape,
    compare_rhythm,
    compute_rhythm_signature,
    embed_windows,
    embedding_from_list,
    embedding_to_list,
    find_similar_windows,
    load_waveform,
)
from app.translate import COMMON_LANGUAGES, translate_text
from datetime import datetime, timedelta, timezone
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
    owner_email: str | None = None,
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

    owner_email is that same session email, stored on every logged
    detection so mission reports can later be scoped to "mine" vs
    "team" (see app/report.py). Usually identical to alert_email; kept
    as a separate param since a future workspace scenario could log
    detections under someone other than the alert recipient.
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

    log_detections(result["boxes"], frame_ratio, owner_email=owner_email)

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
    scope: str = "team",
    owner_email: str | None = None,
):
    """Generates a PDF mission report summarizing species detected and
    the average coral bleaching reading logged so far.

    scope="mine" (requires owner_email) limits the report to detections
    logged under that researcher's own session. scope="team" (default)
    pools every detection logged by anyone, matching this endpoint's
    original behavior — see app/report.py for why that's provisional
    until Team Workspace defines an actual team boundary.
    """
    if scope == "mine" and not owner_email:
        raise HTTPException(status_code=400, detail="owner_email is required for scope=mine")

    telemetry = {
        "depth": depth,
        "coords": coords,
        "temp": temp,
        "salinity": salinity,
        "heading": heading,
    }
    pdf_bytes = generate_mission_report(telemetry, owner_email=owner_email, scope=scope)
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
    scope: str = "team"
    owner_email: str | None = None


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
    if payload.scope == "mine" and not payload.owner_email:
        raise HTTPException(status_code=400, detail="owner_email is required for scope=mine")

    telemetry = {
        "depth": payload.depth,
        "coords": payload.coords,
        "temp": payload.temp,
        "salinity": payload.salinity,
        "heading": payload.heading,
    }
    pdf_bytes = generate_mission_report(
        telemetry, owner_email=payload.owner_email, scope=payload.scope
    )

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
# Team Workspace: channels, messages, presence, moderation
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
#
# Explicitly NOT built here: voice/video calling and calendar-based
# meeting scheduling. Both need a real-time media provider (TURN/STUN,
# signaling) that this free-tier stack doesn't have — that's an
# infrastructure decision worth making deliberately, not something to
# silently bolt on. Everything else on the punch list (manual presence
# status, read receipts, file/voice attachments, replies, forwarding,
# pinning, reporting, admin roles) is built below on existing free
# infrastructure only.
# ---------------------------------------------------------------------------

PRESENCE_ONLINE_WINDOW_SECONDS = 60
# Beyond this, a manually-set status (busy/away/offline) is treated as
# stale rather than trusted forever — a laptop closed mid-"Busy" shouldn't
# show a teammate as busy for the rest of the week.
PRESENCE_STALE_SECONDS = 15 * 60
VALID_MANUAL_STATUSES = {"active", "away", "busy", "offline"}
VALID_ATTACHMENT_KINDS = {"file", "voice"}
MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024  # 15MB — protects Cloudinary's 25 credits/month free-tier quota


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
    admins: List[str]
    created_by: str
    created_at: str
    unread_count: int = 0


class ChannelMemberRequest(BaseModel):
    email: str
    added_by: str


class ChannelAdminRequest(BaseModel):
    email: str
    requested_by: str


class MessageAttachment(BaseModel):
    url: str
    name: str
    kind: str = "file"  # "file" | "voice"
    duration_seconds: Optional[float] = None


class MessageCreateRequest(BaseModel):
    sender_email: str
    text: str = ""
    attachments: List[MessageAttachment] = []
    reply_to: Optional[str] = None


class ReplyPreview(BaseModel):
    message_id: str
    sender_email: str
    text: str


class ForwardedFrom(BaseModel):
    channel_id: str
    sender_email: str


class MessageResponse(BaseModel):
    id: str
    channel_id: str
    sender_email: str
    text: str
    attachments: List[MessageAttachment]
    created_at: str
    reply_to: Optional[str] = None
    reply_preview: Optional[ReplyPreview] = None
    pinned: bool = False
    deleted: bool = False
    forwarded_from: Optional[ForwardedFrom] = None


class ForwardMessageRequest(BaseModel):
    target_channel_id: str
    forwarded_by: str


class ReportMessageRequest(BaseModel):
    reported_by: str
    reason: str = ""


class ReportResponse(BaseModel):
    id: str
    message_id: str
    channel_id: str
    reported_by: str
    reason: str
    created_at: str
    resolved: bool


class HeartbeatRequest(BaseModel):
    email: str


class PresenceStatusRequest(BaseModel):
    email: str
    status: str  # "active" | "away" | "busy" | "offline"


class PresenceEntry(BaseModel):
    email: str
    online: bool
    status: str  # effective, displayable status honoring any manual override
    last_seen: Optional[str] = None


class ReadReceiptRequest(BaseModel):
    email: str


class AttachmentUploadResponse(BaseModel):
    url: str
    name: str
    kind: str
    public_id: str


def _channel_to_response(doc, unread_count: int = 0) -> ChannelResponse:
    return ChannelResponse(
        id=str(doc["_id"]),
        name=doc.get("name", "Untitled channel"),
        type=doc.get("type", "project"),
        members=doc.get("members", []),
        admins=doc.get("admins", []),
        created_by=doc.get("created_by", ""),
        created_at=doc["created_at"].isoformat() if doc.get("created_at") else "",
        unread_count=unread_count,
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


def _require_message(db, message_id: str):
    try:
        oid = ObjectId(message_id)
    except InvalidId:
        raise HTTPException(status_code=400, detail="Invalid message id")
    doc = db["messages"].find_one({"_id": oid})
    if doc is None:
        raise HTTPException(status_code=404, detail="Message not found")
    return oid, doc


def _is_admin(channel_doc, email: str) -> bool:
    return email == channel_doc.get("created_by") or email in channel_doc.get("admins", [])


def _message_to_response(doc) -> MessageResponse:
    reply_preview = doc.get("reply_preview")
    forwarded_from = doc.get("forwarded_from")
    return MessageResponse(
        id=str(doc["_id"]),
        channel_id=str(doc["channel_id"]),
        sender_email=doc.get("sender_email", ""),
        text="[deleted]" if doc.get("deleted") else doc.get("text", ""),
        attachments=[] if doc.get("deleted") else [MessageAttachment(**a) for a in doc.get("attachments", [])],
        created_at=doc["created_at"].isoformat() if doc.get("created_at") else "",
        reply_to=str(doc["reply_to"]) if doc.get("reply_to") else None,
        reply_preview=ReplyPreview(**reply_preview) if reply_preview else None,
        pinned=doc.get("pinned", False),
        deleted=doc.get("deleted", False),
        forwarded_from=ForwardedFrom(**forwarded_from) if forwarded_from else None,
    )


def _unread_count(db, channel_id, member_email: str) -> int:
    """Counts messages in this channel newer than the member's last read
    marker, excluding their own messages (you don't need to be told you
    have unread copies of what you just said). Best-effort — any query
    failure just reports 0 rather than breaking the channel list."""
    try:
        read_doc = db["channel_reads"].find_one({"channel_id": channel_id, "email": member_email})
        query = {"channel_id": channel_id, "sender_email": {"$ne": member_email}, "deleted": {"$ne": True}}
        if read_doc and read_doc.get("last_read_at"):
            query["created_at"] = {"$gt": read_doc["last_read_at"]}
        return db["messages"].count_documents(query)
    except Exception as exc:
        print(f"[workspace] Unread count failed for {member_email} in {channel_id}: {exc}")
        return 0


def _compute_presence(doc, now):
    """Blends heartbeat-derived online/offline with an optional manual
    override (active/away/busy/offline). A manual override older than
    PRESENCE_STALE_SECONDS is treated as abandoned rather than trusted
    forever."""
    last_seen = doc.get("last_seen") if doc else None
    manual_status = doc.get("manual_status") if doc else None

    if last_seen is None:
        return False, "offline"

    age_seconds = (now - last_seen).total_seconds()
    online = age_seconds < PRESENCE_ONLINE_WINDOW_SECONDS

    if age_seconds > PRESENCE_STALE_SECONDS:
        return False, "offline"

    if manual_status in ("busy", "away"):
        return online, manual_status
    if manual_status == "offline":
        return online, "offline"

    return online, ("active" if online else "offline")


@app.post("/channels", response_model=ChannelResponse)
@limiter.limit("10/minute")
async def create_channel(request: Request, payload: ChannelCreateRequest):
    """Creates a channel and folds the creator into the member list even if
    they forgot to include themselves. The creator is always an admin —
    every channel needs at least one person who can moderate it."""
    db = get_db()
    if db is None:
        raise HTTPException(status_code=503, detail="Team workspace is unavailable right now (database not connected)")

    members = list(dict.fromkeys([*payload.member_emails, payload.created_by]))  # de-duped, order-preserved
    record = {
        "name": payload.name,
        "type": payload.type,
        "members": members,
        "admins": [payload.created_by],
        "created_by": payload.created_by,
        "created_at": datetime.now(timezone.utc),
    }
    result = db["channels"].insert_one(record)
    record["_id"] = result.inserted_id
    return _channel_to_response(record)


@app.get("/channels", response_model=List[ChannelResponse])
@limiter.limit("60/minute")
async def list_channels(request: Request, member_email: str):
    """Every channel the given researcher belongs to, with an unread
    count per channel."""
    if not member_email:
        raise HTTPException(status_code=400, detail="member_email is required")

    db = get_db()
    if db is None:
        return []  # Degrade to an empty workspace rather than erroring the whole page

    docs = db["channels"].find({"members": member_email}).sort("created_at", 1).limit(200)
    return [
        _channel_to_response(doc, unread_count=_unread_count(db, doc["_id"], member_email))
        for doc in docs
    ]


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


@app.delete("/channels/{channel_id}/members/{email}", response_model=ChannelResponse)
@limiter.limit("20/minute")
async def remove_channel_member(request: Request, channel_id: str, email: str, requested_by: str):
    """Admin-only. The channel's original creator can't be removed this
    way — demote/transfer isn't built, so removing them would leave a
    channel with no way to be moderated."""
    db = get_db()
    if db is None:
        raise HTTPException(status_code=503, detail="Team workspace is unavailable right now")

    oid, doc = _require_channel(db, channel_id)
    if not _is_admin(doc, requested_by):
        raise HTTPException(status_code=403, detail="Only a channel admin can remove members")
    if email == doc.get("created_by"):
        raise HTTPException(status_code=400, detail="The channel creator can't be removed")

    db["channels"].update_one({"_id": oid}, {"$pull": {"members": email, "admins": email}})
    doc = db["channels"].find_one({"_id": oid})
    return _channel_to_response(doc)


@app.post("/channels/{channel_id}/admins", response_model=ChannelResponse)
@limiter.limit("20/minute")
async def promote_channel_admin(request: Request, channel_id: str, payload: ChannelAdminRequest):
    """Admin-only. Promoting someone who isn't yet a member first adds
    them as one — an admin who isn't a member of their own channel would
    be a strange state to allow."""
    db = get_db()
    if db is None:
        raise HTTPException(status_code=503, detail="Team workspace is unavailable right now")

    oid, doc = _require_channel(db, channel_id)
    if not _is_admin(doc, payload.requested_by):
        raise HTTPException(status_code=403, detail="Only a channel admin can promote another admin")

    db["channels"].update_one(
        {"_id": oid},
        {"$addToSet": {"members": payload.email, "admins": payload.email}},
    )
    doc = db["channels"].find_one({"_id": oid})
    return _channel_to_response(doc)


@app.delete("/channels/{channel_id}/admins/{email}", response_model=ChannelResponse)
@limiter.limit("20/minute")
async def demote_channel_admin(request: Request, channel_id: str, email: str, requested_by: str):
    """Admin-only. The creator can't be demoted, for the same reason they
    can't be removed as a member."""
    db = get_db()
    if db is None:
        raise HTTPException(status_code=503, detail="Team workspace is unavailable right now")

    oid, doc = _require_channel(db, channel_id)
    if not _is_admin(doc, requested_by):
        raise HTTPException(status_code=403, detail="Only a channel admin can demote another admin")
    if email == doc.get("created_by"):
        raise HTTPException(status_code=400, detail="The channel creator can't be demoted")

    db["channels"].update_one({"_id": oid}, {"$pull": {"admins": email}})
    doc = db["channels"].find_one({"_id": oid})
    return _channel_to_response(doc)


@app.post("/channels/{channel_id}/read")
@limiter.limit("120/minute")
async def mark_channel_read(request: Request, channel_id: str, payload: ReadReceiptRequest):
    """The frontend calls this whenever a channel is actually in view
    (e.g. on open and periodically while active), marking everything up
    to now as read for that researcher."""
    db = get_db()
    if db is None:
        return {"ok": False}

    oid, doc = _require_channel(db, channel_id)
    if payload.email not in doc.get("members", []):
        raise HTTPException(status_code=403, detail="Only channel members can mark it read")

    db["channel_reads"].update_one(
        {"channel_id": oid, "email": payload.email},
        {"$set": {"channel_id": oid, "email": payload.email, "last_read_at": datetime.now(timezone.utc)}},
        upsert=True,
    )
    return {"ok": True}


@app.post("/channels/{channel_id}/attachments", response_model=AttachmentUploadResponse)
@limiter.limit("20/minute")
async def upload_channel_attachment(
    request: Request,
    channel_id: str,
    file: UploadFile = File(...),
    uploader_email: str = Form(...),
    kind: str = Form("file"),
):
    """Uploads a file share or a recorded voice message (same endpoint —
    kind distinguishes how the frontend renders it) to Cloudinary, then
    returns the URL to attach to a message via POST .../messages.
    Deliberately a separate step from posting the message itself, mirroring
    the existing Discovery Snapshot upload-then-log pattern."""
    db = get_db()
    if db is None:
        raise HTTPException(status_code=503, detail="Team workspace is unavailable right now")

    oid, doc = _require_channel(db, channel_id)
    if uploader_email not in doc.get("members", []):
        raise HTTPException(status_code=403, detail="Only channel members can upload attachments")

    if kind not in VALID_ATTACHMENT_KINDS:
        kind = "file"

    raw_bytes = await file.read()
    if len(raw_bytes) > MAX_ATTACHMENT_BYTES:
        raise HTTPException(
            status_code=413,
            detail="Attachments are capped at 15MB to protect the shared Cloudinary free-tier quota",
        )

    try:
        upload_result = upload_chat_attachment(raw_bytes, filename=file.filename or "attachment")
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Cloudinary upload failed: {exc}")

    return AttachmentUploadResponse(
        url=upload_result["url"],
        name=file.filename or "attachment",
        kind=kind,
        public_id=upload_result["public_id"],
    )


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

    reply_preview = None
    reply_to_oid = None
    if payload.reply_to:
        try:
            reply_to_oid = ObjectId(payload.reply_to)
        except InvalidId:
            raise HTTPException(status_code=400, detail="Invalid reply_to id")
        replied = db["messages"].find_one({"_id": reply_to_oid, "channel_id": oid})
        if replied is None:
            raise HTTPException(status_code=404, detail="The message being replied to no longer exists")
        # Snapshot the replied-to sender/text at send time, so rendering a
        # reply never needs a second lookup (and still reads fine even if
        # the original is later deleted).
        reply_preview = {
            "message_id": str(replied["_id"]),
            "sender_email": replied.get("sender_email", ""),
            "text": "[deleted]" if replied.get("deleted") else replied.get("text", "")[:200],
        }

    record = {
        "channel_id": oid,
        "sender_email": payload.sender_email,
        "text": payload.text,
        "attachments": [a.model_dump() for a in payload.attachments],
        "created_at": datetime.now(timezone.utc),
        "reply_to": reply_to_oid,
        "reply_preview": reply_preview,
        "pinned": False,
        "deleted": False,
        "forwarded_from": None,
    }
    result = db["messages"].insert_one(record)
    record["_id"] = result.inserted_id
    return _message_to_response(record)


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
    new since the last poll instead of re-fetching the whole history.
    Deleted messages are still returned (as a "[deleted]" tombstone) so a
    reply chain or forward that references one doesn't break — moderation
    here is disclosed, not silently erased."""
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
    return [_message_to_response(m) for m in docs]


@app.delete("/messages/{message_id}")
@limiter.limit("30/minute")
async def delete_message(request: Request, message_id: str, requested_by: str):
    """Soft delete only — the sender or a channel admin can remove a
    message's content, but the record stays (as a tombstone) so reply
    chains, forwards, and moderation history all stay coherent. This
    mirrors the ownership-checked delete pattern already used for clips."""
    db = get_db()
    if db is None:
        raise HTTPException(status_code=503, detail="Team workspace is unavailable right now")

    m_oid, m_doc = _require_message(db, message_id)
    _, channel_doc = _require_channel(db, str(m_doc["channel_id"]))

    if requested_by != m_doc.get("sender_email") and not _is_admin(channel_doc, requested_by):
        raise HTTPException(status_code=403, detail="Only the sender or a channel admin can delete this message")

    db["messages"].update_one({"_id": m_oid}, {"$set": {"deleted": True, "pinned": False}})
    return {"deleted": True}


@app.post("/messages/{message_id}/pin", response_model=MessageResponse)
@limiter.limit("30/minute")
async def pin_message(request: Request, message_id: str, requested_by: str):
    db = get_db()
    if db is None:
        raise HTTPException(status_code=503, detail="Team workspace is unavailable right now")

    m_oid, m_doc = _require_message(db, message_id)
    _, channel_doc = _require_channel(db, str(m_doc["channel_id"]))
    if requested_by not in channel_doc.get("members", []):
        raise HTTPException(status_code=403, detail="Only channel members can pin a message")
    if m_doc.get("deleted"):
        raise HTTPException(status_code=400, detail="Can't pin a deleted message")

    db["messages"].update_one({"_id": m_oid}, {"$set": {"pinned": True}})
    m_doc = db["messages"].find_one({"_id": m_oid})
    return _message_to_response(m_doc)


@app.post("/messages/{message_id}/unpin", response_model=MessageResponse)
@limiter.limit("30/minute")
async def unpin_message(request: Request, message_id: str, requested_by: str):
    db = get_db()
    if db is None:
        raise HTTPException(status_code=503, detail="Team workspace is unavailable right now")

    m_oid, m_doc = _require_message(db, message_id)
    _, channel_doc = _require_channel(db, str(m_doc["channel_id"]))
    if requested_by not in channel_doc.get("members", []):
        raise HTTPException(status_code=403, detail="Only channel members can unpin a message")

    db["messages"].update_one({"_id": m_oid}, {"$set": {"pinned": False}})
    m_doc = db["messages"].find_one({"_id": m_oid})
    return _message_to_response(m_doc)


@app.get("/channels/{channel_id}/pinned-messages", response_model=List[MessageResponse])
@limiter.limit("60/minute")
async def list_pinned_messages(request: Request, channel_id: str, requester_email: str):
    db = get_db()
    if db is None:
        return []

    oid, doc = _require_channel(db, channel_id)
    if requester_email not in doc.get("members", []):
        raise HTTPException(status_code=403, detail="Only channel members can view pinned messages")

    docs = db["messages"].find({"channel_id": oid, "pinned": True}).sort("created_at", -1).limit(50)
    return [_message_to_response(m) for m in docs]


@app.post("/messages/{message_id}/forward", response_model=MessageResponse)
@limiter.limit("30/minute")
async def forward_message(request: Request, message_id: str, payload: ForwardMessageRequest):
    """Copies a message's content into another channel. The requester must
    be a member of both the source and target channel — forwarding
    shouldn't be a way to leak a private channel's content into one you
    don't actually belong to, or to inject a message into a channel you're
    not part of."""
    db = get_db()
    if db is None:
        raise HTTPException(status_code=503, detail="Team workspace is unavailable right now")

    m_oid, m_doc = _require_message(db, message_id)
    if m_doc.get("deleted"):
        raise HTTPException(status_code=400, detail="Can't forward a deleted message")

    _, source_channel = _require_channel(db, str(m_doc["channel_id"]))
    if payload.forwarded_by not in source_channel.get("members", []):
        raise HTTPException(status_code=403, detail="You're not a member of the source channel")

    target_oid, target_channel = _require_channel(db, payload.target_channel_id)
    if payload.forwarded_by not in target_channel.get("members", []):
        raise HTTPException(status_code=403, detail="You're not a member of the target channel")

    record = {
        "channel_id": target_oid,
        "sender_email": payload.forwarded_by,
        "text": m_doc.get("text", ""),
        "attachments": m_doc.get("attachments", []),
        "created_at": datetime.now(timezone.utc),
        "reply_to": None,
        "reply_preview": None,
        "pinned": False,
        "deleted": False,
        "forwarded_from": {
            "channel_id": str(m_doc["channel_id"]),
            "sender_email": m_doc.get("sender_email", ""),
        },
    }
    result = db["messages"].insert_one(record)
    record["_id"] = result.inserted_id
    return _message_to_response(record)


@app.post("/messages/{message_id}/report", response_model=ReportResponse)
@limiter.limit("20/minute")
async def report_message(request: Request, message_id: str, payload: ReportMessageRequest):
    db = get_db()
    if db is None:
        raise HTTPException(status_code=503, detail="Team workspace is unavailable right now")

    m_oid, m_doc = _require_message(db, message_id)
    _, channel_doc = _require_channel(db, str(m_doc["channel_id"]))
    if payload.reported_by not in channel_doc.get("members", []):
        raise HTTPException(status_code=403, detail="Only channel members can report a message")

    record = {
        "message_id": m_oid,
        "channel_id": m_doc["channel_id"],
        "reported_by": payload.reported_by,
        "reason": payload.reason,
        "created_at": datetime.now(timezone.utc),
        "resolved": False,
    }
    result = db["reports"].insert_one(record)
    return ReportResponse(
        id=str(result.inserted_id),
        message_id=str(m_oid),
        channel_id=str(m_doc["channel_id"]),
        reported_by=payload.reported_by,
        reason=payload.reason,
        created_at=record["created_at"].isoformat(),
        resolved=False,
    )


@app.get("/channels/{channel_id}/reports", response_model=List[ReportResponse])
@limiter.limit("30/minute")
async def list_channel_reports(request: Request, channel_id: str, requester_email: str):
    """Admin-only — reports are a moderation tool, not something every
    member browses."""
    db = get_db()
    if db is None:
        return []

    oid, doc = _require_channel(db, channel_id)
    if not _is_admin(doc, requester_email):
        raise HTTPException(status_code=403, detail="Only a channel admin can view reports")

    docs = db["reports"].find({"channel_id": oid}).sort("created_at", -1).limit(200)
    return [
        ReportResponse(
            id=str(r["_id"]),
            message_id=str(r["message_id"]),
            channel_id=str(r["channel_id"]),
            reported_by=r.get("reported_by", ""),
            reason=r.get("reason", ""),
            created_at=r["created_at"].isoformat() if r.get("created_at") else "",
            resolved=r.get("resolved", False),
        )
        for r in docs
    ]


@app.post("/reports/{report_id}/resolve", response_model=ReportResponse)
@limiter.limit("30/minute")
async def resolve_report(request: Request, report_id: str, requested_by: str, action: str = "dismiss"):
    """Admin-only. action="dismiss" just closes the report; action=
    "delete_message" also soft-deletes the reported message."""
    db = get_db()
    if db is None:
        raise HTTPException(status_code=503, detail="Team workspace is unavailable right now")

    try:
        r_oid = ObjectId(report_id)
    except InvalidId:
        raise HTTPException(status_code=400, detail="Invalid report id")
    report_doc = db["reports"].find_one({"_id": r_oid})
    if report_doc is None:
        raise HTTPException(status_code=404, detail="Report not found")

    _, channel_doc = _require_channel(db, str(report_doc["channel_id"]))
    if not _is_admin(channel_doc, requested_by):
        raise HTTPException(status_code=403, detail="Only a channel admin can resolve a report")

    if action == "delete_message":
        db["messages"].update_one({"_id": report_doc["message_id"]}, {"$set": {"deleted": True, "pinned": False}})

    db["reports"].update_one({"_id": r_oid}, {"$set": {"resolved": True}})
    report_doc = db["reports"].find_one({"_id": r_oid})
    return ReportResponse(
        id=str(report_doc["_id"]),
        message_id=str(report_doc["message_id"]),
        channel_id=str(report_doc["channel_id"]),
        reported_by=report_doc.get("reported_by", ""),
        reason=report_doc.get("reason", ""),
        created_at=report_doc["created_at"].isoformat() if report_doc.get("created_at") else "",
        resolved=report_doc.get("resolved", False),
    )


@app.post("/presence/heartbeat")
@limiter.limit("120/minute")
async def presence_heartbeat(request: Request, payload: HeartbeatRequest):
    """Fire-and-forget ping the frontend sends every ~30s while a
    researcher has the workspace open in an active tab. Only touches
    last_seen — never overwrites a manually-set status, so setting
    yourself to "Busy" doesn't get silently reset by the next heartbeat."""
    db = get_db()
    if db is None:
        return {"ok": False}

    db["presence"].update_one(
        {"email": payload.email},
        {"$set": {"email": payload.email, "last_seen": datetime.now(timezone.utc)}},
        upsert=True,
    )
    return {"ok": True}


@app.post("/presence/status")
@limiter.limit("30/minute")
async def set_presence_status(request: Request, payload: PresenceStatusRequest):
    """Manually setting a status (Active/Away/Busy/Offline) — the Slack/
    Teams-style override on top of heartbeat-derived online/offline."""
    if payload.status not in VALID_MANUAL_STATUSES:
        raise HTTPException(status_code=400, detail=f"status must be one of {sorted(VALID_MANUAL_STATUSES)}")

    db = get_db()
    if db is None:
        return {"ok": False}

    db["presence"].update_one(
        {"email": payload.email},
        {
            "$set": {
                "email": payload.email,
                "manual_status": payload.status,
                "last_seen": datetime.now(timezone.utc),
            }
        },
        upsert=True,
    )
    return {"ok": True}


@app.get("/presence", response_model=List[PresenceEntry])
@limiter.limit("120/minute")
async def get_presence(request: Request, emails: str):
    """emails is a comma-separated list, e.g. from a channel's member
    list. Anyone with no heartbeat on record at all is reported offline
    with no last_seen rather than omitted, so the frontend can still
    render them in the member list."""
    requested = [e.strip() for e in emails.split(",") if e.strip()]
    if not requested:
        return []

    db = get_db()
    now = datetime.now(timezone.utc)
    if db is None:
        return [PresenceEntry(email=e, online=False, status="offline", last_seen=None) for e in requested]

    docs = {d["email"]: d for d in db["presence"].find({"email": {"$in": requested}})}

    results = []
    for email in requested:
        doc = docs.get(email)
        online, status = _compute_presence(doc, now)
        last_seen = doc.get("last_seen") if doc else None
        results.append(
            PresenceEntry(
                email=email,
                online=online,
                status=status,
                last_seen=last_seen.isoformat() if last_seen else None,
            )
        )
    return results


# ---------------------------------------------------------------------------
# Calls & Meetings — built on meet.jit.si, the free public Jitsi Meet
# instance: no account, no card, no per-minute metering, no time limit,
# open source. This backend never talks to Jitsi directly — it only hands
# the frontend a room name and lets the browser embed Jitsi's own IFrame
# API (loaded from meet.jit.si), so there's no signaling/TURN/STUN
# infrastructure for Telesto to run or pay for.
#
# Room names are HMAC'd from the channel id using the same
# INTERNAL_SYNC_SECRET already configured for the GitHub Actions species
# sync, rather than a raw/guessable slug — meet.jit.si rooms have no
# access control of their own, so an unguessable name is the only thing
# standing between "private team call" and "anyone who finds the URL".
# Scheduled meetings get their own one-off room per meeting for the same
# reason.
#
# Calendar integration is a downloadable .ics file, not a Google/Outlook
# API integration — zero OAuth, zero new credentials, and it works with
# every calendar app that exists.
# ---------------------------------------------------------------------------


def _call_room_for_channel(channel_id: str) -> str:
    """Stable, non-guessable Jitsi room name for a channel's persistent
    "start/join a call" room — same channel always maps to the same room,
    so anyone clicking "Join call" lands in the same place."""
    digest = hmac.new(INTERNAL_SYNC_SECRET.encode(), channel_id.encode(), hashlib.sha256).hexdigest()
    return f"telesto-node-{digest[:20]}"


def _build_ics(meeting_doc) -> str:
    """Hand-rolled minimal RFC 5545 VEVENT — one dependency-free function
    beats pulling in a calendar library for a single event type."""
    def fmt(dt):
        return dt.strftime("%Y%m%dT%H%M%SZ")

    start = meeting_doc["scheduled_at"]
    end = start + timedelta(minutes=meeting_doc.get("duration_minutes", 30))
    join_url = f"https://meet.jit.si/{meeting_doc['jitsi_room']}"
    description = f"Join: {join_url}".replace(",", "\\,")
    summary = meeting_doc.get("title", "Telesto Node meeting").replace(",", "\\,")

    lines = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//Telesto Node//Team Workspace//EN",
        "BEGIN:VEVENT",
        f"UID:{meeting_doc['_id']}@telesto-node",
        f"DTSTAMP:{fmt(datetime.now(timezone.utc))}",
        f"DTSTART:{fmt(start)}",
        f"DTEND:{fmt(end)}",
        f"SUMMARY:{summary}",
        f"DESCRIPTION:{description}",
        f"URL:{join_url}",
        "END:VEVENT",
        "END:VCALENDAR",
    ]
    return "\r\n".join(lines)


class CallRoomResponse(BaseModel):
    room: str
    join_url: str


class MeetingCreateRequest(BaseModel):
    title: str
    scheduled_at: str  # ISO timestamp
    duration_minutes: int = 30
    created_by: str
    attendee_emails: List[str] = []  # empty = every current channel member


class MeetingResponse(BaseModel):
    id: str
    channel_id: str
    title: str
    scheduled_at: str
    duration_minutes: int
    created_by: str
    attendees: List[str]
    jitsi_room: str
    join_url: str
    created_at: str


def _meeting_to_response(doc) -> MeetingResponse:
    return MeetingResponse(
        id=str(doc["_id"]),
        channel_id=str(doc["channel_id"]),
        title=doc.get("title", "Untitled meeting"),
        scheduled_at=doc["scheduled_at"].isoformat() if doc.get("scheduled_at") else "",
        duration_minutes=doc.get("duration_minutes", 30),
        created_by=doc.get("created_by", ""),
        attendees=doc.get("attendees", []),
        jitsi_room=doc.get("jitsi_room", ""),
        join_url=f"https://meet.jit.si/{doc.get('jitsi_room', '')}",
        created_at=doc["created_at"].isoformat() if doc.get("created_at") else "",
    )


@app.get("/channels/{channel_id}/call-room", response_model=CallRoomResponse)
@limiter.limit("60/minute")
async def get_call_room(request: Request, channel_id: str, requester_email: str):
    """The persistent ad-hoc room for this channel — every member always
    gets the same room name back, so "Start a call" and "Join call" are
    the same button for everyone."""
    db = get_db()
    if db is None:
        raise HTTPException(status_code=503, detail="Team workspace is unavailable right now")

    _, doc = _require_channel(db, channel_id)
    if requester_email not in doc.get("members", []):
        raise HTTPException(status_code=403, detail="Only channel members can start or join a call here")

    room = _call_room_for_channel(channel_id)
    return CallRoomResponse(room=room, join_url=f"https://meet.jit.si/{room}")


@app.post("/channels/{channel_id}/meetings", response_model=MeetingResponse)
@limiter.limit("20/minute")
async def create_meeting(request: Request, channel_id: str, payload: MeetingCreateRequest):
    db = get_db()
    if db is None:
        raise HTTPException(status_code=503, detail="Team workspace is unavailable right now")

    oid, doc = _require_channel(db, channel_id)
    if payload.created_by not in doc.get("members", []):
        raise HTTPException(status_code=403, detail="Only channel members can schedule a meeting")

    try:
        scheduled_at = datetime.fromisoformat(payload.scheduled_at.replace("Z", "+00:00"))
    except ValueError:
        raise HTTPException(status_code=400, detail="scheduled_at must be an ISO timestamp")

    attendees = payload.attendee_emails or doc.get("members", [])
    # Each meeting gets its own unguessable room, separate from the
    # channel's persistent ad-hoc call room.
    jitsi_room = f"telesto-node-{secrets.token_urlsafe(9)}"

    record = {
        "channel_id": oid,
        "title": payload.title,
        "scheduled_at": scheduled_at,
        "duration_minutes": payload.duration_minutes,
        "created_by": payload.created_by,
        "attendees": attendees,
        "jitsi_room": jitsi_room,
        "created_at": datetime.now(timezone.utc),
    }
    result = db["meetings"].insert_one(record)
    record["_id"] = result.inserted_id
    return _meeting_to_response(record)


@app.get("/channels/{channel_id}/meetings", response_model=List[MeetingResponse])
@limiter.limit("60/minute")
async def list_meetings(request: Request, channel_id: str, requester_email: str):
    db = get_db()
    if db is None:
        return []

    oid, doc = _require_channel(db, channel_id)
    if requester_email not in doc.get("members", []):
        raise HTTPException(status_code=403, detail="Only channel members can view this channel's meetings")

    docs = db["meetings"].find({"channel_id": oid}).sort("scheduled_at", 1).limit(200)
    return [_meeting_to_response(m) for m in docs]


@app.delete("/meetings/{meeting_id}")
@limiter.limit("20/minute")
async def cancel_meeting(request: Request, meeting_id: str, requested_by: str):
    """The meeting's creator or a channel admin can cancel it."""
    db = get_db()
    if db is None:
        raise HTTPException(status_code=503, detail="Team workspace is unavailable right now")

    try:
        m_oid = ObjectId(meeting_id)
    except InvalidId:
        raise HTTPException(status_code=400, detail="Invalid meeting id")
    meeting_doc = db["meetings"].find_one({"_id": m_oid})
    if meeting_doc is None:
        raise HTTPException(status_code=404, detail="Meeting not found")

    _, channel_doc = _require_channel(db, str(meeting_doc["channel_id"]))
    if requested_by != meeting_doc.get("created_by") and not _is_admin(channel_doc, requested_by):
        raise HTTPException(status_code=403, detail="Only the organizer or a channel admin can cancel this meeting")

    db["meetings"].delete_one({"_id": m_oid})
    return {"deleted": True}


@app.get("/meetings/{meeting_id}/ics")
@limiter.limit("30/minute")
async def download_meeting_ics(request: Request, meeting_id: str, requester_email: str):
    """A plain .ics file — no Google/Outlook API, no OAuth. Works with
    every calendar app; the researcher imports it themselves."""
    db = get_db()
    if db is None:
        raise HTTPException(status_code=503, detail="Team workspace is unavailable right now")

    try:
        m_oid = ObjectId(meeting_id)
    except InvalidId:
        raise HTTPException(status_code=400, detail="Invalid meeting id")
    meeting_doc = db["meetings"].find_one({"_id": m_oid})
    if meeting_doc is None:
        raise HTTPException(status_code=404, detail="Meeting not found")

    _, channel_doc = _require_channel(db, str(meeting_doc["channel_id"]))
    if requester_email not in channel_doc.get("members", []):
        raise HTTPException(status_code=403, detail="Only channel members can download this invite")

    ics_body = _build_ics(meeting_doc)
    return Response(
        content=ics_body,
        media_type="text/calendar",
        headers={"Content-Disposition": f'attachment; filename="{meeting_doc.get("title", "meeting")}.ics"'},
    )


# ---------------------------------------------------------------------------
# Bioacoustic analysis — SurfPerch-based similarity search, not species
# classification. See app/bioacoustics.py for the full rationale and the
# real free-tier risks (untested against Render's 512MB free instance,
# in particular). A researcher uploads a short reference clip of a known
# sound, then can search a longer recording for acoustically similar
# moments. Every result carries an explicit "similarity, not
# identification" caveat.
# ---------------------------------------------------------------------------

MAX_ACOUSTIC_UPLOAD_BYTES = 20 * 1024 * 1024  # 20MB
MAX_ACOUSTIC_AUDIO_SECONDS = 180  # 3 minutes — keeps live CPU inference within a single request


class AcousticReferenceResponse(BaseModel):
    id: str
    channel_id: str
    label: str
    created_by: str
    created_at: str


class AcousticMatch(BaseModel):
    start_seconds: float
    score: float


class AcousticAnalysisResponse(BaseModel):
    reference_label: str
    threshold: float
    matches: List[AcousticMatch]
    windows_analyzed: int
    warning: str
    # Soundscape/signal metrics computed directly from the uploaded
    # clip's audio (see app/bioacoustics.py's analyze_soundscape) —
    # independent of the similarity search above and carries its own,
    # different confidence level: these are measured, not model output.
    metrics: dict


class AcousticMetricsResponse(BaseModel):
    """Standalone soundscape/signal-metrics response — no reference clip
    or channel required. This is the solo Mission Control path: a
    researcher can drop in one recording and get NDSI/ACI/ADI/AEI, level
    metrics, and pulse-based signal metrics without needing a Team
    Workspace channel or a saved reference sound library."""

    duration_seconds: float
    metrics: dict
    warning: str


@app.post("/channels/{channel_id}/acoustic-references", response_model=AcousticReferenceResponse)
@limiter.limit("10/minute")
async def create_acoustic_reference(
    request: Request,
    channel_id: str,
    file: UploadFile = File(...),
    label: str = Form(...),
    created_by: str = Form(...),
):
    """Uploads a short reference clip of a known call/sound (a few
    seconds is enough) and stores its SurfPerch embedding, so later
    recordings can be searched for acoustically similar moments."""
    db = get_db()
    if db is None:
        raise HTTPException(status_code=503, detail="Team workspace is unavailable right now")

    _, channel_doc = _require_channel(db, channel_id)
    if created_by not in channel_doc.get("members", []):
        raise HTTPException(status_code=403, detail="Only channel members can add a reference sound")

    raw_bytes = await file.read()
    try:
        waveform = load_waveform(raw_bytes)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    try:
        windows = embed_windows(waveform)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Embedding failed: {exc}")
    if not windows:
        raise HTTPException(status_code=400, detail="That clip was too short to embed")

    # Average across windows so a multi-call reference clip still yields
    # one representative embedding.
    reference_embedding = np.mean([w[1] for w in windows], axis=0)

    record = {
        "channel_id": ObjectId(channel_id),
        "label": label,
        "embedding": embedding_to_list(reference_embedding),
        "created_by": created_by,
        "created_at": datetime.now(timezone.utc),
    }
    result = db["acoustic_references"].insert_one(record)
    return AcousticReferenceResponse(
        id=str(result.inserted_id),
        channel_id=channel_id,
        label=label,
        created_by=created_by,
        created_at=record["created_at"].isoformat(),
    )


@app.get("/channels/{channel_id}/acoustic-references", response_model=List[AcousticReferenceResponse])
@limiter.limit("30/minute")
async def list_acoustic_references(request: Request, channel_id: str, requester_email: str):
    db = get_db()
    if db is None:
        return []

    _, channel_doc = _require_channel(db, channel_id)
    if requester_email not in channel_doc.get("members", []):
        raise HTTPException(status_code=403, detail="Only channel members can view reference sounds")

    docs = db["acoustic_references"].find({"channel_id": ObjectId(channel_id)}).sort("created_at", -1)
    return [
        AcousticReferenceResponse(
            id=str(d["_id"]),
            channel_id=channel_id,
            label=d.get("label", ""),
            created_by=d.get("created_by", ""),
            created_at=d["created_at"].isoformat() if d.get("created_at") else "",
        )
        for d in docs
    ]


@app.delete("/acoustic-references/{reference_id}")
@limiter.limit("20/minute")
async def delete_acoustic_reference(request: Request, reference_id: str, requested_by: str):
    db = get_db()
    if db is None:
        raise HTTPException(status_code=503, detail="Team workspace is unavailable right now")

    try:
        r_oid = ObjectId(reference_id)
    except InvalidId:
        raise HTTPException(status_code=400, detail="Invalid reference id")
    ref_doc = db["acoustic_references"].find_one({"_id": r_oid})
    if ref_doc is None:
        raise HTTPException(status_code=404, detail="Reference sound not found")

    _, channel_doc = _require_channel(db, str(ref_doc["channel_id"]))
    if requested_by != ref_doc.get("created_by") and not _is_admin(channel_doc, requested_by):
        raise HTTPException(status_code=403, detail="Only the uploader or a channel admin can delete this")

    db["acoustic_references"].delete_one({"_id": r_oid})
    return {"deleted": True}


@app.post("/channels/{channel_id}/acoustic-analysis", response_model=AcousticAnalysisResponse)
@limiter.limit("5/minute")
async def analyze_acoustic_clip(
    request: Request,
    channel_id: str,
    file: UploadFile = File(...),
    reference_id: str = Form(...),
    requester_email: str = Form(...),
    threshold: float = Form(0.6),
):
    """Synchronous by design for this first pass — CPU inference on a
    free Render instance is slow, so this deliberately caps duration
    rather than queuing background jobs, to keep the request from timing
    out. If clips longer than 3 minutes turn out to be the common case,
    this needs a real background job queue, not a bigger timeout."""
    db = get_db()
    if db is None:
        raise HTTPException(status_code=503, detail="Team workspace is unavailable right now")

    _, channel_doc = _require_channel(db, channel_id)
    if requester_email not in channel_doc.get("members", []):
        raise HTTPException(status_code=403, detail="Only channel members can run acoustic analysis")

    try:
        ref_oid = ObjectId(reference_id)
    except InvalidId:
        raise HTTPException(status_code=400, detail="Invalid reference id")
    ref_doc = db["acoustic_references"].find_one({"_id": ref_oid, "channel_id": ObjectId(channel_id)})
    if ref_doc is None:
        raise HTTPException(status_code=404, detail="Reference sound not found in this channel")

    raw_bytes = await file.read()
    if len(raw_bytes) > MAX_ACOUSTIC_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="Clip is too large for live analysis — keep it under 20MB")

    try:
        waveform = load_waveform(raw_bytes)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    duration_seconds = len(waveform) / SAMPLE_RATE
    if duration_seconds > MAX_ACOUSTIC_AUDIO_SECONDS:
        raise HTTPException(
            status_code=413,
            detail=f"Clips over {MAX_ACOUSTIC_AUDIO_SECONDS}s aren't analyzed live on the free tier — trim it first",
        )

    reference_embedding = embedding_from_list(ref_doc["embedding"])
    try:
        matches = find_similar_windows(waveform, reference_embedding, threshold=threshold)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Analysis failed: {exc}")

    windows_analyzed = max(1, int(np.ceil(len(waveform) / (SAMPLE_RATE * WINDOW_SECONDS))))

    try:
        soundscape_metrics = analyze_soundscape(waveform, SAMPLE_RATE)
    except Exception as exc:
        # Metrics are a plain-DSP add-on to the similarity search above —
        # don't fail the whole request (which the researcher is actively
        # waiting on) just because one of the newer metric functions hit
        # an edge case on this clip. Similarity search still returns.
        print(f"[bioacoustics] soundscape metrics failed, omitting: {exc}")
        soundscape_metrics = {}

    return AcousticAnalysisResponse(
        reference_label=ref_doc.get("label", ""),
        threshold=threshold,
        matches=[AcousticMatch(**m) for m in matches],
        windows_analyzed=windows_analyzed,
        warning="Similarity search only, not a calibrated species classifier — verify matches by ear before citing them.",
        metrics=soundscape_metrics,
    )


@app.post("/acoustic-metrics", response_model=AcousticMetricsResponse)
@limiter.limit("10/minute")
async def acoustic_metrics(
    request: Request,
    file: UploadFile = File(...),
    calibration_offset_db: float | None = Form(None),
):
    """Standalone soundscape + signal metrics for one uploaded clip — no
    channel, no reference sound, no Team Workspace membership required.
    This is the solo Mission Control path (see app/bioacoustics.py's
    analyze_soundscape): a researcher working alone can still get
    NDSI/ACI/ADI/AEI, level metrics, and pulse-based signal metrics.

    calibration_offset_db is optional — only pass it if you actually
    know your hydrophone's calibration offset. Without it, level metrics
    are relative (dBFS), not true SPL re 1 uPa; see analyze_soundscape's
    module-level docstring for why that distinction matters."""
    raw_bytes = await file.read()
    if len(raw_bytes) > MAX_ACOUSTIC_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="Clip is too large for live analysis — keep it under 20MB")

    try:
        waveform = load_waveform(raw_bytes)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    duration_seconds = len(waveform) / SAMPLE_RATE
    if duration_seconds > MAX_ACOUSTIC_AUDIO_SECONDS:
        raise HTTPException(
            status_code=413,
            detail=f"Clips over {MAX_ACOUSTIC_AUDIO_SECONDS}s aren't analyzed live on the free tier — trim it first",
        )

    try:
        metrics = analyze_soundscape(waveform, SAMPLE_RATE, calibration_offset_db=calibration_offset_db)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Metrics computation failed: {exc}")

    return AcousticMetricsResponse(
        duration_seconds=duration_seconds,
        metrics=metrics,
        warning=(
            "Signal/soundscape metrics only — no species similarity search run "
            "(that needs a reference clip and a Team Workspace channel). "
            "Level metrics are relative unless a calibration offset was supplied."
        ),
    )


class StandaloneSimilarityResponse(BaseModel):
    threshold: float
    matches: List[AcousticMatch]
    windows_analyzed: int
    warning: str


@app.post("/acoustic-similarity", response_model=StandaloneSimilarityResponse)
@limiter.limit("5/minute")
async def standalone_acoustic_similarity(
    request: Request,
    reference_file: UploadFile = File(...),
    target_file: UploadFile = File(...),
    threshold: float = Form(0.6),
):
    """One-off similarity search for solo Mission Control use — both clips
    are uploaded together in the same request, the reference embedding is
    computed and used only for this call, and nothing is written to
    Mongo. This is the deliberate trade-off of session-only mode: no
    persisted reference library (so nothing to manage or clean up
    outside a Team Workspace channel), at the cost of re-uploading the
    reference clip every time. Embedded-in-a-channel mode still uses the
    persisted /channels/{id}/acoustic-references + /acoustic-analysis
    routes for a reusable library."""
    reference_bytes = await reference_file.read()
    target_bytes = await target_file.read()

    if len(target_bytes) > MAX_ACOUSTIC_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="Target clip is too large for live analysis — keep it under 20MB")

    try:
        reference_waveform = load_waveform(reference_bytes)
        target_waveform = load_waveform(target_bytes)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    duration_seconds = len(target_waveform) / SAMPLE_RATE
    if duration_seconds > MAX_ACOUSTIC_AUDIO_SECONDS:
        raise HTTPException(
            status_code=413,
            detail=f"Clips over {MAX_ACOUSTIC_AUDIO_SECONDS}s aren't analyzed live on the free tier — trim it first",
        )

    try:
        reference_windows = embed_windows(reference_waveform)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Embedding failed: {exc}")
    if not reference_windows:
        raise HTTPException(status_code=400, detail="Reference clip was too short to embed")
    reference_embedding = np.mean([w[1] for w in reference_windows], axis=0)

    try:
        matches = find_similar_windows(target_waveform, reference_embedding, threshold=threshold)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Analysis failed: {exc}")

    windows_analyzed = max(1, int(np.ceil(len(target_waveform) / (SAMPLE_RATE * WINDOW_SECONDS))))

    return StandaloneSimilarityResponse(
        threshold=threshold,
        matches=[AcousticMatch(**m) for m in matches],
        windows_analyzed=windows_analyzed,
        warning="Similarity search only, not a calibrated species classifier — verify matches by ear before citing them.",
    )


# ---------------------------------------------------------------------------
# Acoustic-context tooling — the interspecies-research side of "translation
# tools", and deliberately NOT a translator. See app/bioacoustics.py's
# rhythm-comparison section for the full rationale: this lets researchers
# attach behavioral context (depth, movement, feeding, social activity) to
# an analyzed clip's rhythm signature, and quantitatively compare timing
# structure between clips (tempo, "rubato", extra clicks) — the same raw
# material coda research works from, without claiming to interpret what
# any of it means.
#
# Persisted (POST/GET/DELETE .../acoustic-events, .../compare) only when
# embedded in a Team Workspace channel — same mine/shared-library pattern
# as acoustic references and clips. Standalone Mission Control gets the
# comparison math itself (/acoustic-rhythm-compare) without persistence,
# consistent with everything else session-only in that context.
# ---------------------------------------------------------------------------


class BehavioralContext(BaseModel):
    depth_m: float | None = None
    movement: str | None = None  # freeform: "stationary" | "traveling" | "diving" | "surfacing" | etc.
    feeding: bool | None = None
    social: str | None = None  # freeform: "solo" | "social" | etc.
    notes: str = ""


class CreateAcousticEventRequest(BaseModel):
    label: str = ""
    created_by: str
    context: BehavioralContext
    # The rhythm-relevant slice of an already-computed analyze_soundscape()
    # result — the frontend passes this straight through from a prior
    # /acoustic-metrics or /channels/{id}/acoustic-analysis response rather
    # than re-uploading and re-analyzing the audio just to save it.
    ici_ms: List[float] = []
    duration_seconds: float | None = None


class AcousticEventResponse(BaseModel):
    id: str
    channel_id: str
    label: str
    created_by: str
    created_at: str
    context: BehavioralContext
    rhythm_signature: dict
    ici_ms: List[float]


def _event_doc_to_response(doc, channel_id: str) -> AcousticEventResponse:
    return AcousticEventResponse(
        id=str(doc["_id"]),
        channel_id=channel_id,
        label=doc.get("label", ""),
        created_by=doc.get("created_by", ""),
        created_at=doc["created_at"].isoformat() if doc.get("created_at") else "",
        context=BehavioralContext(**doc.get("context", {})),
        rhythm_signature=doc.get("rhythm_signature", {}),
        ici_ms=doc.get("ici_ms", []),
    )


@app.post("/channels/{channel_id}/acoustic-events", response_model=AcousticEventResponse)
@limiter.limit("20/minute")
async def create_acoustic_event(request: Request, channel_id: str, payload: CreateAcousticEventRequest):
    """Saves behavioral context alongside an already-computed rhythm
    signature, shared with the channel. Doesn't store the audio itself —
    just the timing data and the researcher's tags — keeping this off
    Cloudinary's free-tier quota entirely, at the cost of no playback
    from here later. If audio playback alongside a saved event turns out
    to matter in practice, that's a real follow-up (upload to Cloudinary
    the same way clips/snapshots already do), not something assumed
    unnecessary — just not built speculatively before it's asked for."""
    db = get_db()
    if db is None:
        raise HTTPException(status_code=503, detail="Team workspace is unavailable right now")

    _, channel_doc = _require_channel(db, channel_id)
    if payload.created_by not in channel_doc.get("members", []):
        raise HTTPException(status_code=403, detail="Only channel members can log acoustic events")

    record = {
        "channel_id": ObjectId(channel_id),
        "label": payload.label,
        "created_by": payload.created_by,
        "created_at": datetime.now(timezone.utc),
        "context": payload.context.model_dump(),
        "ici_ms": payload.ici_ms,
        "rhythm_signature": compute_rhythm_signature(payload.ici_ms),
    }
    result = db["acoustic_events"].insert_one(record)
    record["_id"] = result.inserted_id
    return _event_doc_to_response(record, channel_id)


@app.get("/channels/{channel_id}/acoustic-events", response_model=List[AcousticEventResponse])
@limiter.limit("30/minute")
async def list_acoustic_events(request: Request, channel_id: str, requester_email: str):
    db = get_db()
    if db is None:
        return []

    _, channel_doc = _require_channel(db, channel_id)
    if requester_email not in channel_doc.get("members", []):
        raise HTTPException(status_code=403, detail="Only channel members can view acoustic events")

    docs = db["acoustic_events"].find({"channel_id": ObjectId(channel_id)}).sort("created_at", -1)
    return [_event_doc_to_response(d, channel_id) for d in docs]


@app.delete("/acoustic-events/{event_id}")
@limiter.limit("20/minute")
async def delete_acoustic_event(request: Request, event_id: str, requested_by: str):
    db = get_db()
    if db is None:
        raise HTTPException(status_code=503, detail="Team workspace is unavailable right now")

    try:
        e_oid = ObjectId(event_id)
    except InvalidId:
        raise HTTPException(status_code=400, detail="Invalid event id")
    event_doc = db["acoustic_events"].find_one({"_id": e_oid})
    if event_doc is None:
        raise HTTPException(status_code=404, detail="Acoustic event not found")

    _, channel_doc = _require_channel(db, str(event_doc["channel_id"]))
    if requested_by != event_doc.get("created_by") and not _is_admin(channel_doc, requested_by):
        raise HTTPException(status_code=403, detail="Only the logger or a channel admin can delete this")

    db["acoustic_events"].delete_one({"_id": e_oid})
    return {"deleted": True}


class RhythmCompareResponse(BaseModel):
    raw_dtw_ms: float | None
    normalized_dtw: float | None
    shape_similarity: float | None
    warning: str


@app.get("/channels/{channel_id}/acoustic-events/compare", response_model=RhythmCompareResponse)
@limiter.limit("30/minute")
async def compare_acoustic_events(request: Request, channel_id: str, requester_email: str, event_id_a: str, event_id_b: str):
    """Compares two already-saved events' rhythm signatures — nothing to
    upload, it's just the stored ici_ms arrays run through DTW."""
    db = get_db()
    if db is None:
        raise HTTPException(status_code=503, detail="Team workspace is unavailable right now")

    _, channel_doc = _require_channel(db, channel_id)
    if requester_email not in channel_doc.get("members", []):
        raise HTTPException(status_code=403, detail="Only channel members can compare acoustic events")

    try:
        oid_a, oid_b = ObjectId(event_id_a), ObjectId(event_id_b)
    except InvalidId:
        raise HTTPException(status_code=400, detail="Invalid event id")

    doc_a = db["acoustic_events"].find_one({"_id": oid_a, "channel_id": ObjectId(channel_id)})
    doc_b = db["acoustic_events"].find_one({"_id": oid_b, "channel_id": ObjectId(channel_id)})
    if doc_a is None or doc_b is None:
        raise HTTPException(status_code=404, detail="One or both events weren't found in this channel")

    result = compare_rhythm(doc_a.get("ici_ms", []), doc_b.get("ici_ms", []))
    return RhythmCompareResponse(**result)


class StandaloneRhythmCompareRequest(BaseModel):
    ici_a_ms: List[float]
    ici_b_ms: List[float]


@app.post("/acoustic-rhythm-compare", response_model=RhythmCompareResponse)
@limiter.limit("30/minute")
async def standalone_rhythm_compare(request: Request, payload: StandaloneRhythmCompareRequest):
    """Solo Mission Control path — compares two ICI arrays the frontend
    already has in-session (from two separate /acoustic-metrics calls),
    no channel or persistence involved. Pure math on client-supplied
    numbers, so there's nothing to store or authorize here."""
    result = compare_rhythm(payload.ici_a_ms, payload.ici_b_ms)
    return RhythmCompareResponse(**result)


# ---------------------------------------------------------------------------
# Human-language translation — the international-team/literature/fieldwork
# side of "translation tools", deliberately separate from the bioacoustic
# similarity search above. See app/translate.py for provider details and
# the honest gaps (free-tier quality, no historical-text handling).
# Build order: chat first (this route + Workspace chat wiring), then
# Species Inspector literature translation, then a dedicated fieldwork/
# interview tool — each of those is a separate frontend touchpoint but
# all of them call this one route.
# ---------------------------------------------------------------------------


class TranslateRequest(BaseModel):
    text: str
    target_lang: str
    source_lang: str = "auto"


class TranslateResponse(BaseModel):
    translated_text: str
    detected_source_lang: str | None = None
    provider: str
    warning: str | None = None


class LanguageOption(BaseModel):
    code: str
    name: str


@app.post("/translate", response_model=TranslateResponse)
@limiter.limit("30/minute")
async def translate(request: Request, payload: TranslateRequest):
    """Translates payload.text into payload.target_lang. Shared by every
    human-language translation touchpoint in the app (Workspace chat,
    Species Inspector literature, the fieldwork/interview translator) —
    one route, one provider decision, instead of three divergent ones.

    Uses MyMemory (free, keyless) by default; set DEEPL_API_KEY on the
    backend for better quality. See app/translate.py for the real
    trade-offs of each."""
    if not payload.text.strip():
        raise HTTPException(status_code=400, detail="text is empty")
    if len(payload.text) > 20000:
        raise HTTPException(status_code=413, detail="Text is too long to translate in a single request — split it up")

    try:
        result = await translate_text(payload.text, payload.target_lang, payload.source_lang)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Translation failed: {exc}")

    return TranslateResponse(**result)


@app.get("/translate/languages", response_model=List[LanguageOption])
@limiter.limit("60/minute")
def translate_languages(request: Request):
    """A sane default language list for a picker dropdown — not a
    validation allowlist. /translate accepts any ISO 639-1 code whether
    or not it's in this list."""
    return [LanguageOption(**lang) for lang in COMMON_LANGUAGES]