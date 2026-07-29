"use client";

import { useEffect, useRef } from "react";

// Keep label text out of the fixed chrome zones defined in page.js:
// top bar (0–56px), left telemetry panel (~0–240px wide), right action
// panel (last ~200px wide). Labels nudge below/inward instead of
// overlapping those regions.
const TOP_BAR_HEIGHT = 56;
const LEFT_PANEL_WIDTH = 240;
const RIGHT_PANEL_WIDTH = 200;
const LABEL_HEIGHT = 16;
const TAG_HEIGHT = 13;

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
        const lowConfidence = confidence < 0.75;

        // Box — slate for higher-confidence, dashed for lower-confidence
        ctx.strokeStyle = "#8fa3ad";
        ctx.lineWidth = 2;
        if (lowConfidence) {
          ctx.setLineDash([5, 4]);
          ctx.globalAlpha = 0.7;
        } else {
          ctx.setLineDash([]);
          ctx.globalAlpha = 1;
        }
        ctx.strokeRect(bx, by, bw, bh);
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;

        const labelText = `${label} ${(confidence * 100).toFixed(0)}%`;
        const tagText = "unvalidated model";
        ctx.font = "12px monospace";
        const labelWidth = ctx.measureText(labelText).width;
        ctx.font = "9px monospace";
        const tagWidth = ctx.measureText(tagText).width;
        const blockWidth = Math.max(labelWidth, tagWidth) + 8;
        const blockHeight = LABEL_HEIGHT + TAG_HEIGHT;

        // Default: stack label+tag above the box. If that would sit under
        // the top bar, place it below the box instead.
        let blockTop = by - blockHeight;
        if (blockTop < TOP_BAR_HEIGHT) {
          blockTop = by + bh + 2;
        }

        // Clamp horizontally so the block never runs into the left or
        // right chrome panels.
        let blockLeft = bx;
        blockLeft = Math.max(LEFT_PANEL_WIDTH + 4, blockLeft);
        blockLeft = Math.min(canvas.width - RIGHT_PANEL_WIDTH - blockWidth - 4, blockLeft);
        if (blockLeft < LEFT_PANEL_WIDTH + 4) {
          // Canvas narrower than both panels combined — just clamp to canvas.
          blockLeft = Math.max(4, Math.min(canvas.width - blockWidth - 4, bx));
        }

        ctx.fillStyle = "rgba(143, 163, 173, 0.85)";
        ctx.fillRect(blockLeft, blockTop, blockWidth, LABEL_HEIGHT);
        ctx.fillStyle = "#0c1113";
        ctx.font = "12px monospace";
        ctx.fillText(labelText, blockLeft + 4, blockTop + 12);

        ctx.fillStyle = "rgba(164, 138, 85, 0.85)";
        ctx.fillRect(blockLeft, blockTop + LABEL_HEIGHT, blockWidth, TAG_HEIGHT);
        ctx.fillStyle = "#241d10";
        ctx.font = "9px monospace";
        ctx.fillText(tagText, blockLeft + 4, blockTop + LABEL_HEIGHT + 10);
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