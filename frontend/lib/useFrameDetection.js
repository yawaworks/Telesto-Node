"use client";

import { useEffect, useRef, useState } from "react";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:5050";
const CAPTURE_INTERVAL_MS = 800;
// Lowered temporarily to 0.15 to help confirm the model is actually firing
// on more frames while it's still lightly trained. Raise back toward 0.35+
// once you have a better-trained model or want fewer false positives.
const CONF_THRESHOLD = 0.15;

export function useFrameDetection(videoRef, { enabled = true } = {}) {
  const [boxes, setBoxes] = useState([]);
  const [coralBleachingRatio, setCoralBleachingRatio] = useState(null);
  const [status, setStatus] = useState("idle");
  const canvasRef = useRef(null);
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

        const response = await fetch(
          `${API_BASE_URL}/analyze-frame?conf_threshold=${CONF_THRESHOLD}`,
          {
            method: "POST",
            body: formData,
          }
        );

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