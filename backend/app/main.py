import math
import re
from typing import List, Optional

from dotenv import load_dotenv
from .species_info import get_species_info

# Must run BEFORE importing app.inference or app.alerts, since both read
# env vars (ROBOFLOW_API_KEY, N8N_DETECTION_WEBHOOK_URL) from the
# environment at import time.
load_dotenv()

import os

import cv2
import numpy as np
from fastapi import FastAPI, File, HTTPException, Request, UploadFile, WebSocket, WebSocketDisconnect
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
from app.report import generate_mission_report, log_detections
from app.telemetry import TelemetrySimulator, MISSION_LAT, MISSION_LNG
from datetime import datetime, timezone
from urllib.parse import urlparse

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


class SpeciesSyncRecord(BaseModel):
    scientific_name: str
    latitude: float
    longitude: float
    depth_meters: Optional[float] = None
    country: Optional[str] = None
    source: str  # "obis" or "inaturalist"


class SpeciesSyncPayload(BaseModel):
    records: List[SpeciesSyncRecord]


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
    """
    raw_bytes = await file.read()
    np_arr = np.frombuffer(raw_bytes, np.uint8)
    frame = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)

    frame = clahe_correct(frame)

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

    # Fire detection alerts to n8n without blocking the response the
    # frontend is waiting on. send_detection_alert internally filters by
    # confidence threshold and applies a per-species cooldown, so this is
    # safe to call for every box on every frame.
    for box in boxes:
        asyncio.create_task(
            send_detection_alert(
                species=box.label,
                confidence=box.confidence,
                latitude=latitude,
                longitude=longitude,
            )
        )

    return FrameAnalysisResponse(
        boxes=boxes, classifications=classifications, coral_bleaching_ratio=frame_ratio
    )


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
    depth: str = "",
    coords: str = "",
    temp: str = "",
    salinity: str = "",
    heading: str = "",
    species_query: str = "",
    owner_email: str = "",
):
    """Uploads a Discovery Snapshot (triggered by the gamepad's 'A' button)
    to Cloudinary, then logs a record of it — image URL plus whatever
    mission telemetry/species context was active at capture time — to
    Mongo if it's connected. Falls back to upload-only (no DB record) if
    Mongo is currently down, same graceful-degradation pattern used
    elsewhere in this API."""
    raw_bytes = await file.read()

    try:
        upload_result = upload_snapshot(raw_bytes, filename=file.filename or "snapshot.jpg")
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Cloudinary upload failed: {exc}")

    saved_to_db = False
    db = get_db()
    if db is not None:
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
                    "owner_email": owner_email,
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


@app.get("/snapshots/count")
@limiter.limit("60/minute")
async def count_snapshots(request: Request, owner_email: str):
    """Returns how many Discovery Snapshots a researcher has taken — used
    for the activity stats on their profile page. Snapshots created before
    owner_email was tracked won't be attributed to anyone; that's expected
    for historical data."""
    if not owner_email:
        raise HTTPException(status_code=400, detail="owner_email is required")

    db = get_db()
    if db is None:
        return {"count": 0}

    count = db["snapshots"].count_documents({"owner_email": owner_email})
    return {"count": count}


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
    hours by the n8n "Species Data Sync" workflow) — a cache hit avoids
    hitting OBIS live and returns near-instantly. Falls back to a live
    OBIS fetch on a cache miss, since the sync workflow currently only
    keeps one species (Acropora cervicornis) fresh; a researcher
    searching any other species should still get real results, just
    without the speed benefit until that species is added to the sync.
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

@app.get("/species-info")
async def species_info(name: str):
    if not name:
        raise HTTPException(status_code=400, detail="name is required")
    try:
        return await get_species_info(name)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Species info lookup failed: {e}")