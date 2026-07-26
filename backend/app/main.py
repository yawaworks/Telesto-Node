import math
import os
from typing import List, Optional

from dotenv import load_dotenv

# Must run BEFORE importing app.inference, since that module reads
# ROBOFLOW_API_KEY from the environment at import time.
load_dotenv()

import cv2
import numpy as np
from fastapi import FastAPI, File, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from app.inference import clahe_correct, coral_bleaching_ratio, predict_with_roboflow
from app.obis_client import fetch_obis_species_data

FRONTEND_ORIGIN = os.getenv("FRONTEND_ORIGIN", "http://localhost:3000")

app = FastAPI(title="Telesto Node Inference API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[FRONTEND_ORIGIN],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

CORAL_LABELS = {"coral", "healthy_coral", "bleached_coral", "coral_reef"}


class BoundingBox(BaseModel):
    label: str
    confidence: float
    x1: int
    y1: int
    x2: int
    y2: int
    bleaching_ratio: Optional[float] = None


class FrameAnalysisResponse(BaseModel):
    boxes: List[BoundingBox]
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
async def analyze_frame(file: UploadFile = File(...), conf_threshold: float = 0.35):
    raw_bytes = await file.read()
    np_arr = np.frombuffer(raw_bytes, np.uint8)
    frame = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)

    frame = clahe_correct(frame)

    try:
        detections = predict_with_roboflow(frame, conf_threshold=conf_threshold)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Roboflow inference failed: {exc}")

    boxes = []
    bleaching_ratios = []

    for det in detections:
        label = det["label"]
        x1, y1, x2, y2 = det["x1"], det["y1"], det["x2"], det["y2"]

        ratio = None
        if label.lower() in CORAL_LABELS:
            crop = frame[max(0, y1):max(0, y2), max(0, x1):max(0, x2)]
            if crop.size > 0:
                ratio = coral_bleaching_ratio(crop)
                bleaching_ratios.append(ratio)

        boxes.append(
            BoundingBox(
                label=label,
                confidence=det["confidence"],
                x1=x1,
                y1=y1,
                x2=x2,
                y2=y2,
                bleaching_ratio=ratio,
            )
        )

    frame_ratio = (
        sum(bleaching_ratios) / len(bleaching_ratios) if bleaching_ratios else None
    )

    return FrameAnalysisResponse(boxes=boxes, coral_bleaching_ratio=frame_ratio)


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
                "geometry": {
                    "type": "Point",
                    "coordinates": [lng, lat],
                },
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