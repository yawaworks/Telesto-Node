# Telesto Node

**Real-time marine ecosystem monitoring and health analytics.**
Live ROV mission control, gamepad navigation, computer-vision species detection, coral bleaching analysis, and 3D bathymetry mapping — built to give researchers a live, immersive "cockpit" for underwater footage instead of a post-hoc annotation tool.

🔗 **Live app:** [telesto-node.vercel.app](https://telesto-node.vercel.app)

---

## What it does

- **Live ROV Feed** — gamepad-navigable video feed (default clip, webcam, uploaded file, or a proxied external URL) with real-time YOLO-based species detection overlaid directly on the video.
- **Species Inspector** — click any detected species to open a research panel pulling from **eight independent free data sources**: Wikipedia (summary + lead image), OBIS (taxonomy), OpenAlex + Semantic Scholar + CrossRef (research papers, deduped and merged), iNaturalist (real community photo galleries), Biodiversity Heritage Library (historical type-specimen illustrations), and IUCN Red List (conservation status).
- **Ghost-box hover-rewind** — a species that swims out of frame leaves a "ghost" outline for a few seconds; hovering it seeks the video back to the exact moment it was last seen.
- **Coral bleaching classifier** — a second CV model flags bleaching risk per frame, clearly labeled as an unvalidated model reading, not a scientific measurement.
- **3D Bathymetry Map** — MapLibre GL + free terrain-DEM tiles, with a live species search that plots real OBIS occurrence data as markers, auto-fitting the camera to the result cluster (with outlier filtering so one stray record doesn't zoom the camera out to the whole planet).
- **Discovery Snapshots** — capture and annotate frames (screenshot-tool style), save to a personal or team-shared gallery.
- **Clip Library** — save, browse, and share video clips across a research team.
- **Mission Reports** — generate a PDF report of a session's detections and coral health readings, downloadable or emailed directly.
- **Detection alerts** — high-confidence detections email the currently logged-in researcher automatically, with real coordinates and a map link.

---

## Stack

| Layer | Choice |
|---|---|
| Frontend | Next.js 14 (Vercel) |
| Backend | FastAPI / Python (Render) |
| Database | MongoDB Atlas (M0 free tier) |
| Media storage | Cloudinary |
| Auth | NextAuth.js (Google OAuth + credentials) |
| Computer vision | Roboflow-hosted YOLO (species detection + coral bleach classifier) |
| Mapping | MapLibre GL JS + OpenFreeMap (free vector tiles) + AWS open-data terrain DEM |
| Ocean data | Open-Meteo (live sea temperature), OBIS + iNaturalist (species occurrence/photos) |
| Email | Resend |
| Scheduled automation | **GitHub Actions** (free, no separate hosting) |

### Why no n8n?

Earlier iterations of this project used n8n (both cloud and self-hosted Docker) for scheduled jobs and notification workflows. It's been fully removed: n8n Cloud's free trial has a hard execution cap and eventually requires payment; self-hosted n8n only runs while a laptop/Docker instance stays on, which defeats the purpose of "scheduled" automation. Everything n8n did is now either:

- **Called directly from the FastAPI backend** (detection alerts, mission report emails) — since the backend is already deployed 24/7 for free on Render, there was no reason to route through a second service just to make an HTTP request it can already make itself.
- **Run as free GitHub Actions cron jobs** (species data sync every 6 hours, backend keep-alive ping every 20 minutes) — genuinely free forever, runs on GitHub's infrastructure regardless of anyone's laptop being on, and GitHub emails you automatically on a failed run (free error alerting, no extra workflow needed).

---

## Repository layout

```
backend/
  app/
    main.py              FastAPI app, all routes
    alerts.py            Direct-to-Resend detection alert emails
    report_email.py      Direct-to-Resend mission report emails
    species_info.py      Species Inspector's 8-source data aggregator
    inference.py         Roboflow inference + CLAHE preprocessing
    telemetry.py         Simulated ROV telemetry generator
    obis_client.py       OBIS occurrence data fetcher
    db.py                MongoDB connection
    cloudinary_client.py Media upload/delete helpers
    report.py            PDF mission report generator
frontend/
  app/                   Next.js App Router pages
  components/            DetectionOverlay, SnapshotAnnotator, etc.
  lib/                   bathymetry-map.js, species-markers.js, hooks
scripts/
  sync_species.py        Run by the GitHub Actions species-sync workflow
.github/workflows/
  species-sync.yml       Every 6 hours — OBIS/iNaturalist → backend cache
  keep-alive.yml         Every 20 minutes — pings /health to fight Render cold starts
```

---

## Environment variables

### Backend (Render)

| Variable | Required | Notes |
|---|---|---|
| `MONGO_URI` | Yes | MongoDB Atlas connection string |
| `ROBOFLOW_API_KEY` | Yes | Species detection + bleach classifier |
| `CLOUDINARY_*` | Yes | Media upload credentials |
| `RESEND_API_KEY` | Yes | Detection alerts + mission report emails |
| `ALERT_FROM_EMAIL` | No | Defaults to `onboarding@resend.dev` |
| `ALERT_TO_EMAIL` | No | Fallback only — alerts normally go to the logged-in user |
| `INTERNAL_SYNC_SECRET` | Yes | Shared secret for the GitHub Actions species-sync push |
| `S2_API_KEY` | No | Semantic Scholar — free key, approval required |
| `BHL_API_KEY` | No | Biodiversity Heritage Library — free, instant |
| `IUCN_API_KEY` | No | IUCN Red List — free, instant |
| `DEEPL_API_KEY` | No | Human-language translation upgrade — free keyless MyMemory provider used when unset |
| `TRANSLATE_PROVIDER` | No | `mymemory` (default) or `lingva` (opt-in — public instances have shown 403s in real testing) |
| `LINGVA_INSTANCE_URL` | No | Only relevant if using Lingva — override if the default public instance is down |
| `ALLOWED_VIDEO_HOSTS` | No | Comma-separated extra hosts for `/proxy-video` |
| `FRONTEND_ORIGIN` | Yes | For CORS |

All three optional research-API keys degrade gracefully when unset — the Species Inspector just shows less (no diagrams tab, no conservation badge), never errors. Translation degrades differently: it never turns off. With no `DEEPL_API_KEY`, source language is detected locally (via `langdetect`, fully offline — no external autodetect service to depend on) and translated via MyMemory, with Lingva available as an opt-in alternative/fallback. Neither MyMemory nor Lingva needs a key or signup of any kind; DeepL is the only provider here that does. One known gap: local detection needs ~20+ characters of text to be reliable (shorter than that, `langdetect` gives confidently wrong guesses, not just uncertain ones) — very short messages fall through to whichever provider can still attempt real autodetect.

### Frontend (Vercel)

| Variable | Required | Notes |
|---|---|---|
| `NEXT_PUBLIC_API_BASE_URL` | Yes | Your Render backend URL |
| `NEXT_PUBLIC_DEFAULT_VIDEO_URL` | No | Cloudinary-hosted demo clip |
| `NEXTAUTH_URL`, `NEXTAUTH_SECRET` | Yes | Auth |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Yes | Google OAuth |

### GitHub Actions (repo secrets)

| Secret | Notes |
|---|---|
| `BACKEND_URL` | Your Render backend URL, no trailing slash |
| `INTERNAL_SYNC_SECRET` | Must match the backend's value exactly |

---

## Local development

```bash
# Backend
cd backend
pip install -r requirements.txt --break-system-packages
uvicorn app.main:app --reload --port 5050

# Frontend
cd frontend
npm install
npm run dev
```

> **Python version note:** pin `PYTHON_VERSION=3.12.10` on Render — the default (3.14 at time of writing) breaks numpy/PyTorch's prebuilt wheels.

---

## Known limitations (being upfront about it)

This is a genuinely solid full-stack build, but it is **not yet a validated research instrument**:

- **No benchmarked model accuracy** — `validate_model.py` exists but hasn't been run against ground-truth labels yet.
- **Simulated telemetry** — depth, salinity, and heading are synthetic (visually distinguished in the UI as "simulated" vs. "measured"), not from real sensor hardware.
- **No marine-biologist domain review** — detections are flagged "unvalidated model" throughout the UI deliberately, since that review hasn't happened.

Closing that gap is a data-validation and domain-partnership problem, not a coding problem — see the project plan doc for the full roadmap.

---

## Data sources & credit

OBIS · iNaturalist · Wikipedia · OpenAlex · Semantic Scholar · CrossRef · Biodiversity Heritage Library · IUCN Red List · Open-Meteo · OpenFreeMap · OpenStreetMap · AWS Open Data (Terrarium terrain tiles)