import base64
import os

import cv2
import requests

ROBOFLOW_API_KEY = os.getenv("ROBOFLOW_API_KEY", "")

# Each entry: (env var prefix, default model id, default version, response kind)
# kind is "detection" (bounding boxes) or "classification" (whole-image label)
MODEL_CONFIGS = [
    {
        "name": "own_fish",
        "kind": "detection",
        "model_id": os.getenv("ROBOFLOW_MODEL_ID", "fish-detection-6lfay-lvzz8"),
        "version": os.getenv("ROBOFLOW_MODEL_VERSION", "1"),
        "enabled": os.getenv("ENABLE_OWN_FISH_MODEL", "false").lower() == "true",
    },
    {
        "name": "marine_fishes",
        "kind": "detection",
        "model_id": os.getenv("MARINE_FISHES_MODEL_ID", "marine-fishes-qpeh3"),
        "version": os.getenv("MARINE_FISHES_MODEL_VERSION", "1"),
        "enabled": os.getenv("ENABLE_MARINE_FISHES_MODEL", "true").lower() == "true",
    },
    {
        "name": "coral_lifeform",
        "kind": "detection",  # segmentation polygons get converted to boxes
        "model_id": os.getenv("CORAL_LIFEFORM_MODEL_ID", "coral-lifeform"),
        "version": os.getenv("CORAL_LIFEFORM_MODEL_VERSION", "1"),
        "enabled": os.getenv("ENABLE_CORAL_LIFEFORM_MODEL", "false").lower() == "true",
    },
    {
        "name": "coral_bleach",
        "kind": "classification",
        "model_id": os.getenv("CORAL_BLEACH_MODEL_ID", "coral-reef-bleach-detection"),
        "version": os.getenv("CORAL_BLEACH_MODEL_VERSION", "1"),
        "enabled": os.getenv("ENABLE_CORAL_BLEACH_MODEL", "true").lower() == "true",
    },
]


def clahe_correct(frame):
    """Contrast Limited Adaptive Histogram Equalization to fight underwater
    green/blue light attenuation."""
    lab = cv2.cvtColor(frame, cv2.COLOR_BGR2LAB)
    l, a, b = cv2.split(lab)
    clahe = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8))
    l = clahe.apply(l)
    return cv2.cvtColor(cv2.merge((l, a, b)), cv2.COLOR_LAB2BGR)


def _encode_frame(frame):
    success, encoded = cv2.imencode(".jpg", frame)
    if not success:
        return None
    return base64.b64encode(encoded.tobytes()).decode("utf-8")


def _call_roboflow_model(image_b64, model_id, version, conf_threshold):
    url = f"https://detect.roboflow.com/{model_id}/{version}"
    response = requests.post(
        url,
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
    return response.json()


def predict_with_roboflow(frame, conf_threshold: float = 0.2):
    """Calls every enabled model in MODEL_CONFIGS against this frame and
    merges the results into a single response:
    {
        "boxes": [{"label", "confidence", "x1","y1","x2","y2", "source"}, ...],
        "classifications": [{"source", "label", "confidence"}, ...]  # e.g. bleach verdict
    }
    """
    if not ROBOFLOW_API_KEY:
        raise RuntimeError(
            "ROBOFLOW_API_KEY is not set. Add it to backend/.env to use the "
            "hosted inference API."
        )

    image_b64 = _encode_frame(frame)
    if not image_b64:
        return {"boxes": [], "classifications": []}

    boxes = []
    classifications = []

    for cfg in MODEL_CONFIGS:
        if not cfg["enabled"]:
            continue
        try:
            data = _call_roboflow_model(image_b64, cfg["model_id"], cfg["version"], conf_threshold)
        except Exception as exc:
            # One model failing shouldn't take down the whole frame's results
            print(f"[inference] {cfg['name']} call failed: {exc}")
            continue

        if cfg["kind"] == "classification":
            # Roboflow classification responses have a top "predictions" list
            # with class + confidence (no coordinates).
            preds = data.get("predictions", [])
            if preds:
                top = preds[0] if isinstance(preds, list) else None
                if isinstance(data.get("top"), str):
                    classifications.append(
                        {
                            "source": cfg["name"],
                            "label": data.get("top"),
                            "confidence": float(data.get("confidence", 0.0)),
                        }
                    )
                elif top:
                    classifications.append(
                        {
                            "source": cfg["name"],
                            "label": top.get("class", "unknown"),
                            "confidence": float(top.get("confidence", 0.0)),
                        }
                    )
            continue

        # Detection / segmentation: normalize to x1,y1,x2,y2 boxes
        for pred in data.get("predictions", []):
            if "points" in pred and pred["points"]:
                # Segmentation polygon -> bounding rectangle
                xs = [pt["x"] for pt in pred["points"]]
                ys = [pt["y"] for pt in pred["points"]]
                x1, y1, x2, y2 = int(min(xs)), int(min(ys)), int(max(xs)), int(max(ys))
            else:
                cx, cy = pred["x"], pred["y"]
                w, h = pred["width"], pred["height"]
                x1 = int(cx - w / 2)
                y1 = int(cy - h / 2)
                x2 = int(cx + w / 2)
                y2 = int(cy + h / 2)

            boxes.append(
                {
                    "label": pred.get("class", "unknown"),
                    "confidence": float(pred.get("confidence", 0.0)),
                    "x1": x1,
                    "y1": y1,
                    "x2": x2,
                    "y2": y2,
                    "source": cfg["name"],
                }
            )

    return {"boxes": boxes, "classifications": classifications}


def coral_bleaching_ratio(coral_bgr_crop):
    """Rough heuristic fallback: convert a cropped coral region to HSV and
    compute the proportion of low-saturation (white/grey) pixels vs. healthy
    pigmentation. Used only if the coral_bleach classification model isn't
    enabled/available."""
    hsv = cv2.cvtColor(coral_bgr_crop, cv2.COLOR_BGR2HSV)
    saturation = hsv[:, :, 1]
    total_pixels = saturation.size
    bleached_pixels = int((saturation < 40).sum())
    return bleached_pixels / total_pixels if total_pixels else 0.0