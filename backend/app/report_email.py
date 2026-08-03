import os
import base64
import httpx

RESEND_API_KEY = os.getenv("RESEND_API_KEY", "")
ALERT_FROM_EMAIL = os.getenv("ALERT_FROM_EMAIL", "onboarding@resend.dev")


async def send_mission_report_email(pdf_bytes: bytes, recipient_email: str) -> dict:
    """Emails the mission report PDF as an attachment via Resend, directly
    from the backend — no n8n workflow in the middle. Mirrors exactly what
    the old n8n workflow did (Fetch Report PDF -> PDF to Base64 -> Send
    Report Email), just as three lines of Python instead of three n8n
    nodes plus an external hosting dependency.

    Raises on failure so the calling endpoint can surface a real error to
    the frontend instead of silently pretending the email sent.
    """
    if not RESEND_API_KEY:
        raise RuntimeError("RESEND_API_KEY is not configured")

    encoded_pdf = base64.b64encode(pdf_bytes).decode("utf-8")

    payload = {
        "from": ALERT_FROM_EMAIL,
        "to": recipient_email,
        "subject": "Telesto Node Mission Report",
        "text": "Attached is the latest mission report.",
        "attachments": [
            {
                "filename": "telesto-node-mission-report.pdf",
                "content": encoded_pdf,
            }
        ],
    }

    async with httpx.AsyncClient(timeout=15) as client:
        response = await client.post(
            "https://api.resend.com/emails",
            headers={
                "Authorization": f"Bearer {RESEND_API_KEY}",
                "Content-Type": "application/json",
            },
            json=payload,
        )
        if response.status_code >= 400:
            raise RuntimeError(f"Resend returned {response.status_code}: {response.text}")
        return response.json()