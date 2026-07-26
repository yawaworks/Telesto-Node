import os
from typing import List

import cv2
import numpy as np
from dotenv import load_dotenv
from fastapi import FastAPI, File, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from app.inference import clahe_correct, get_model

load_dotenv()

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


class FrameAnalysisResponse(BaseModel):
    boxes: List[BoundingBox]
    coral_bleaching_ratio: float | None = None


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/analyze-frame", response_model=FrameAnalysisResponse)
async def analyze_frame(file: UploadFile = File(...), conf_threshold: float = 0.35):
    """Accepts a single video frame (image bytes), returns YOLO bounding boxes."""
    raw_bytes = await file.read()
    np_arr = np.frombuffer(raw_bytes, np.uint8)
    frame = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)

    frame = clahe_correct(frame)

    model = get_model()
    results = model.predict(frame, conf=conf_threshold, verbose=False)[0]

    boxes = []
    for box in results.boxes:
        x1, y1, x2, y2 = map(int, box.xyxy[0])
        label = model.names[int(box.cls[0])]
        score = float(box.conf[0])
        boxes.append(BoundingBox(label=label, confidence=score, x1=x1, y1=y1, x2=x2, y2=y2))

    return FrameAnalysisResponse(boxes=boxes)


@app.websocket("/ws/telemetry")
async def telemetry_socket(websocket: WebSocket):
    """Live telemetry stream stub (depth, temp, salinity, alerts) for the HUD."""
    await websocket.accept()
    try:
        while True:
            data = await websocket.receive_json()
            # Echo/broadcast logic goes here once real sensor/ROV data is wired up
            await websocket.send_json({"received": data})
    except WebSocketDisconnect:
        pass
