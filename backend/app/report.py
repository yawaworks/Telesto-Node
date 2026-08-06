import io
from collections import Counter, defaultdict
from datetime import datetime, timezone

from reportlab.lib import colors
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch
from reportlab.platypus import (
    SimpleDocTemplate,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
    HRFlowable,
)

from app.db import get_db

# In-memory fallback used only if MongoDB isn't configured/reachable.
# Cleared on backend restart — MongoDB is what makes this survive restarts.
detection_log = []


def _mongo_collection():
    db = get_db()
    return db["detections"] if db is not None else None


def log_detections(
    boxes,
    coral_bleaching_ratio,
    owner_email: str | None = None,
    latitude: float | None = None,
    longitude: float | None = None,
):
    """Called from /analyze-frame after each successful inference so the
    export report can summarize the whole session. Writes to MongoDB when
    available; falls back to an in-memory list otherwise.

    owner_email is the logged-in researcher running this mission (same
    session email already threaded through analyze-frame for alerts).
    It's stored on every entry so reports can be scoped to "mine" vs
    "team" later, the same mine/shared convention already used for clips
    and snapshots. It's optional — entries logged without it (older data,
    or no session) are only visible under "team" scope, never "mine",
    so they can't silently get attributed to whoever asks first.

    latitude/longitude are the same telemetry-derived coordinates already
    threaded through analyze-frame for other purposes — stored here too
    so habitat-trend tracking (app/habitat.py) can group readings by
    location, not just by time. Entries logged before this existed, or
    without live telemetry, have no coordinates and are simply excluded
    from location-based habitat queries rather than guessed at.
    """
    timestamp = datetime.now(timezone.utc)
    entries = []
    for box in boxes:
        entries.append(
            {
                "timestamp": timestamp,
                "label": box["label"],
                "confidence": box["confidence"],
                "source": box.get("source"),
                "owner_email": owner_email,
                "latitude": latitude,
                "longitude": longitude,
            }
        )
    if coral_bleaching_ratio is not None:
        entries.append(
            {
                "timestamp": timestamp,
                "label": "__coral_bleaching_reading__",
                "confidence": coral_bleaching_ratio,
                "source": "coral_bleach",
                "owner_email": owner_email,
                "latitude": latitude,
                "longitude": longitude,
            }
        )

    if not entries:
        return

    collection = _mongo_collection()
    if collection is not None:
        try:
            collection.insert_many(entries)
            return
        except Exception as exc:
            print(f"[report] MongoDB insert failed, falling back to memory: {exc}")

    detection_log.extend(entries)


def _fetch_all_entries(owner_email: str | None = None, scope: str = "team"):
    """Reads logged entries from MongoDB if connected, else the in-memory
    fallback list.

    scope="mine" returns only entries logged under owner_email (requires
    owner_email; entries with no owner_email on them are excluded — they
    predate scoping or came from a logged-out session, and attributing
    them to whoever asks would be a guess).

    scope="team" (default, matches the app's previous unscoped behavior)
    returns every entry regardless of who logged it. This is a real
    design decision: until Team Workspace exists, "team" doesn't mean
    "my dive team" — it means every researcher who has ever used this
    deployment, since there's no concept of a shared workspace boundary
    yet. Treat "team" reports as provisional until that lands.
    """
    collection = _mongo_collection()
    if collection is not None:
        try:
            query = {"owner_email": owner_email} if scope == "mine" else {}
            return list(collection.find(query))
        except Exception as exc:
            print(f"[report] MongoDB read failed, falling back to memory: {exc}")
            entries = detection_log
    else:
        entries = detection_log

    if scope == "mine":
        return [e for e in entries if e.get("owner_email") == owner_email]
    return entries


def _health_index(avg_bleaching_ratio):
    """Simple 0-100 ecosystem health score: 100 = fully healthy coral,
    0 = fully bleached. None if no coral readings were logged."""
    if avg_bleaching_ratio is None:
        return None
    return round((1 - avg_bleaching_ratio) * 100, 1)


def _compute_maxn(species_entries):
    """MaxN — the max number of individuals of a species visible in any
    single analyzed frame across the session. This is the standard fish-
    abundance metric in baited/remote underwater video (BRUV) survey
    literature (Ellis & DeMartini 1995 onward), not something invented
    for this report — it's deliberately conservative and avoids the
    massive overcount you get from summing every detection (one fish
    sitting in frame across 20 analyzed frames isn't 20 fish).
    """
    per_frame_counts = defaultdict(lambda: defaultdict(int))
    for entry in species_entries:
        per_frame_counts[entry["timestamp"]][entry["label"]] += 1

    maxn = defaultdict(int)
    for frame_counts in per_frame_counts.values():
        for label, count in frame_counts.items():
            maxn[label] = max(maxn[label], count)
    return maxn, len(per_frame_counts)


