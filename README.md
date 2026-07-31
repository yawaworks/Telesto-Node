# Telesto Node

Real-time marine ecosystem monitoring and health analytics platform, combining live ROV mission control, gamepad-driven navigation, computer-vision species detection, and 3D bathymetry mapping in one live dashboard.

Started as a hackathon project, but built out end-to-end as a real system rather than cut down for speed. Its core differentiator is a live, immersive real-time ROV mission-control UX with gamepad navigation, something none of the existing marine research tools (ReefCloud, CoralNet, FathomNet, VIAME, Reef Support, Data Mermaid, FathomVerse) currently offer.

---

## Features

- **Live ROV Mission Control**: real-time video feed, telemetry readout, and gamepad-driven navigation for an immersive piloting experience
- **Species Detection**: YOLO-based computer vision (Roboflow-hosted) identifies marine species live from the video feed
- **Coral Bleach Classification**: a dedicated model flags signs of coral bleaching in real time
- **3D Bathymetry Mapping**: MapLibre GL JS renders live 3D seafloor terrain
- **Discovery Snapshot**: capture and save a notable moment mid-dive with one gamepad button press
- **Clip Library**: save, browse, and share video clips (personal and shared), backed by Cloudinary and MongoDB
- **Automated Detection Alerts**: an n8n workflow emails researchers when a high-confidence species detection occurs, with a per-species cooldown to avoid alert spam
- **Ocean Temperature Overlay**: live sea surface temperature via the Open-Meteo marine API
- **Secure Auth**: Google OAuth and credentials-based login via NextAuth.js

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Next.js 14, deployed on Vercel |
| Backend | FastAPI (Python), deployed on Render |
| Database | MongoDB Atlas (M0 free tier), via Motor (async driver) |
| Auth | NextAuth.js (Google OAuth and bcryptjs credentials) |
| Media Storage | Cloudinary |
| Computer Vision | Roboflow-hosted YOLO models: species detection and coral bleach classifier |
| Mapping | MapLibre GL JS (CDN), OpenFreeMap liberty style, free terrain-DEM tiles |
| Ocean Data | Open-Meteo marine API (SST, cached 10 min) |
| Automation | n8n Cloud (detection alerts, scheduled species-data sync) |
| Species Data | OBIS, iNaturalist |
| Email | Resend |
| Rate Limiting | slowapi |
| PDF Export | reportlab |
| API Testing | Postman |

---

## Architecture Notes

- n8n talks to the backend, never directly to the database. All database writes from n8n workflows go through internal FastAPI endpoints protected by a shared secret header (`x-sync-secret`), keeping MongoDB credentials out of the automation layer.
- Detection alert pipeline: webhook receives the event, checks confidence is above 0.7, formats the alert, sends an email via Resend, then responds to the webhook. A 5-minute per-species cooldown in the backend prevents duplicate alerts from consecutive video frames.
- MapLibre GL JS is loaded via CDN, not npm. Bundling it through webpack silently breaks its internal Web Worker for tile parsing.

---

## Getting Started

### Prerequisites

- Node.js (for the frontend)
- Python 3.12.10 specifically. Newer versions (e.g. 3.14) break prebuilt numpy/PyTorch wheels
- A MongoDB Atlas cluster
- Roboflow, Cloudinary, and Resend accounts (for full functionality)

### Backend

```bash
cd backend
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 5050
```

Run uvicorn from inside `backend/`, not the project root. Kill any stale Python processes first if you hit unexplained inference errors.

Create a `.env` file in `backend/` with:

```
MONGODB_URI=
ROBOFLOW_API_KEY=
CLOUDINARY_URL=
N8N_DETECTION_WEBHOOK_URL=
ALLOWED_VIDEO_HOSTS=res.cloudinary.com
```

### Frontend

```bash
cd frontend
npm install
npm run dev
```

Create a `.env.local` file in `frontend/` with:

```
MONGODB_URI=
NEXTAUTH_SECRET=
NEXTAUTH_URL=http://localhost:3000
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
NEXT_PUBLIC_BACKEND_URL=http://localhost:5050
```

---

## Project Structure

```
telesto-node/
├── frontend/          Next.js app (mission control UI, auth, clip library, map)
├── backend/           FastAPI service (inference, alerts, telemetry, sync endpoints)
│   ├── app/
│   ├── validate_model.py    confidence-threshold sweep against labeled ground truth
│   └── assisted_label.py    semi-assisted labeling tool
└── README.md
```

---

## Known Limitations

This project is being built with research credibility in mind, so these are tracked openly rather than glossed over:

- Telemetry (depth, salinity, heading) is currently simulated, not from real sensors. GPS coordinates and temperature are real. The UI is being updated to visually distinguish measured vs. simulated data.
- Model accuracy has not yet been benchmarked against a labeled ground-truth set. Tooling (`validate_model.py`, `assisted_label.py`) exists, but the actual labeling pass is deferred.
- No standardized data export format yet for researchers.

---

## Roadmap

- [ ] Complete OBIS/iNaturalist scheduled species-data sync via n8n
- [ ] Run a labeled validation batch and publish real accuracy metrics
- [ ] Replace simulated telemetry with real sensor data
- [ ] Add an "unvalidated model" tag to detection confidence scores in the UI
- [ ] Standardized data export format for researchers
