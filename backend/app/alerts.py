import os
import time
import httpx
from datetime import datetime, timezone

RESEND_API_KEY = os.getenv("RESEND_API_KEY", "")
ALERT_FROM_EMAIL = os.getenv("ALERT_FROM_EMAIL", "onboarding@resend.dev")
# Fallback only — used if a request somehow arrives with no logged-in
# user's email attached (shouldn't normally happen, since the frontend
# always sends the session's email). Leave unset in production if you'd
# rather alerts silently skip than fall back to a single fixed address.
DEFAULT_ALERT_TO_EMAIL = os.getenv("ALERT_TO_EMAIL", "")

CONFIDENCE_ALERT_THRESHOLD = 0.7
ALERT_COOLDOWN_SECONDS = 300  # 5 min — stops repeat alerts for the same
                               # species firing on every consecutive frame

# Cooldown is now keyed per (species, recipient) rather than just species,
# since two different researchers detecting the same fish in two different
# sessions should each get their own alert, not have the second one
# suppressed by the first person's cooldown.
_last_alert_at: dict[tuple[str, str], float] = {}


def _should_alert(species: str, to_email: str) -> bool:
    now = time.time()
    key = (species, to_email)
    last = _last_alert_at.get(key, 0)
    if now - last < ALERT_COOLDOWN_SECONDS:
        return False
    _last_alert_at[key] = now
    return True


async def send_detection_alert(
    species: str,
    confidence: float,
    latitude: float,
    longitude: float,
    to_email: str | None = None,
):
    """Fires a detection alert email directly via Resend, sent to the
    researcher who's actually running this mission — not a single fixed
    inbox. `to_email` should be the logged-in user's session email,
    threaded through from the frontend via /analyze-frame. Falls back to
    DEFAULT_ALERT_TO_EMAIL only if that's genuinely missing.
    """
    recipient = to_email or DEFAULT_ALERT_TO_EMAIL
    if not recipient:
        print("[alerts] No recipient email available (no session email, no fallback) — skipping alert")
        return

    if confidence < CONFIDENCE_ALERT_THRESHOLD:
        return
    if not _should_alert(species, recipient):
        return
    if not RESEND_API_KEY:
        print("[alerts] RESEND_API_KEY not set — skipping alert email")
        return

    timestamp = datetime.now(timezone.utc).isoformat()
    maps_link = f"https://www.google.com/maps?q={latitude},{longitude}"

    payload = {
        "from": ALERT_FROM_EMAIL,
        "to": recipient,
        "subject": f"Telesto Node Alert: {species} detected",
        "text": (
            f"Species: {species}\n"
            f"Confidence: {round(confidence * 100, 1)}%\n"
            f"Location: {latitude}, {longitude}\n"
            f"Map: {maps_link}\n"
            f"Time: {timestamp}"
        ),
    }

    try:
        async with httpx.AsyncClient(timeout=5) as client:
            response = await client.post(
                "https://api.resend.com/emails",
                headers={
                    "Authorization": f"Bearer {RESEND_API_KEY}",
                    "Content-Type": "application/json",
                },
                json=payload,
            )
            if response.status_code >= 400:
                print(f"[alerts] Resend returned {response.status_code}: {response.text}")
    except Exception as exc:
        # Alert delivery failing should never break frame analysis
        print(f"[alerts] Resend call failed: {exc}")