def generate_mission_report(
    telemetry: dict, owner_email: str | None = None, scope: str = "team"
) -> bytes:
    """Builds a PDF summarizing species detected, counts, and ecosystem
    health index from logged detections, plus the mission telemetry
    snapshot (depth, coordinates, etc.) passed in from the HUD.

    scope="mine" limits this to the requesting researcher's own detections
    (owner_email required for that to return anything). scope="team"
    (default) pools every detection ever logged, matching the app's prior
    unscoped behavior — see _fetch_all_entries for why that's provisional.
    """
    all_entries = _fetch_all_entries(owner_email=owner_email, scope=scope)
    species_entries = [d for d in all_entries if d["source"] != "coral_bleach"]
    bleach_entries = [d for d in all_entries if d["source"] == "coral_bleach"]

    maxn, frames_sampled = _compute_maxn(species_entries)
    avg_bleaching = (
        sum(d["confidence"] for d in bleach_entries) / len(bleach_entries)
        if bleach_entries
        else None
    )
    health_index = _health_index(avg_bleaching)

    buffer = io.BytesIO()
    doc = SimpleDocTemplate(
        buffer,
        pagesize=letter,
        topMargin=0.75 * inch,
        bottomMargin=0.75 * inch,
        leftMargin=0.9 * inch,
        rightMargin=0.9 * inch,
    )
    styles = getSampleStyleSheet()
    title_style = ParagraphStyle(
        "TelestoTitle", parent=styles["Title"], textColor=colors.HexColor("#0e7490")
    )
    heading_style = ParagraphStyle(
        "TelestoHeading",
        parent=styles["Heading2"],
        textColor=colors.HexColor("#0e7490"),
        spaceBefore=16,
        spaceAfter=8,
    )
    label_style = ParagraphStyle(
        "TelestoLabel", parent=styles["Normal"], textColor=colors.HexColor("#555555")
    )

    scope_label = (
        f"Scope: this researcher's detections only ({owner_email})"
        if scope == "mine"
        else "Scope: all researchers on this deployment (team-wide)"
    )

    story = []
    story.append(Paragraph("Telesto Node — Field Mission Report", title_style))
    story.append(
        Paragraph(
            f"Generated {datetime.now(timezone.utc).strftime('%B %d, %Y at %H:%M UTC')}",
            label_style,
        )
    )
    story.append(Paragraph(scope_label, label_style))
    story.append(Spacer(1, 12))
    story.append(HRFlowable(width="100%", color=colors.HexColor("#cccccc")))
    story.append(Spacer(1, 12))

    story.append(Paragraph("Mission Telemetry Snapshot", heading_style))
    telemetry_rows = [
        ["Depth", telemetry.get("depth", "—")],
        ["Coordinates", telemetry.get("coords", "—")],
        ["Water Temperature", telemetry.get("temp", "—")],
        ["Salinity", telemetry.get("salinity", "—")],
        ["Heading", telemetry.get("heading", "—")],
    ]
    telemetry_table = Table(telemetry_rows, colWidths=[2 * inch, 3.5 * inch])
    telemetry_table.setStyle(
        TableStyle(
            [
                ("FONTNAME", (0, 0), (0, -1), "Helvetica-Bold"),
                ("TEXTCOLOR", (0, 0), (0, -1), colors.HexColor("#0e7490")),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
                ("TOPPADDING", (0, 0), (-1, -1), 6),
                ("LINEBELOW", (0, 0), (-1, -1), 0.5, colors.HexColor("#e0e0e0")),
            ]
        )
    )
    story.append(telemetry_table)

    story.append(Paragraph("Ecosystem Health Index", heading_style))
    if health_index is not None:
        health_color = (
            colors.HexColor("#16a34a")
            if health_index >= 70
            else colors.HexColor("#ca8a04")
            if health_index >= 40
            else colors.HexColor("#dc2626")
        )
        health_style = ParagraphStyle(
            "HealthScore", parent=styles["Normal"], fontSize=28, textColor=health_color
        )
        story.append(Paragraph(f"{health_index} / 100", health_style))
        story.append(
            Paragraph(
                f"Based on {len(bleach_entries)} coral bleaching reading(s) during this session "
                f"(average bleaching ratio: {round(avg_bleaching * 100, 1)}%).",
                label_style,
            )
        )
    else:
        story.append(
            Paragraph(
                "No coral bleaching readings were recorded during this session.",
                label_style,
            )
        )

    story.append(Paragraph("Species Detected", heading_style))
    story.append(
        Paragraph(
            f"MaxN — the maximum number of individuals of each species observed "
            f"simultaneously in any single analyzed frame, across {frames_sampled} "
            f"frames sampled this session. This is the standard relative-abundance "
            f"metric used in underwater video survey research, not a raw detection "
            f"count (which would overcount a single animal that stays in frame "
            f"across many consecutive analyzed frames).",
            label_style,
        )
    )
    story.append(Spacer(1, 6))

    if maxn:
        rows = [["Species / Class", "MaxN"]]
        for label, count in sorted(maxn.items(), key=lambda x: -x[1]):
            rows.append([label, str(count)])
        species_table = Table(rows, colWidths=[4 * inch, 1.5 * inch])
        species_table.setStyle(
            TableStyle(
                [
                    ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#0e7490")),
                    ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
                    ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
                    ("ALIGN", (1, 0), (1, -1), "CENTER"),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
                    ("TOPPADDING", (0, 0), (-1, -1), 6),
                    ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#e0e0e0")),
                    (
                        "ROWBACKGROUNDS",
                        (0, 1),
                        (-1, -1),
                        [colors.white, colors.HexColor("#f5f9fb")],
                    ),
                ]
            )
        )
        story.append(species_table)
    else:
        story.append(
            Paragraph("No species were detected during this session.", label_style)
        )

    story.append(Spacer(1, 20))
    story.append(HRFlowable(width="100%", color=colors.HexColor("#cccccc")))
    story.append(Spacer(1, 8))
    story.append(
        Paragraph(
            "Telesto Node — Real-Time Marine Ecosystem Monitoring & Health Analytics",
            label_style,
        )
    )

    doc.build(story)
    buffer.seek(0)
    return buffer.read()