"use client";

import { useEffect, useRef, useState, useCallback } from "react";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:5050";

// Keep label text out of the fixed chrome zones defined in page.js:
// top bar (0–56px), left telemetry panel (~0–240px wide), right action
// panel (last ~200px wide). Labels nudge below/inward instead of
// overlapping those regions.
const TOP_BAR_HEIGHT = 56;
const LEFT_PANEL_WIDTH = 240;
const RIGHT_PANEL_WIDTH = 200;
const LABEL_HEIGHT = 16;
const TAG_HEIGHT = 13;

const HOVER_DEBOUNCE_MS = 300;

/**
 * Renders YOLO bounding boxes on a <canvas> positioned exactly over the
 * given <video> element, and shows an AI-generated species detail tooltip
 * on hover. Boxes are in the original frame's pixel space (from the
 * backend), so we scale them to the video's displayed size.
 */
export default function DetectionOverlay({ videoRef, boxes }) {
  const canvasRef = useRef(null);
  const scaledBoxesRef = useRef([]); // last-drawn boxes in canvas pixel space, for hit-testing

  const [hoveredLabel, setHoveredLabel] = useState(null);
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });
  const [speciesData, setSpeciesData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState(null);

  const debounceRef = useRef(null);
  const abortRef = useRef(null);

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

      const scaledBoxes = [];

      boxes.forEach(({ label, confidence, x1, y1, x2, y2 }) => {
        const bx = x1 * scaleX;
        const by = y1 * scaleY;
        const bw = (x2 - x1) * scaleX;
        const bh = (y2 - y1) * scaleY;
        const lowConfidence = confidence < 0.75;

        scaledBoxes.push({ label, confidence, bx, by, bw, bh });

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

        let blockTop = by - blockHeight;
        if (blockTop < TOP_BAR_HEIGHT) {
          blockTop = by + bh + 2;
        }

        let blockLeft = bx;
        blockLeft = Math.max(LEFT_PANEL_WIDTH + 4, blockLeft);
        blockLeft = Math.min(canvas.width - RIGHT_PANEL_WIDTH - blockWidth - 4, blockLeft);
        if (blockLeft < LEFT_PANEL_WIDTH + 4) {
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

      scaledBoxesRef.current = scaledBoxes;
    }

    draw();
    const resizeObserver = new ResizeObserver(draw);
    resizeObserver.observe(video);

    return () => resizeObserver.disconnect();
  }, [videoRef, boxes]);

  const fetchSpeciesInfo = useCallback((label) => {
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setFetchError(null);
    setSpeciesData(null);

    console.debug("[DetectionOverlay] fetching species info for:", label);

    fetch(`${API_BASE_URL}/species-info?name=${encodeURIComponent(label)}`, {
      signal: controller.signal,
    })
      .then((res) => {
        if (!res.ok) throw new Error(`Lookup failed: ${res.status}`);
        return res.json();
      })
      .then((data) => {
        console.debug("[DetectionOverlay] species info result:", data);
        setSpeciesData(data);
      })
      .catch((err) => {
        if (err.name !== "AbortError") {
          console.error("Species info lookup failed:", err);
          setFetchError("Couldn't load species info");
        }
      })
      .finally(() => setLoading(false));
  }, []);

  function handleMouseMove(e) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    // A few px of forgiveness around each box — detection boxes are often
    // a little offset from the actual animal, so requiring an exact
    // pixel-perfect hover makes the feature feel broken even when it's
    // working. Remove HIT_PADDING (or the console.debug lines) once
    // you've confirmed hover detection is firing correctly.
    const HIT_PADDING = 6;
    const hit = scaledBoxesRef.current.find(
      (b) =>
        mx >= b.bx - HIT_PADDING &&
        mx <= b.bx + b.bw + HIT_PADDING &&
        my >= b.by - HIT_PADDING &&
        my <= b.by + b.bh + HIT_PADDING
    );

    if (!hit) {
      if (hoveredLabel !== null) {
        console.debug("[DetectionOverlay] left box:", hoveredLabel);
        setHoveredLabel(null);
        setSpeciesData(null);
        setFetchError(null);
        if (debounceRef.current) clearTimeout(debounceRef.current);
      }
      return;
    }

    setTooltipPos({ x: hit.bx + hit.bw / 2, y: hit.by });

    if (hit.label !== hoveredLabel) {
      console.debug("[DetectionOverlay] hovering box:", hit.label, "at", { bx: hit.bx, by: hit.by });
      setHoveredLabel(hit.label);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => fetchSpeciesInfo(hit.label), HOVER_DEBOUNCE_MS);
    }
  }

  function handleMouseLeave() {
    setHoveredLabel(null);
    setSpeciesData(null);
    setFetchError(null);
    if (debounceRef.current) clearTimeout(debounceRef.current);
  }

  return (
    <div className="absolute inset-0 w-full h-full">
      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full"
        style={{ pointerEvents: "auto", cursor: hoveredLabel ? "help" : "default" }}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
      />

      {hoveredLabel && (
        <div
          className="absolute z-20 w-64 -translate-x-1/2 -translate-y-full bg-[#1c2226] border border-[#3a444a] rounded-lg px-3 py-2.5 pointer-events-none font-mono text-xs"
          style={{ left: tooltipPos.x, top: Math.max(64, tooltipPos.y - 8) }}
        >
          <p className="text-[#d3dbe0] font-bold mb-1.5">{hoveredLabel}</p>

          {loading && <p className="text-[#5a6a72]">Looking up species info…</p>}

          {fetchError && <p className="text-[#c47a6e]">{fetchError}</p>}

          {speciesData && !speciesData.error && (
            <div className="space-y-1 text-[#b7c4cc]">
              {speciesData.scientific_name && (
                <p><span className="text-[#8fa3ad]">Scientific name:</span> {speciesData.scientific_name}</p>
              )}
              {speciesData.taxon_rank && (
                <p><span className="text-[#8fa3ad]">Rank:</span> {speciesData.taxon_rank}</p>
              )}
              {speciesData.kingdom && (
                <p><span className="text-[#8fa3ad]">Kingdom:</span> {speciesData.kingdom}</p>
              )}
              {speciesData.summary && (
                <p className="pt-1">{speciesData.summary}</p>
              )}
              <p className="text-[#5a6a72] pt-1.5 border-t border-[#3a444a] mt-1.5">
                Source: Wikipedia &amp; OBIS
                {speciesData.wikipedia_url && (
                  <>
                    {" · "}
                    <a
                      href={speciesData.wikipedia_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline hover:text-[#8fa3ad] pointer-events-auto"
                    >
                      read more
                    </a>
                  </>
                )}
              </p>
            </div>
          )}

          {speciesData?.error && (
            <p className="text-[#c47a6e]">{speciesData.error}</p>
          )}
        </div>
      )}
    </div>
  );
}