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

// A little padding around the cropped capture so the species isn't cut
// off flush against the bounding box edge — detection boxes are often a
// touch tight against the actual animal.
const CAPTURE_PADDING_PX = 8;

// At or above this confidence, a box gets the "locked on" corner-bracket
// treatment instead of a plain rectangle — a visual cue, not a claim of
// validation. The "unvalidated model" disclaimer stays regardless of
// confidence; a confident guess from an unvalidated model is still an
// unvalidated guess, just a more visually confident-looking one.
const LOCK_ON_THRESHOLD = 0.9;
const LOCK_ON_BRACKET_LEN = 16;

// IUCN Red List category codes -> readable label + color. Red/orange for
// genuinely threatened categories, neutral for everything else — this is
// the one place in the modal where color carries real informational
// weight (endangered vs. not), so it's worth getting the mapping right
// rather than treating it as just another gray text field.
const IUCN_STATUS_LABELS = {
  EX: "Extinct",
  EW: "Extinct in the Wild",
  CR: "Critically Endangered",
  EN: "Endangered",
  VU: "Vulnerable",
  NT: "Near Threatened",
  LC: "Least Concern",
  DD: "Data Deficient",
  NE: "Not Evaluated",
};
const IUCN_STATUS_COLORS = {
  EX: "text-[#c47a6e] font-bold",
  EW: "text-[#c47a6e] font-bold",
  CR: "text-[#c47a6e] font-bold",
  EN: "text-[#d8a877]",
  VU: "text-[#d8b877]",
  NT: "text-[#b7c4cc]",
  LC: "text-[#7de88f]",
  DD: "text-[#5a6a72]",
  NE: "text-[#5a6a72]",
};

/**
 * Renders YOLO bounding boxes on a <canvas> positioned exactly over the
 * given <video> element. Boxes are in the original frame's pixel space
 * (from the backend), so we scale them to the video's displayed size.
 *
 * `boxes` — species actually visible in the current frame. Solid outline.
 * `ghostBoxes` — species seen within the last few seconds but not
 * currently in frame (see useFrameDetection). Each carries a `videoTime`:
 * the exact video.currentTime they were last seen at.
 *
 * Interaction model: hovering a box only changes the cursor (a lightweight
 * affordance) — nothing pauses or opens on hover alone. CLICKING a box
 * pauses the video (and, for a ghost, seeks back to videoTime first) and
 * opens a persistent "Species Inspector" modal: a cropped live capture of
 * just that animal, its name, basic taxonomic info, a research diagram
 * (from Wikipedia, once species_info.py returns one), and real related
 * research papers (OpenAlex). The modal stays open until closed — no
 * hover-tracking needed, since it isn't chasing the cursor around.
 */
