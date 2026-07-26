import base64
import os

import cv2
import requests

ROBOFLOW_API_KEY = os.getenv("ROBOFLOW_API_KEY", "")
ROBOFLOW_MODEL_ID = os.getenv("ROBOFLOW_MODEL_ID", "fish-detection-6lfay-lvzz8")
ROBOFLOW_MODEL_VERSION = os.getenv("ROBOFLOW_MODEL_VERSION", "1")
ROBOFLOW_INFER_URL = (
    f"https://detect.roboflow.com/{ROBOFLOW_MODEL_ID}/{ROBOFLOW_MODEL_VERSION}"
)


def clahe_correct(frame):
    """Contrast Limited Adaptive Histogram Equalization to fight underwater
    green/blue light attenuation."""
    lab = cv2.cvtColor(frame, cv2.COLOR_BGR2LAB)
    l, a, b = cv2.split(lab)
    clahe = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8))
    l = clahe.apply(l)
    return cv2.cvtColor(cv2.merge((l, a, b)), cv2.COLOR_LAB2BGR)


def predict_with_roboflow(frame, conf_threshold: float = 0.35):
    """Sends a frame to Roboflow's hosted inference API and returns a list of
    detections in the same shape the rest of the app expects:
    [{"label": str, "confidence": float, "x1": int, "y1": int, "x2": int, "y2": int}, ...]
    """
    if not ROBOFLOW_API_KEY:
        raise RuntimeError(
            "ROBOFLOW_API_KEY is not set. Add it to backend/.env to use the "
            "hosted inference API."
        )

    success, encoded = cv2.imencode(".jpg", frame)
    if not success:
        return []

    image_b64 = base64.b64encode(encoded.tobytes()).decode("utf-8")

    response = requests.post(
        ROBOFLOW_INFER_URL,
        params={
            "api_key": ROBOFLOW_API_KEY,
            "confidence": int(conf_threshold * 100),
            "format": "json",
        },
        data=image_b64,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        timeout=10,
    )
    response.raise_for_status()
    data = response.json()

    detections = []
    for pred in data.get("predictions", []):
        cx, cy = pred["x"], pred["y"]
        w, h = pred["width"], pred["height"]
        x1 = int(cx - w / 2)
        y1 = int(cy - h / 2)
        x2 = int(cx + w / 2)
        y2 = int(cy + h / 2)

        detections.append(
            {
                "label": pred.get("class", "unknown"),
                "confidence": float(pred.get("confidence", 0.0)),
                "x1": x1,
                "y1": y1,
                "x2": x2,
                "y2": y2,
            }
        )

    return detections


def coral_bleaching_ratio(coral_bgr_crop):
    """Rough heuristic: convert a cropped coral region to HSV and compute the
    proportion of low-saturation (white/grey) pixels vs. healthy pigmentation."""
    hsv = cv2.cvtColor(coral_bgr_crop, cv2.COLOR_BGR2HSV)
    saturation = hsv[:, :, 1]
    total_pixels = saturation.size
    bleached_pixels = int((saturation < 40).sum())
    return bleached_pixels / total_pixels if total_pixels else 0.0