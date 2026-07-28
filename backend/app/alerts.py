import os
import time
import httpx
from datetime import datetime, timezone

N8N_WEBHOOK_URL = os.getenv(
    "N8N_DETECTION_WEBHOOK_URL",
    "https://yawaworks.app.n8n.cloud/webhook/detection-alert",
)
CONFIDENCE_ALERT_THRESHOLD = 0.7
ALERT_COOLDOWN_SECONDS = 300  # 5 min — stops repeat alerts for the same
                               # species firing on every consecutive frame

_last_alert_at: dict[str, float] = {}  # in-memory cooldown tracker


def _should_alert(species: str) -> bool:
    now = time.time()
    last = _last_alert_at.get(species, 0)
    if now - last < ALERT_COOLDOWN_SECONDS:
        return False
    _last_alert_at[species] = now
    return True


async def send_detection_alert(species: str, confidence: float, latitude: float, longitude: float):
    """Fires a webhook to n8n for high-confidence detections, with a
    per-species cooldown so a fish sitting in frame for 30 seconds doesn't
    spam the channel with one alert per captured frame."""
    if confidence < CONFIDENCE_ALERT_THRESHOLD:
        return
    if not _should_alert(species):
        return

    payload = {
        "species": species,
        "confidence": round(confidence, 3),
        "latitude": latitude,
        "longitude": longitude,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }

    try:
        async with httpx.AsyncClient(timeout=5) as client:
            await client.post(N8N_WEBHOOK_URL, json=payload)
    except Exception as exc:
        # Alert delivery failing should never break frame analysis
        print(f"[alerts] n8n webhook call failed: {exc}")