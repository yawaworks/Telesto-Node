"use client";

import { useEffect, useRef, useState } from "react";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:5050";
const CAPTURE_INTERVAL_MS = 800; // ~1.25 fps — plenty for demo purposes, easy on the backend

/**
 * Periodically captures the current frame from a <video> element, POSTs it
 * to the FastAPI /analyze-frame endpoint, and returns the latest bounding
 * boxes, frame-level coral bleaching ratio, and connection status.
 */
export function useFrameDetection(videoRef, { enabled = true } = {}) {
  const [boxes, setBoxes] = useState([]);
  const [coralBleachingRatio, setCoralBleachingRatio] = useState(null);
  const [status, setStatus] = useState("idle"); // idle | connecting | live | error
  const canvasRef = useRef(null); // offscreen canvas used only for capture, not rendering
  const inFlightRef = useRef(false);

  useEffect(() => {
    if (!enabled) return;

    if (!canvasRef.current) {
      canvasRef.current = document.createElement("canvas");
    }

    let cancelled = false;
    let intervalId = null;

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

        const response = await fetch(`${API_BASE_URL}/analyze-frame`, {
          method: "POST",
          body: formData,
        });

        if (!response.ok) throw new Error(`Backend returned ${response.status}`);

        const data = await response.json();
        if (!cancelled) {
          setBoxes(data.boxes || []);
          setCoralBleachingRatio(
            data.coral_bleaching_ratio === undefined ? null : data.coral_bleaching_ratio
          );
          setStatus("live");
        }
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