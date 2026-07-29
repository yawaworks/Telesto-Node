"use client";

import { useEffect, useLayoutEffect, useRef, useState, useCallback } from "react";

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

// Tooltip is w-64 (256px) — used to clamp its horizontal center so it can
// never render partially off-screen or under the side chrome panels.
const TOOLTIP_WIDTH = 256;
const TOOLTIP_HALF_WIDTH = TOOLTIP_WIDTH / 2;
const TOOLTIP_EDGE_PADDING = 8;
const TOOLTIP_GAP = 8; // gap between the box edge and the tooltip

const HOVER_DEBOUNCE_MS = 300;
// Grace period before actually hiding the tooltip once the mouse leaves a
// box's hit region. Without this, moving the cursor from the box toward
// the tooltip itself (to read more, or click the Wikipedia link) crosses
// a gap of "no hit" canvas space and the tooltip vanishes before you ever
// get there.
const HIDE_DELAY_MS = 250;

/**
 * Renders YOLO bounding boxes on a <canvas> positioned exactly over the
 * given <video> element, and shows an AI-generated species detail tooltip
 * on hover. Boxes are in the original frame's pixel space (from the
 * backend), so we scale them to the video's displayed size.
 *
 * `boxes` — species actually visible in the current frame. Solid outline.
 * `ghostBoxes` — species seen within the last few seconds but not
 * currently in frame (see useFrameDetection). Each carries a `videoTime`:
 * the exact video.currentTime they were last seen at. Drawn faint/dashed
 * at their last known position. Hovering a ghost box SEEKS the video back
 * to that timestamp (video.currentTime = ghost.videoTime) and pauses
 * there, bringing the species back into frame for as long as you hover —
 * this is a real rewind, not just a visual tooltip.
 *
 * Hovering either kind of box pauses the video so whatever's framed
 * doesn't swim off (or, for a ghost, immediately vanish again) while
 * you're reading the tooltip. Playback resumes once you actually stop
 * hovering both the box and the tooltip itself.
 */
