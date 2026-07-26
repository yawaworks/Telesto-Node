import math
from typing import List, Optional

from dotenv import load_dotenv

# Must run BEFORE importing app.inference, since that module reads
# ROBOFLOW_API_KEY (and model IDs) from the environment at import time.
load_dotenv()

import os

import cv2
import numpy as np
from fastapi import FastAPI, File, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel

from app.inference import clahe_correct, coral_bleaching_ratio, predict_with_roboflow
from app.obis_client import fetch_obis_species_data
from app.report import generate_mission_report, log_detections

FRONTEND_ORIGIN = os.getenv("FRONTEND_ORIGIN", "http://localhost:3000")

app = FastAPI(title="Telesto Node Inference API")

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


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/analyze-frame", response_model=FrameAnalysisResponse)
async def analyze_frame(file: UploadFile = File(...), conf_threshold: float = 0.2):
    """Runs every enabled Roboflow model against this frame (marine-fishes
    species detection + the coral bleach classifier by default), merging
    results into one response, and logs the detections for the mission
    report export."""
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

    return FrameAnalysisResponse(
        boxes=boxes, classifications=classifications, coral_bleaching_ratio=frame_ratio
    )


@app.get("/export-report")
async def export_report(
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


@app.get("/species-data")
async def species_data(scientific_name: str, max_records: int = 200):
    df = fetch_obis_species_data(scientific_name, max_records=max_records)

    if df is None or df.empty:
        raise HTTPException(
            status_code=404,
            detail=f"No OBIS records found for '{scientific_name}'",
        )

    features = []
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

    return {"type": "FeatureCollection", "features": features}


@app.websocket("/ws/telemetry")
async def telemetry_socket(websocket: WebSocket):
    await websocket.accept()
    try:
        while True:
            data = await websocket.receive_json()
            await websocket.send_json({"received": data})
    except WebSocketDisconnect:
        pass