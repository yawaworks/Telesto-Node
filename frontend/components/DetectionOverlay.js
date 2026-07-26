"use client";

import { useEffect, useRef } from "react";

/**
 * Renders YOLO bounding boxes on a <canvas> positioned exactly over the
 * given <video> element. Boxes are in the original frame's pixel space
 * (from the backend), so we scale them to the video's displayed size.
 */
export default function DetectionOverlay({ videoRef, boxes }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;

    function draw() {
      const { clientWidth, clientHeight, videoWidth, videoHeight } = video;
      if (!videoWidth || !videoHeight) return;

      canvas.width = clientWidth;
      canvas.height = clientHeight;

      const scaleX = clientWidth / videoWidth;
      const scaleY = clientHeight / videoHeight;

      const ctx = canvas.getContext("2d");
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      boxes.forEach(({ label, confidence, x1, y1, x2, y2 }) => {
        const bx = x1 * scaleX;
        const by = y1 * scaleY;
        const bw = (x2 - x1) * scaleX;
        const bh = (y2 - y1) * scaleY;

        ctx.strokeStyle = "#22d3ee";
        ctx.lineWidth = 2;
        ctx.strokeRect(bx, by, bw, bh);

        const text = `${label} ${(confidence * 100).toFixed(0)}%`;
        ctx.font = "12px monospace";
        const textWidth = ctx.measureText(text).width;

        ctx.fillStyle = "rgba(34, 211, 238, 0.85)";
        ctx.fillRect(bx, Math.max(0, by - 16), textWidth + 8, 16);

        ctx.fillStyle = "#000";
        ctx.fillText(text, bx + 4, Math.max(11, by - 4));
      });
    }

    draw();
    // Redraw on resize since the video's displayed size can change
    const resizeObserver = new ResizeObserver(draw);
    resizeObserver.observe(video);

    return () => resizeObserver.disconnect();
  }, [videoRef, boxes]);

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 w-full h-full pointer-events-none"
    />
  );
}