export default function DetectionOverlay({ videoRef, boxes, ghostBoxes = [], onViewDistribution }) {
  const canvasRef = useRef(null);
  const captureCanvasRef = useRef(null); // offscreen, used only for cropping — never rendered directly
  const scaledBoxesRef = useRef([]); // last-drawn boxes (real + ghost) in canvas pixel space, for hit-testing

  const [isHoveringBox, setIsHoveringBox] = useState(false); // cursor affordance only
  const [selectedBox, setSelectedBox] = useState(null); // { label, ghost, videoTime } | null
  const [imageTab, setImageTab] = useState("photos"); // "photos" | "diagrams"
  const [activeImageIndex, setActiveImageIndex] = useState(0);
  const [captureDataUrl, setCaptureDataUrl] = useState(null);
  const [speciesData, setSpeciesData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState(null);

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

      /** Draws four bright L-shaped corner brackets around a box —
       * classic target-lock HUD styling — instead of (or on top of) a
       * plain rectangle. Used only for high-confidence detections; the
       * "unvalidated model" disclaimer still applies regardless, this is
       * purely a visual emphasis cue, not a claim of verification. */
      function drawLockOnBrackets(ctx, bx, by, bw, bh) {
        const len = Math.min(LOCK_ON_BRACKET_LEN, bw / 3, bh / 3);
        ctx.save();
        ctx.strokeStyle = "#7de88f";
        ctx.lineWidth = 2.5;
        ctx.globalAlpha = 1;
        ctx.setLineDash([]);

        const corners = [
          // [cornerX, cornerY, horizontalDir, verticalDir]
          [bx, by, 1, 1],
          [bx + bw, by, -1, 1],
          [bx, by + bh, 1, -1],
          [bx + bw, by + bh, -1, -1],
        ];
        for (const [cx, cy, hDir, vDir] of corners) {
          ctx.beginPath();
          ctx.moveTo(cx + len * hDir, cy);
          ctx.lineTo(cx, cy);
          ctx.lineTo(cx, cy + len * vDir);
          ctx.stroke();
        }
        ctx.restore();
      }

      function drawBox({ label, confidence, x1, y1, x2, y2 }, isGhost, videoTime) {
        const bx = x1 * scaleX;
        const by = y1 * scaleY;
        const bw = (x2 - x1) * scaleX;
        const bh = (y2 - y1) * scaleY;
        const lowConfidence = !isGhost && confidence < 0.75;
        const isLockedOn = !isGhost && confidence >= LOCK_ON_THRESHOLD;

        // Original (unscaled) frame-pixel coordinates travel with the box
        // too — the crop capture draws from the video's native resolution,
        // not the displayed CSS size.
        scaledBoxes.push({
          label, confidence, bx, by, bw, bh,
          ghost: isGhost, videoTime,
          origX1: x1, origY1: y1, origX2: x2, origY2: y2,
        });

        ctx.strokeStyle = isGhost ? "#a48a55" : "#8fa3ad";
        ctx.lineWidth = isGhost ? 1.5 : 2;
        if (isGhost) {
          ctx.setLineDash([3, 5]);
          ctx.globalAlpha = 0.4;
        } else if (lowConfidence) {
          ctx.setLineDash([5, 4]);
          ctx.globalAlpha = 0.7;
        } else if (isLockedOn) {
          // Dim the plain rectangle when locked on — the bright corner
          // brackets drawn below carry the emphasis instead, same visual
          // language as a camera/FPS target lock.
          ctx.setLineDash([]);
          ctx.globalAlpha = 0.35;
        } else {
          ctx.setLineDash([]);
          ctx.globalAlpha = 1;
        }
        ctx.strokeRect(bx, by, bw, bh);
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;

        if (isLockedOn) {
          drawLockOnBrackets(ctx, bx, by, bw, bh);
        }

        if (isGhost) {
          const labelText = `${label} — click to rewind`;
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

        const labelText = isLockedOn
          ? `LOCKED: ${label} ${(confidence * 100).toFixed(0)}%`
          : `${label} ${(confidence * 100).toFixed(0)}%`;
        const tagText = "unvalidated model — click to inspect";
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
  // Map view) while the video is paused for an open modal, make sure it
  // resumes rather than silently staying frozen when you switch back.
  useEffect(() => {
    return () => {
      videoRef.current?.play().catch(() => {});
    };
  }, [videoRef]);

  // Close the modal on Escape, same as clicking the backdrop or the ✕.
  useEffect(() => {
    if (!selectedBox) return;
    function onKeyDown(e) {
      if (e.key === "Escape") closeModal();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedBox]);

  function hitTest(clientX, clientY) {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const mx = clientX - rect.left;
    const my = clientY - rect.top;

    // A few px of forgiveness around each box — detection boxes are often
    // a little offset from the actual animal, so requiring an exact
    // pixel-perfect click makes the feature feel broken even when it's
    // working.
    const HIT_PADDING = 6;
    return scaledBoxesRef.current.find(
      (b) =>
        mx >= b.bx - HIT_PADDING &&
        mx <= b.bx + b.bw + HIT_PADDING &&
        my >= b.by - HIT_PADDING &&
        my <= b.by + b.bh + HIT_PADDING
    );
  }

  function handleMouseMove(e) {
    // Cursor affordance only — no pausing, no fetching, no modal here.
    const hit = hitTest(e.clientX, e.clientY);
    setIsHoveringBox(!!hit);
  }

  // Crops just the clicked box's region out of the video's CURRENT frame,
  // at native video resolution (not the scaled-down display size).
  const captureCrop = useCallback((hit) => {
    const video = videoRef.current;
    if (!video || !video.videoWidth || !video.videoHeight) return;

    if (!captureCanvasRef.current) {
      captureCanvasRef.current = document.createElement("canvas");
    }
    const cropCanvas = captureCanvasRef.current;

    const x1 = Math.max(0, hit.origX1 - CAPTURE_PADDING_PX);
    const y1 = Math.max(0, hit.origY1 - CAPTURE_PADDING_PX);
    const x2 = Math.min(video.videoWidth, hit.origX2 + CAPTURE_PADDING_PX);
    const y2 = Math.min(video.videoHeight, hit.origY2 + CAPTURE_PADDING_PX);
    const w = Math.max(1, x2 - x1);
    const h = Math.max(1, y2 - y1);

    cropCanvas.width = w;
    cropCanvas.height = h;
    const ctx = cropCanvas.getContext("2d");
    ctx.drawImage(video, x1, y1, w, h, 0, 0, w, h);

    try {
      setCaptureDataUrl(cropCanvas.toDataURL("image/jpeg", 0.85));
    } catch (err) {
      // Tainted-canvas security error if the video source isn't
      // same-origin/CORS-cleared — fails silently, modal just won't show
      // a thumbnail for that source rather than crashing.
      console.error("[DetectionOverlay] capture crop failed:", err);
      setCaptureDataUrl(null);
    }
  }, [videoRef]);

  const fetchSpeciesInfo = useCallback((label) => {
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setFetchError(null);
    setSpeciesData(null);

    fetch(`${API_BASE_URL}/species-info?name=${encodeURIComponent(label)}`, {
      signal: controller.signal,
    })
      .then((res) => {
        if (!res.ok) throw new Error(`Lookup failed: ${res.status}`);
        return res.json();
      })
      .then((data) => setSpeciesData(data))
      .catch((err) => {
        if (err.name !== "AbortError") {
          console.error("Species info lookup failed:", err);
          setFetchError("Couldn't load species info");
        }
      })
      .finally(() => setLoading(false));
  }, []);

  function handleClick(e) {
    const hit = hitTest(e.clientX, e.clientY);
    if (!hit) return;

    const video = videoRef.current;
    setCaptureDataUrl(null);
    setImageTab("photos");
    setActiveImageIndex(0);
    setSelectedBox({
      label: hit.label,
      ghost: !!hit.ghost,
      videoTime: hit.videoTime,
    });
    fetchSpeciesInfo(hit.label);

    if (video) {
      video.pause();
      if (hit.ghost && typeof hit.videoTime === "number") {
        // The actual rewind: jump back to the exact moment this species
        // was last seen. Capture only AFTER the seek truly lands (the
        // 'seeked' event) — grabbing the frame immediately after setting
        // currentTime can catch the video mid-seek.
        const onSeeked = () => {
          video.removeEventListener("seeked", onSeeked);
          captureCrop(hit);
        };
        video.addEventListener("seeked", onSeeked);
        video.currentTime = hit.videoTime;
      } else {
        captureCrop(hit);
      }
    }
  }

  function closeModal() {
    setSelectedBox(null);
    setCaptureDataUrl(null);
    setSpeciesData(null);
    setFetchError(null);
    setImageTab("photos");
    setActiveImageIndex(0);
    if (abortRef.current) abortRef.current.abort();
    videoRef.current?.play().catch(() => {});
  }

  return (
    <div className="absolute inset-0 w-full h-full">
      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full"
        style={{ pointerEvents: "auto", cursor: isHoveringBox ? "pointer" : "default" }}
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setIsHoveringBox(false)}
        onClick={handleClick}
      />

      {selectedBox && (
        <div
          className="absolute inset-0 z-30 bg-black/70 pointer-events-auto flex items-center justify-center"
          onClick={closeModal}
        >
          <style>{`
            .species-inspector-scroll::-webkit-scrollbar { width: 8px; }
            .species-inspector-scroll::-webkit-scrollbar-track { background: #171d20; }
            .species-inspector-scroll::-webkit-scrollbar-thumb {
              background: #3a444a;
              border-radius: 4px;
            }
            .species-inspector-scroll::-webkit-scrollbar-thumb:hover { background: #5a6a72; }
            .species-inspector-scroll { scrollbar-width: thin; scrollbar-color: #3a444a #171d20; }
          `}</style>
          <div
            className="species-inspector-scroll w-full max-w-sm max-h-[80vh] overflow-y-auto bg-[#1c2226] border border-[#3a444a] rounded-xl font-mono text-xs"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-[#3a444a] sticky top-0 bg-[#1c2226]">
              <span className="text-[10px] uppercase tracking-widest text-[#8fa3ad]">
                Species inspector
              </span>
              <button
                onClick={closeModal}
                className="text-[#8fa3ad] hover:text-[#d3dbe0] text-sm leading-none"
              >
                ✕
              </button>
            </div>

            <div className="p-4 space-y-3">
              {captureDataUrl && (
                <img
                  src={captureDataUrl}
                  alt={`Captured frame of ${selectedBox.label}`}
                  className="w-full h-40 object-cover rounded-md border border-[#3a444a]"
                />
              )}

              <div>
                <p className="text-[#d3dbe0] font-bold text-sm">{selectedBox.label}</p>
                {selectedBox.ghost && (
                  <p className="text-[#a48a55] mt-0.5">Rewound to last sighting</p>
                )}
              </div>

              {loading && <p className="text-[#5a6a72]">Looking up species info…</p>}
              {fetchError && <p className="text-[#c47a6e]">{fetchError}</p>}

              {speciesData && !speciesData.error && (
                <>
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
                    {speciesData.conservation_status && (
                      <p>
                        <span className="text-[#8fa3ad]">Conservation status:</span>{" "}
                        <span className={IUCN_STATUS_COLORS[speciesData.conservation_status] || "text-[#b7c4cc]"}>
                          {IUCN_STATUS_LABELS[speciesData.conservation_status] || speciesData.conservation_status}
                        </span>
                        <span className="text-[#5a6a72]"> (IUCN Red List)</span>
                      </p>
                    )}
                    {speciesData.summary && <p className="pt-1">{speciesData.summary}</p>}
                  </div>

                  {onViewDistribution && speciesData.scientific_name && (
                    <button
                      onClick={() => {
                        onViewDistribution(speciesData.scientific_name);
                        closeModal();
                      }}
                      className="w-full bg-[#8fa3ad]/10 border border-[#5a6a72] rounded-lg px-3 py-2 text-[10px] uppercase tracking-widest text-[#b7c4cc] hover:bg-[#8fa3ad]/20"
                    >
                      View distribution on bathymetry map
                    </button>
                  )}

                  {/* Anatomical/Internal (Category 3) — a real link to
                      MorphoSource's own search, not an in-app gallery.
                      MorphoSource's public API couldn't be verified from
                      this environment (see morphosource_client.py), so
                      this links out rather than pretending to embed CT
                      scans we haven't confirmed exist or load correctly.
                      Coverage is genuinely thin for coral/invertebrates —
                      MorphoSource grew out of a vertebrate-focused
                      project — the link still works, it may just come
                      back empty for those species. */}
                  {speciesData.anatomical_search_url && (
                    <a
                      href={speciesData.anatomical_search_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block w-full text-center bg-white/[0.04] border border-[#3a444a] rounded-lg px-3 py-2 text-[10px] uppercase tracking-widest text-[#b7c4cc] hover:bg-white/[0.08]"
                    >
                      Search MorphoSource for CT/anatomical scans ↗
                    </a>
                  )}

                  {/* Photos / Diagrams tabs — real multi-source galleries
                      (Wikipedia + iNaturalist for photos, Wikipedia's SVG
                      technical images for diagrams) instead of a single
                      possibly-unrepresentative generic image. Only tabs
                      with actual content are shown. */}
                  {(speciesData.photos?.length > 0 || speciesData.diagrams?.length > 0) && (
                    <div className="pt-1.5 border-t border-[#3a444a]">
                      <div className="flex gap-1 mb-2">
                        {speciesData.photos?.length > 0 && (
                          <button
                            onClick={() => {
                              setImageTab("photos");
                              setActiveImageIndex(0);
                            }}
                            className={`px-2.5 py-1 rounded text-[10px] uppercase tracking-widest border ${
                              imageTab === "photos"
                                ? "bg-[#8fa3ad]/20 border-[#8fa3ad]/60 text-[#d3dbe0]"
                                : "bg-white/[0.04] border-[#3a444a] text-[#8fa3ad] hover:bg-white/[0.08]"
                            }`}
                          >
                            Photos ({speciesData.photos.length})
                          </button>
                        )}
                        {speciesData.diagrams?.length > 0 && (
                          <button
                            onClick={() => {
                              setImageTab("diagrams");
                              setActiveImageIndex(0);
                            }}
                            className={`px-2.5 py-1 rounded text-[10px] uppercase tracking-widest border ${
                              imageTab === "diagrams"
                                ? "bg-[#8fa3ad]/20 border-[#8fa3ad]/60 text-[#d3dbe0]"
                                : "bg-white/[0.04] border-[#3a444a] text-[#8fa3ad] hover:bg-white/[0.08]"
                            }`}
                          >
                            Diagrams ({speciesData.diagrams.length})
                          </button>
                        )}
                      </div>

                      {(() => {
                        const gallery = imageTab === "diagrams" ? speciesData.diagrams : speciesData.photos;
                        if (!gallery?.length) return null;
                        const active = gallery[Math.min(activeImageIndex, gallery.length - 1)];
                        return (
                          <>
                            <img
                              src={active.url}
                              alt={`${imageTab === "diagrams" ? "Diagram" : "Photo"} of ${speciesData.scientific_name || selectedBox.label}`}
                              className={`w-full rounded-md border border-[#3a444a] ${
                                imageTab === "diagrams"
                                  ? "max-h-48 object-contain bg-[#0c1113]"
                                  : "h-40 object-cover"
                              }`}
                            />
                            <p className="text-[#5a6a72] mt-1">{active.attribution}</p>

                            {gallery.length > 1 && (
                              <div className="flex gap-1.5 mt-2 overflow-x-auto pb-1">
                                {gallery.map((img, i) => (
                                  <button
                                    key={i}
                                    onClick={() => setActiveImageIndex(i)}
                                    className={`shrink-0 w-12 h-12 rounded overflow-hidden border-2 ${
                                      i === activeImageIndex ? "border-[#8fa3ad]" : "border-transparent opacity-60 hover:opacity-100"
                                    }`}
                                  >
                                    <img src={img.url} alt="" className="w-full h-full object-cover" />
                                  </button>
                                ))}
                              </div>
                            )}
                          </>
                        );
                      })()}
                    </div>
                  )}

                  {/* Histological/Cellular (Category 4) and Ultrastructural
                      (Category 5) — real Europe PMC open-access literature
                      whose title/abstract match the imaging modality, NOT
                      extracted figure images (see europepmc_client.py for
                      why that distinction matters). Only shown when
                      something actually matched — most species will have
                      nothing here, and that's the honest result, not a
                      bug. */}
                  {speciesData.histological_literature?.length > 0 && (
                    <div className="pt-1.5 border-t border-[#3a444a]">
                      <p className="text-[10px] uppercase tracking-widest text-[#8fa3ad] mb-1.5">
                        Histological literature
                      </p>
                      <p className="text-[#5a6a72] mb-1.5">
                        Open-access papers likely containing tissue/cellular imagery — view the actual figures on the paper itself.
                      </p>
                      <ul className="space-y-2">
                        {speciesData.histological_literature.map((paper, i) => (
                          <li key={i}>
                            <a
                              href={paper.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-[#b7c4cc] hover:text-[#d3dbe0] underline"
                            >
                              {paper.title}
                            </a>
                            <p className="text-[#5a6a72]">
                              {[paper.authors, paper.journal, paper.year].filter(Boolean).join(" · ")}
                            </p>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {speciesData.ultrastructural_literature?.length > 0 && (
                    <div className="pt-1.5 border-t border-[#3a444a]">
                      <p className="text-[10px] uppercase tracking-widest text-[#8fa3ad] mb-1.5">
                        Ultrastructural literature (SEM/TEM)
                      </p>
                      <p className="text-[#5a6a72] mb-1.5">
                        Open-access papers likely containing electron-microscopy imagery — view the actual figures on the paper itself.
                      </p>
                      <ul className="space-y-2">
                        {speciesData.ultrastructural_literature.map((paper, i) => (
                          <li key={i}>
                            <a
                              href={paper.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-[#b7c4cc] hover:text-[#d3dbe0] underline"
                            >
                              {paper.title}
                            </a>
                            <p className="text-[#5a6a72]">
                              {[paper.authors, paper.journal, paper.year].filter(Boolean).join(" · ")}
                            </p>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {/* Research papers — real OpenAlex results from
                      species_info.py, not a placeholder search link. */}
                  <div className="pt-1.5 border-t border-[#3a444a]">
                    <p className="text-[10px] uppercase tracking-widest text-[#8fa3ad] mb-1.5">
                      Research papers
                    </p>
                    {speciesData.research_papers?.length > 0 ? (
                      <ul className="space-y-2">
                        {speciesData.research_papers.map((paper, i) => (
                          <li key={i}>
                            <a
                              href={paper.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-[#b7c4cc] hover:text-[#d3dbe0] underline"
                            >
                              {paper.title}
                            </a>
                            <p className="text-[#5a6a72]">
                              {[paper.authors, paper.year].filter(Boolean).join(" · ")}
                            </p>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-[#5a6a72]">No related papers found.</p>
                    )}
                  </div>

                  {speciesData.wikipedia_url && (
                    <p className="text-[#5a6a72] pt-1.5 border-t border-[#3a444a]">
                      Source: Wikipedia &amp; OBIS ·{" "}
                      <a
                        href={speciesData.wikipedia_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="underline hover:text-[#8fa3ad]"
                      >
                        read more
                      </a>
                    </p>
                  )}
                </>
              )}

              {speciesData?.error && <p className="text-[#c47a6e]">{speciesData.error}</p>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}