export default function DetectionOverlay({ videoRef, boxes, ghostBoxes = [] }) {
  const canvasRef = useRef(null);
  const tooltipRef = useRef(null);
  const scaledBoxesRef = useRef([]); // last-drawn boxes (real + ghost) in canvas pixel space, for hit-testing
  const anchorRef = useRef({ x: 0, boxTop: 0, boxBottom: 0 });

  const [hoveredLabel, setHoveredLabel] = useState(null);
  const [hoveredIsGhost, setHoveredIsGhost] = useState(false);
  const [tooltipStyle, setTooltipStyle] = useState({ top: 0, left: 0, visibility: "hidden" });
  const [speciesData, setSpeciesData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState(null);

  const debounceRef = useRef(null);
  const hideTimeoutRef = useRef(null);
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

      function drawBox({ label, confidence, x1, y1, x2, y2 }, isGhost, videoTime) {
        const bx = x1 * scaleX;
        const by = y1 * scaleY;
        const bw = (x2 - x1) * scaleX;
        const bh = (y2 - y1) * scaleY;
        const lowConfidence = !isGhost && confidence < 0.75;

        // Ghost boxes ARE hit-testable now — hovering one seeks the video
        // back to the moment the species was last seen (see
        // handleMouseMove below). videoTime travels with the box so the
        // hover handler knows exactly where to seek to.
        scaledBoxes.push({ label, confidence, bx, by, bw, bh, ghost: isGhost, videoTime });

        ctx.strokeStyle = isGhost ? "#a48a55" : "#8fa3ad";
        ctx.lineWidth = isGhost ? 1.5 : 2;
        if (isGhost) {
          ctx.setLineDash([3, 5]);
          ctx.globalAlpha = 0.4;
        } else if (lowConfidence) {
          ctx.setLineDash([5, 4]);
          ctx.globalAlpha = 0.7;
        } else {
          ctx.setLineDash([]);
          ctx.globalAlpha = 1;
        }
        ctx.strokeRect(bx, by, bw, bh);
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;

        if (isGhost) {
          // Small "hover to rewind" chip only — no confidence/model tag,
          // since a ghost isn't a live reading.
          const labelText = `${label} — hover to rewind`;
          ctx.font = "10px monospace";
          const labelWidth = ctx.measureText(labelText).width;
          const blockWidth = labelWidth + 8;

          let blockTop = by - (LABEL_HEIGHT - 2);
          if (blockTop < TOP_BAR_HEIGHT) blockTop = by + bh + 2;

          let blockLeft = bx;
          blockLeft = Math.max(LEFT_PANEL_WIDTH + 4, blockLeft);
          blockLeft = Math.min(canvas.width - RIGHT_PANEL_WIDTH - blockWidth - 4, blockLeft);
          if (blockLeft < LEFT_PANEL_WIDTH + 4) {
            blockLeft = Math.max(4, Math.min(canvas.width - blockWidth - 4, bx));
          }

          ctx.globalAlpha = 0.55;
          ctx.fillStyle = "rgba(164, 138, 85, 0.85)";
          ctx.fillRect(blockLeft, blockTop, blockWidth, LABEL_HEIGHT - 2);
          ctx.fillStyle = "#241d10";
          ctx.fillText(labelText, blockLeft + 4, blockTop + 10);
          ctx.globalAlpha = 1;
          return;
        }

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
      }

      boxes.forEach((b) => drawBox(b, false, undefined));
      ghostBoxes.forEach((g) => drawBox(g, true, g.videoTime));

      scaledBoxesRef.current = scaledBoxes;
    }

    draw();
    const resizeObserver = new ResizeObserver(draw);
    resizeObserver.observe(video);

    return () => resizeObserver.disconnect();
  }, [videoRef, boxes, ghostBoxes]);

  // Safety net: if this component unmounts (e.g. switching to Bathymetry
  // Map view) while the video is paused for a hover, make sure it resumes
  // rather than silently staying frozen when you switch back.
  useEffect(() => {
    return () => {
      videoRef.current?.play().catch(() => {});
    };
  }, [videoRef]);

  // Recomputes the tooltip's actual on-screen position against its real
  // measured height (not a guess). Flips to below the box if there isn't
  // room above it to clear the top chrome bar, and clamps against the
  // bottom of the viewport too — long species descriptions can no longer
  // render partially off-screen in either direction.
  const positionTooltip = useCallback(() => {
    if (!tooltipRef.current) return;
    const { x, boxTop, boxBottom } = anchorRef.current;
    const height = tooltipRef.current.offsetHeight;

    let top = boxTop - height - TOOLTIP_GAP;
    if (top < TOP_BAR_HEIGHT) {
      top = boxBottom + TOOLTIP_GAP;
    }
    const maxTop = window.innerHeight - height - TOOLTIP_EDGE_PADDING;
    top = Math.min(top, maxTop);

    setTooltipStyle({ top, left: x, visibility: "visible" });
  }, []);

  // Re-measure whenever the tooltip's content shape changes (loading →
  // loaded → error all change its height), not just on first appearance.
  useLayoutEffect(() => {
    if (hoveredLabel) positionTooltip();
  }, [hoveredLabel, speciesData, loading, fetchError, positionTooltip]);

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

  const cancelHide = useCallback(() => {
    if (hideTimeoutRef.current) {
      clearTimeout(hideTimeoutRef.current);
      hideTimeoutRef.current = null;
    }
  }, []);

  const doHide = useCallback(() => {
    setHoveredLabel(null);
    setHoveredIsGhost(false);
    setSpeciesData(null);
    setFetchError(null);
    setTooltipStyle((s) => ({ ...s, visibility: "hidden" }));
    if (debounceRef.current) clearTimeout(debounceRef.current);
    // Resumes playback from wherever currentTime ended up — if the hover
    // was on a ghost box, that's the rewound timestamp, so the video
    // continues forward from the moment the species was last seen.
    videoRef.current?.play().catch(() => {});
  }, [videoRef]);

  const scheduleHide = useCallback(() => {
    cancelHide();
    hideTimeoutRef.current = setTimeout(doHide, HIDE_DELAY_MS);
  }, [cancelHide, doHide]);

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
        // Don't hide immediately — give the mouse a moment to reach the
        // tooltip itself (which sits above/below this box, outside the
        // hit region). The tooltip's own onMouseEnter cancels this if the
        // cursor actually lands on it.
        scheduleHide();
      }
      return;
    }

    // Still hovering a box — cancel any pending hide from a moment ago.
    cancelHide();

    // Clamp the tooltip's horizontal center so the 256px-wide box can
    // never render partially under the left/right chrome panels or off
    // the edge of the viewport, regardless of where the hovered box sits.
    let clampedX = hit.bx + hit.bw / 2;
    clampedX = Math.max(TOOLTIP_HALF_WIDTH + LEFT_PANEL_WIDTH + TOOLTIP_EDGE_PADDING, clampedX);
    clampedX = Math.min(
      rect.width - TOOLTIP_HALF_WIDTH - RIGHT_PANEL_WIDTH - TOOLTIP_EDGE_PADDING,
      clampedX
    );

    anchorRef.current = { x: clampedX, boxTop: hit.by, boxBottom: hit.by + hit.bh };
    positionTooltip();

    if (hit.label !== hoveredLabel) {
      console.debug("[DetectionOverlay] hovering box:", hit.label, "ghost:", !!hit.ghost);

      const video = videoRef.current;
      if (video) {
        // Pause on any hover — real or ghost — so the framed species
        // doesn't swim off (or, for a ghost, vanish again) while it's
        // being read.
        video.pause();
        if (hit.ghost && typeof hit.videoTime === "number") {
          // The actual rewind: jump back to the exact moment this
          // species was last seen, bringing it back into the box.
          video.currentTime = hit.videoTime;
        }
      }

      setHoveredLabel(hit.label);
      setHoveredIsGhost(!!hit.ghost);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => fetchSpeciesInfo(hit.label), HOVER_DEBOUNCE_MS);
    }
  }

  function handleCanvasMouseLeave() {
    if (hoveredLabel !== null) {
      // Same grace period as the no-hit case — the mouse may be headed
      // straight for the tooltip if it overlaps the canvas edge.
      scheduleHide();
    }
  }

  // The tooltip itself captures pointer events (see pointer-events change
  // below), so hovering it keeps the whole thing open — including enough
  // time to actually click "read more".
  function handleTooltipMouseEnter() {
    cancelHide();
  }

  function handleTooltipMouseLeave() {
    scheduleHide();
  }

  return (
    <div className="absolute inset-0 w-full h-full">
      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full"
        style={{ pointerEvents: "auto", cursor: hoveredLabel ? "help" : "default" }}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleCanvasMouseLeave}
      />

      {hoveredLabel && (
        <div
          ref={tooltipRef}
          onMouseEnter={handleTooltipMouseEnter}
          onMouseLeave={handleTooltipMouseLeave}
          className="absolute z-20 w-64 -translate-x-1/2 bg-[#1c2226] border border-[#3a444a] rounded-lg px-3 py-2.5 font-mono text-xs"
          style={{
            left: tooltipStyle.left,
            top: tooltipStyle.top,
            visibility: tooltipStyle.visibility,
          }}
        >
          <p className="text-[#d3dbe0] font-bold mb-1.5">{hoveredLabel}</p>

          {hoveredIsGhost && (
            <p className="text-[#a48a55] mb-1.5">⏪ Rewound to last sighting</p>
          )}

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
                      className="underline hover:text-[#8fa3ad]"
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