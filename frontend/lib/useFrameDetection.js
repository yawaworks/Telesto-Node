"use client";

import { useEffect, useRef, useState } from "react";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:5050";
// Every 2 model calls per frame now (marine-fishes + bleach classifier), so
// space captures out more to conserve Roboflow credits.
const CAPTURE_INTERVAL_MS = 2500;
const CONF_THRESHOLD = 0.2;

const HOLD_FRAMES = 3;
const MIN_CONSECUTIVE_HITS = 1;
const HISTORY_LENGTH = 3;
const MATCH_DISTANCE_PX = 250;

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
 */
export function useFrameDetection(videoRef, { enabled = true, telemetry } = {}) {
  const [boxes, setBoxes] = useState([]);
  const [classifications, setClassifications] = useState([]);
  const [coralBleachingRatio, setCoralBleachingRatio] = useState(null);
  const [status, setStatus] = useState("idle");
  const canvasRef = useRef(null);
  const inFlightRef = useRef(false);

  const historyRef = useRef([]);
  const lastGoodBoxesRef = useRef([]);
  const missedFramesRef = useRef(0);

  const telemetryRef = useRef(telemetry);
  useEffect(() => {
    telemetryRef.current = telemetry;
  }, [telemetry]);

  useEffect(() => {
    if (!enabled) return;

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
        const params = new URLSearchParams({ conf_threshold: String(CONF_THRESHOLD) });
        const currentTelemetry = telemetryRef.current;
        if (currentTelemetry?.lat != null && currentTelemetry?.lng != null) {
          params.set("latitude", String(currentTelemetry.lat));
          params.set("longitude", String(currentTelemetry.lng));
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

        if (smoothed.length > 0) {
          lastGoodBoxesRef.current = smoothed;
          missedFramesRef.current = 0;
          setBoxes(smoothed);
        } else if (rawBoxes.length === 0 && missedFramesRef.current < HOLD_FRAMES) {
          missedFramesRef.current += 1;
          setBoxes(lastGoodBoxesRef.current);
        } else {
          missedFramesRef.current += 1;
          lastGoodBoxesRef.current = [];
          setBoxes([]);
        }

        setClassifications(data.classifications || []);
        setCoralBleachingRatio(
          data.coral_bleaching_ratio === undefined ? null : data.coral_bleaching_ratio
        );
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

    intervalId = setInterval(captureAndSend, CAPTURE_INTERVAL_MS);

    return () => {
      cancelled = true;
      if (intervalId) clearInterval(intervalId);
    };
  }, [videoRef, enabled]);

  return { boxes, classifications, coralBleachingRatio, status };
}