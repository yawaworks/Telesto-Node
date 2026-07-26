import os

import cv2
from ultralytics import YOLO

_model = None


def get_model():
    """Lazily load the YOLO model once per process."""
    global _model
    if _model is None:
        weights_path = os.getenv("YOLO_WEIGHTS_PATH", "weights/telesto_marine_yolov8n.pt")
        if not os.path.exists(weights_path):
            # Fall back to a stock pretrained checkpoint until you drop in
            # your fine-tuned marine weights (see Phase 1 of the roadmap).
            weights_path = "yolov8n.pt"
        _model = YOLO(weights_path)
    return _model


def clahe_correct(frame):
    """Contrast Limited Adaptive Histogram Equalization to fight underwater
    green/blue light attenuation."""
    lab = cv2.cvtColor(frame, cv2.COLOR_BGR2LAB)
    l, a, b = cv2.split(lab)
    clahe = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8))
    l = clahe.apply(l)
    return cv2.cvtColor(cv2.merge((l, a, b)), cv2.COLOR_LAB2BGR)


def coral_bleaching_ratio(coral_bgr_crop):
    """Rough heuristic: convert a cropped coral region to HSV and compute the
    proportion of low-saturation (white/grey) pixels vs. healthy pigmentation."""
    hsv = cv2.cvtColor(coral_bgr_crop, cv2.COLOR_BGR2HSV)
    saturation = hsv[:, :, 1]
    total_pixels = saturation.size
    bleached_pixels = int((saturation < 40).sum())
    return bleached_pixels / total_pixels if total_pixels else 0.0
