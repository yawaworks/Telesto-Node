"use client";

import { useEffect, useRef, useState } from "react";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:5050";
// Every 2 model calls per frame now (marine-fishes + bleach classifier), so
// space captures out more to conserve Roboflow credits.
const CAPTURE_INTERVAL_MS = 2500;
// Default only — the actual value used per-request now comes from the
// confThreshold option (backed by a UI slider in MissionControl). Kept
// as the fallback so any caller that doesn't pass one still behaves
// exactly like before.
export const DEFAULT_CONF_THRESHOLD = 0.2;

const MIN_CONSECUTIVE_HITS = 1;
const HISTORY_LENGTH = 3;
const MATCH_DISTANCE_PX = 250;

// How long a species stays hoverable as a faint "ghost" box after it
// actually leaves frame. After this, the box is gone completely — nothing
// left to rewind to until it's detected again for real.
const GHOST_EXPIRY_MS = 3000;

function centerOf(box) {
  return [(box.x1 + box.x2) / 2, (box.y1 + box.y2) / 2];
}
function distance(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

/**
 * @param {object} [options]
 * @param {boolean} [options.enabled]
 * @param {{lat?: number, lng?: number}} [options.telemetry] - current
 *   mission telemetry (e.g. from useTelemetry()). Read via a ref so fast
 *   telemetry updates don't tear down and rebuild the capture interval —
 *   only the latest value at capture time is sent along with the frame,
 *   as query params, so the backend can attach real coordinates to any
 *   n8n detection alert it fires.
 * @param {string} [options.alertEmail] - the logged-in researcher's
 *   session email, sent with every frame so detection alerts go to
 *   whoever is actually running this mission, not one fixed inbox.
 * @param {string} [options.ownerEmail] - same session email, stored on
 *   every logged detection so mission reports can later be scoped to
 *   "mine" vs "team" (see MissionControl's report scope toggle).
 * @param {number} [options.confThreshold] - minimum Roboflow confidence
 *   (0-1) for a detection to be returned at all. Lower catches more
 *   (noisier) detections; higher shows only the model's most confident
 *   calls. Read via a ref, same pattern as telemetry/alertEmail, so
 *   dragging the slider doesn't tear down and restart the capture
 *   interval — only the next scheduled frame picks up the new value.
 *
 * Returns both `boxes` (species actually visible in the current frame)
 * and `ghostBoxes` (species seen within the last GHOST_EXPIRY_MS but not
 * currently in frame — last known position + the exact video.currentTime
 * they were last seen at, so a hover can seek the video back to that
 * moment). DetectionOverlay is responsible for rendering/hovering both.
 */
export function useFrameDetection(
  videoRef,
  { enabled = true, telemetry, alertEmail, ownerEmail, confThreshold = DEFAULT_CONF_THRESHOLD } = {}
) {
  const [boxes, setBoxes] = useState([]);
  const [ghostBoxes, setGhostBoxes] = useState([]);
  const [classifications, setClassifications] = useState([]);
  const [coralBleachingRatio, setCoralBleachingRatio] = useState(null);
  // { heading_delta_deg, magnitude } | null — dense optical flow computed
  // backend-side between this frame and the previous one (app/optical_flow.py).
  // Genuinely derived from the video's pixels, not simulated. Null on the
  // first frame of a clip or right after a source switch, since there's
  // nothing to compare against yet.
  const [opticalFlow, setOpticalFlow] = useState(null);
  const [status, setStatus] = useState("idle");
  const canvasRef = useRef(null);
  const inFlightRef = useRef(false);

  const historyRef = useRef([]);

  // label -> { box: {x1,y1,x2,y2}, videoTime: number, lastSeenAt: number }
  // videoTime is video.currentTime at the moment it was last actually
  // detected — that's the timestamp a hover-rewind seeks back to.
  // lastSeenAt is wall-clock Date.now(), used for the 3s ghost expiry
  // (real elapsed time, not video time — a paused/rewound video shouldn't
  // extend a ghost's life just because video time isn't advancing).
  const recentDetectionsRef = useRef(new Map());

  const telemetryRef = useRef(telemetry);
  useEffect(() => {
    telemetryRef.current = telemetry;
  }, [telemetry]);

  // Same ref pattern as telemetry — session email rarely changes mid-use,
  // but reading it via ref keeps this consistent and avoids adding it as
  // a dependency that could restart the capture interval unnecessarily.
  const alertEmailRef = useRef(alertEmail);
  useEffect(() => {
    alertEmailRef.current = alertEmail;
  }, [alertEmail]);

  const ownerEmailRef = useRef(ownerEmail);
  useEffect(() => {
    ownerEmailRef.current = ownerEmail;
  }, [ownerEmail]);

  // Same ref pattern — the slider can move every render while a capture
  // is mid-flight; reading it via ref means the in-flight request keeps
  // using the value it started with, and the *next* interval tick is
  // the first one to see a dragged slider's new value.
  const confThresholdRef = useRef(confThreshold);
  useEffect(() => {
    confThresholdRef.current = confThreshold;
  }, [confThreshold]);

  useEffect(() => {
    if (!enabled) {
      // Video source may change while disabled (switching clips) — old
      // timestamps from a previous source would be meaningless to seek
      // to, so clear the slate whenever detection is turned off.
      recentDetectionsRef.current.clear();
      setGhostBoxes([]);
      setOpticalFlow(null);
      return;
    }

    if (!canvasRef.current) {
      canvasRef.current = document.createElement("canvas");
    }

    let cancelled = false;
    let intervalId = null;

    function computeSmoothedBoxes(rawBoxes) {
      historyRef.current.push(rawBoxes);
      if (historyRef.current.length > HISTORY_LENGTH) {
        historyRef.current.shift();
      }
      if (MIN_CONSECUTIVE_HITS <= 1) return rawBoxes;

      return rawBoxes.filter((box) => {
        const center = centerOf(box);
        let hits = 0;
        for (const frame of historyRef.current) {
          const matched = frame.some(
            (b) => b.label === box.label && distance(centerOf(b), center) < MATCH_DISTANCE_PX
          );
          if (matched) hits += 1;
        }
        return hits >= MIN_CONSECUTIVE_HITS;
      });
    }

    // Updates the last-seen map from this frame's real detections, then
    // builds the ghost list from whatever's left in the map that (a)
    // wasn't just seen and (b) hasn't expired yet. Expired entries are
    // dropped from the map here too, so it never grows unbounded.
    function updateGhosts(smoothedBoxes, video) {
      const now = Date.now();
      const seenLabels = new Set(smoothedBoxes.map((b) => b.label));

      for (const box of smoothedBoxes) {
        recentDetectionsRef.current.set(box.label, {
          box: { x1: box.x1, y1: box.y1, x2: box.x2, y2: box.y2 },
          videoTime: video.currentTime,
          lastSeenAt: now,
        });
      }

      const ghosts = [];
      for (const [label, entry] of recentDetectionsRef.current.entries()) {
        if (seenLabels.has(label)) continue; // currently visible, not a ghost
        if (now - entry.lastSeenAt >= GHOST_EXPIRY_MS) {
          recentDetectionsRef.current.delete(label);
          continue;
        }
        ghosts.push({
          label,
          x1: entry.box.x1,
          y1: entry.box.y1,
          x2: entry.box.x2,
          y2: entry.box.y2,
          videoTime: entry.videoTime,
          ghost: true,
        });
      }
      setGhostBoxes(ghosts);
    }

    async function captureAndSend() {
      const video = videoRef.current;
      if (!video || video.readyState < 2 || inFlightRef.current) return;

      inFlightRef.current = true;
      try {
        const canvas = canvasRef.current;
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

        const blob = await new Promise((resolve) =>
          canvas.toBlob(resolve, "image/jpeg", 0.8)
        );
        if (!blob || cancelled) return;

        const formData = new FormData();
        formData.append("file", blob, "frame.jpg");

        setStatus((prev) => (prev === "live" ? "live" : "connecting"));

        // latitude/longitude are query params on the backend (same as
        // conf_threshold), not form fields — FastAPI reads plain scalar
        // params as query params when the request body is multipart.
        const params = new URLSearchParams({
          conf_threshold: String(confThresholdRef.current),
        });
        const currentTelemetry = telemetryRef.current;
        if (currentTelemetry?.lat != null && currentTelemetry?.lng != null) {
          params.set("latitude", String(currentTelemetry.lat));
          params.set("longitude", String(currentTelemetry.lng));
        }
        // Detection alerts go to whoever's actually logged in and running
        // this mission — not a single fixed inbox — so this rides along
        // with every frame the same way lat/lng does.
        if (alertEmailRef.current) {
          params.set("alert_email", alertEmailRef.current);
        }
        // Stored on every logged detection so mission reports can later
        // be filtered to "mine" vs "team" (see app/report.py).
        if (ownerEmailRef.current) {
          params.set("owner_email", ownerEmailRef.current);
        }

        const response = await fetch(
          `${API_BASE_URL}/analyze-frame?${params.toString()}`,
          { method: "POST", body: formData }
        );

        if (!response.ok) throw new Error(`Backend returned ${response.status}`);

        const data = await response.json();
        if (cancelled) return;

        const rawBoxes = data.boxes || [];
        const smoothed = computeSmoothedBoxes(rawBoxes);

        // Boxes now ONLY reflect what's actually detected this frame —
        // no artificial hold-over for missed frames. A species not
        // currently in view has no solid box; it only lives on as a
        // ghost (see updateGhosts) until GHOST_EXPIRY_MS passes.
        setBoxes(smoothed);
        updateGhosts(smoothed, video);

        setClassifications(data.classifications || []);
        setCoralBleachingRatio(
          data.coral_bleaching_ratio === undefined ? null : data.coral_bleaching_ratio
        );
        setOpticalFlow(data.optical_flow ?? null);
        setStatus("live");
      } catch (err) {
        if (!cancelled) {
          console.error("Frame detection error:", err);
          setStatus("error");
        }
      } finally {
        inFlightRef.current = false;
      }
    }

    // Fire the first capture immediately rather than waiting for
    // setInterval's first tick — setInterval doesn't run its callback
    // right away, so without this the status sat on "Connecting…" for a
    // full CAPTURE_INTERVAL_MS (2.5s) before the very first request even
    // went out, on top of however long that request itself took.
    captureAndSend();
    intervalId = setInterval(captureAndSend, CAPTURE_INTERVAL_MS);

    return () => {
      cancelled = true;
      if (intervalId) clearInterval(intervalId);
    };
  }, [videoRef, enabled]);

  return { boxes, ghostBoxes, classifications, coralBleachingRatio, opticalFlow, status };
}