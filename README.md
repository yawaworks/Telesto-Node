# Telesto Node — Starter Scaffold

Real-Time Marine Ecosystem Monitoring & Health Analytics. This scaffold matches
the architecture in the hackathon plan: a FastAPI/YOLO inference backend and a
Next.js/Tailwind/Mapbox mission-control frontend.

## Folder layout

```
Telesto Node/
├── backend/
│   ├── app/
│   │   ├── main.py           # FastAPI app: /analyze-frame, /ws/telemetry
│   │   ├── inference.py      # CLAHE + YOLO model loader
│   │   ├── local_inference.py# Standalone webcam/video test script
│   │   └── obis_client.py    # OBIS species data extractor
│   ├── weights/               # Drop your fine-tuned .pt weights here
│   ├── requirements.txt
│   └── .env.example
└── frontend/
    ├── app/
    │   ├── layout.js
    │   ├── page.js             # HUD mission-control screen
    │   └── globals.css
    ├── lib/
    │   ├── gamepad-controller.js
    │   └── mapbox-setup.js
    ├── package.json
    ├── tailwind.config.js
    └── .env.local.example
```

## 1. Move this into place

Unzip this scaffold's contents directly into your existing **Telesto Node**
folder on the Desktop, so you end up with `Telesto Node/backend` and
`Telesto Node/frontend` side by side.

## 2. Backend setup (FastAPI + YOLO)

```bash
cd "Telesto Node/backend"
python3 -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env            # fill in Mongo/Cloudinary/GFW keys as you get them
uvicorn app.main:app --reload --port 8000
```

Check it's alive: open http://localhost:8000/health → `{"status": "ok"}`.

Until your fine-tuned marine weights (Roboflow export) are ready, the model
loader automatically falls back to stock `yolov8n.pt` so the endpoint works
out of the box for early integration testing.

## 3. Frontend setup (Next.js + Tailwind + Mapbox)

```bash
cd "Telesto Node/frontend"
npm install
cp .env.local.example .env.local   # add your Mapbox public token
npm run dev
```

Open http://localhost:3000 → you should see the dark-mode HUD with depth,
coordinates, temp/salinity/heading badges, the pulsing reticle, and CRT
scanlines. Plug in an Xbox/PS controller to test camera + scrubbing controls.

## 4. Wire frontend → backend

In `frontend/app/page.js` (or a new component), POST captured video frames as
`multipart/form-data` to `${NEXT_PUBLIC_API_BASE_URL}/analyze-frame` and draw
the returned bounding boxes over the `<video>` element with a `<canvas>` overlay.

## 5. Suggested build order (matches the 36-hour roadmap)

1. **Hours 0–6:** Get `/analyze-frame` returning real boxes from a Roboflow-exported
   YOLO checkpoint dropped into `backend/weights/`.
2. **Hours 6–14:** Wire `coral_bleaching_ratio()` in `inference.py` into the
   response, and get `obis_client.py` pulling live species coordinates.
3. **Hours 14–26:** Flesh out the HUD, plug in real Mapbox terrain/fog, and
   get the gamepad hooked to both video scrubbing and map pitch/bearing.
4. **Hours 26–36:** Record your three demo clips (healthy reef / bleaching /
   invasive outbreak), add the PDF export button, and rehearse the pitch.

## Auth / DB / hosting (per the plan's free stack)

- **Auth:** NextAuth.js — `npm install next-auth` in `frontend/`, add an API route
  under `frontend/app/api/auth/[...nextauth]/route.js` when you're ready.
- **Database:** MongoDB Atlas free M0 tier — put the connection string in
  `backend/.env` as `MONGODB_URI`.
- **Media storage:** Cloudinary free tier for ROV clips/snapshots.
- **Hosting:** Vercel (frontend), Render (backend/FastAPI).
