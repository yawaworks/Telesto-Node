"use client";

import { useEffect, useRef, useState } from "react";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:5050";
const CAPTURE_INTERVAL_MS = 800;
const CONF_THRESHOLD = 0.2;

// Temporal smoothing settings:
// - If a frame comes back with NO detections, keep showing the last known
//   boxes for up to HOLD_FRAMES more cycles before clearing (handles brief
//   missed detections on a fish that's clearly still there).
// - A label only "counts" as confirmed once it's appeared in at least
//   MIN_CONSECUTIVE_HITS out of the last few frames, cutting down on
//   single-frame flicker/misfires.
const HOLD_FRAMES = 2; // ~1.6s grace period at 800ms interval
const MIN_CONSECUTIVE_HITS = 2;
const HISTORY_LENGTH = 3;

/**
 * Groups nearby boxes across frames by rough position so we can track
 * "the same detection" over time even if exact coordinates shift slightly.
 */
function centerOf(box) {
  return [(box.x1 + box.x2) / 2, (box.y1 + box.y2) / 2];
}

function distance(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

const MATCH_DISTANCE_PX = 80; // how close two boxes' centers must be to count as "the same" detection across frames

export function useFrameDetection(videoRef, { enabled = true } = {}) {
  const [boxes, setBoxes] = useState([]);
  const [coralBleachingRatio, setCoralBleachingRatio] = useState(null);
  const [status, setStatus] = useState("idle");
  const canvasRef = useRef(null);
  const inFlightRef = useRef(false);

  // Smoothing state (kept in refs so it doesn't trigger extra re-renders)
  const historyRef = useRef([]); // last few frames' raw boxes
  const lastGoodBoxesRef = useRef([]);
  const missedFramesRef = useRef(0);

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

      // For each box in the newest frame, count how many of the recent
      // frames had a box in roughly the same place with the same label.
      const confirmed = rawBoxes.filter((box) => {
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

      return confirmed;
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

        const response = await fetch(
          `${API_BASE_URL}/analyze-frame?conf_threshold=${CONF_THRESHOLD}`,
          {
            method: "POST",
            body: formData,
          }
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
          // Nothing detected this frame — hold the last known boxes briefly
          // rather than instantly blanking, in case it's a momentary miss.
          missedFramesRef.current += 1;
          setBoxes(lastGoodBoxesRef.current);
        } else {
          missedFramesRef.current += 1;
          lastGoodBoxesRef.current = [];
          setBoxes([]);
        }

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

  return { boxes, coralBleachingRatio, status };
}