"use client";

import { useEffect, useRef, useState } from "react";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:5050";

const TOOLS = [
  { id: "pen", label: "Pen" },
  { id: "highlighter", label: "Highlight" },
  { id: "arrow", label: "Arrow" },
  { id: "rect", label: "Box" },
  { id: "text", label: "Text" },
  { id: "eraser", label: "Eraser" },
  { id: "crop", label: "Crop" },
];

const SWATCHES = ["#d3dbe0", "#8fa3ad", "#c47a6e", "#d8b877", "#6ec49a", "#e0e0e0", "#111111"];

const ERASER_RADIUS = 16;
const ZOOM_STEP = 0.25;
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3;

function getCanvasPoint(canvas, clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  return { x: (clientX - rect.left) * scaleX, y: (clientY - rect.top) * scaleY };
}

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function distToSegment(p, a, b) {
  const l2 = (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
  if (l2 === 0) return dist(p, a);
  let t = ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / l2;
  t = Math.max(0, Math.min(1, t));
  return dist(p, { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) });
}

// Rough hit-test used only by the eraser — doesn't need to be pixel
// perfect, just close enough that dragging over a mark removes it.
function strokeNear(stroke, point, radius) {
  if (!stroke) return false;
  if (stroke.type === "pen" || stroke.type === "highlighter") {
    return (stroke.points || []).some((p) => dist(p, point) < radius);
  }
  if (stroke.type === "arrow") {
    if (!stroke.start || !stroke.end) return false;
    return distToSegment(point, stroke.start, stroke.end) < radius;
  }
  if (stroke.type === "rect") {
    if (!stroke.start || !stroke.end) return false;
    const { start, end } = stroke;
    const corners = [
      { x: start.x, y: start.y },
      { x: end.x, y: start.y },
      { x: end.x, y: end.y },
      { x: start.x, y: end.y },
    ];
    for (let i = 0; i < 4; i++) {
      if (distToSegment(point, corners[i], corners[(i + 1) % 4]) < radius) return true;
    }
    return false;
  }
  if (stroke.type === "text") {
    return stroke.start ? dist(stroke.start, point) < radius + 30 : false;
  }
  return false;
}

function drawArrowhead(ctx, from, to, color, headLength) {
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  ctx.beginPath();
  ctx.moveTo(to.x, to.y);
  ctx.lineTo(
    to.x - headLength * Math.cos(angle - Math.PI / 6),
    to.y - headLength * Math.sin(angle - Math.PI / 6)
  );
  ctx.lineTo(
    to.x - headLength * Math.cos(angle + Math.PI / 6),
    to.y - headLength * Math.sin(angle + Math.PI / 6)
  );
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

function drawStroke(ctx, stroke) {
  if (!stroke || !stroke.type) return;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  if (stroke.type === "pen") {
    if (stroke.points.length < 2) return;
    ctx.strokeStyle = stroke.color;
    ctx.lineWidth = stroke.width;
    ctx.beginPath();
    ctx.moveTo(stroke.points[0].x, stroke.points[0].y);
    for (const p of stroke.points.slice(1)) ctx.lineTo(p.x, p.y);
    ctx.stroke();
  } else if (stroke.type === "highlighter") {
    if (stroke.points.length < 2) return;
    ctx.save();
    ctx.globalAlpha = 0.35;
    ctx.strokeStyle = stroke.color;
    ctx.lineWidth = Math.max(stroke.width * 4, 14);
    ctx.beginPath();
    ctx.moveTo(stroke.points[0].x, stroke.points[0].y);
    for (const p of stroke.points.slice(1)) ctx.lineTo(p.x, p.y);
    ctx.stroke();
    ctx.restore();
  } else if (stroke.type === "arrow") {
    ctx.strokeStyle = stroke.color;
    ctx.fillStyle = stroke.color;
    ctx.lineWidth = stroke.width;
    const headLength = Math.max(14, stroke.width * 4.5);
    const angle = Math.atan2(stroke.end.y - stroke.start.y, stroke.end.x - stroke.start.x);
    // Pull the shaft back slightly so it doesn't poke out past the
    // triangle's back edge — makes the arrowhead read as one solid shape.
    const shaftEnd = {
      x: stroke.end.x - Math.cos(angle) * headLength * 0.5,
      y: stroke.end.y - Math.sin(angle) * headLength * 0.5,
    };
    ctx.beginPath();
    ctx.moveTo(stroke.start.x, stroke.start.y);
    ctx.lineTo(shaftEnd.x, shaftEnd.y);
    ctx.stroke();
    drawArrowhead(ctx, stroke.start, stroke.end, stroke.color, headLength);
  } else if (stroke.type === "rect") {
    ctx.strokeStyle = stroke.color;
    ctx.lineWidth = stroke.width;
    const x = Math.min(stroke.start.x, stroke.end.x);
    const y = Math.min(stroke.start.y, stroke.end.y);
    const w = Math.abs(stroke.end.x - stroke.start.x);
    const h = Math.abs(stroke.end.y - stroke.start.y);
    ctx.strokeRect(x, y, w, h);
  } else if (stroke.type === "text") {
    ctx.fillStyle = stroke.color;
    ctx.font = `${Math.max(16, stroke.width * 6)}px monospace`;
    ctx.textBaseline = "top";
    ctx.fillText(stroke.text, stroke.start.x, stroke.start.y);
  }
}

function drawCropMarquee(ctx, sel, canvasW, canvasH) {
  const x = Math.min(sel.start.x, sel.end.x);
  const y = Math.min(sel.start.y, sel.end.y);
  const w = Math.abs(sel.end.x - sel.start.x);
  const h = Math.abs(sel.end.y - sel.start.y);

  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.fillRect(0, 0, canvasW, y); // top
  ctx.fillRect(0, y + h, canvasW, canvasH - (y + h)); // bottom
  ctx.fillRect(0, y, x, h); // left
  ctx.fillRect(x + w, y, canvasW - (x + w), h); // right
  ctx.restore();

  ctx.strokeStyle = "#8fa3ad";
  ctx.setLineDash([6, 4]);
  ctx.lineWidth = 2;
  ctx.strokeRect(x, y, w, h);
  ctx.setLineDash([]);
}

/**
 * A screenshot-tool-style annotation editor for Discovery Snapshots.
 *
 * mode="new"  — imageSrc is a freshly captured data URL, not saved yet.
 * mode="view" — imageSrc is an existing saved snapshot's Cloudinary URL.
 *               Re-annotating and saving creates a NEW snapshot entry
 *               (the original stays intact).
 *
 * Everything here is in-page (inline text editing, inline delete
 * confirmation) — no window.prompt/confirm browser dialogs.
 */
export default function SnapshotAnnotator({
  open,
  mode = "new",
  imageSrc,
  telemetry = {},
  speciesQuery = "",
  ownerEmail = "",
  existingSnapshotId = null,
  onClose,
  onSaved,
  onDeleted,
}) {
  const canvasRef = useRef(null);
  const imageRef = useRef(null);
  const [imageLoaded, setImageLoaded] = useState(false);

  const [strokes, setStrokes] = useState([]);
  const [history, setHistory] = useState([]); // past strokes-array snapshots, for Undo
  const [future, setFuture] = useState([]); // undone snapshots, for Redo
  const [tool, setTool] = useState("pen");
  const [color, setColor] = useState(SWATCHES[0]);
  const [width, setWidth] = useState(3);
  const drawingRef = useRef(null); // in-progress stroke, not yet committed

  const [cropSelection, setCropSelection] = useState(null); // { start, end } | null

  const [zoomFactor, setZoomFactor] = useState(1);
  const [manualZoom, setManualZoom] = useState(false);
  const fitWidthRef = useRef(null);

  // Inline text editor overlay — position is in canvas-pixel space,
  // rendered via percentage offsets so it stays aligned as the canvas
  // scales with the viewport.
  const [textEditor, setTextEditor] = useState(null); // { x, y, value } | null

  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [message, setMessage] = useState(null);

  useEffect(() => {
    if (!open || !imageSrc) return;
    setImageLoaded(false);
    setStrokes([]);
    setHistory([]);
    setFuture([]);
    setCropSelection(null);
    setManualZoom(false);
    setZoomFactor(1);
    setMessage(null);
    setConfirmingDelete(false);
    setTextEditor(null);
    setTool("pen");

    const img = new Image();
    if (imageSrc.startsWith("http")) img.crossOrigin = "anonymous";
    img.onload = () => {
      imageRef.current = img;
      const canvas = canvasRef.current;
      if (canvas) {
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
      }
      setImageLoaded(true);
    };
    img.onerror = () => setMessage({ type: "error", text: "Couldn't load that image" });
    img.src = imageSrc;
  }, [open, imageSrc]);

  // Measure the "fit to container" width once the image first lays out,
  // so Zoom In/Out has a sensible 100% baseline to scale from.
  useEffect(() => {
    if (!imageLoaded) return;
    const raf = requestAnimationFrame(() => {
      if (canvasRef.current) {
        fitWidthRef.current = canvasRef.current.getBoundingClientRect().width;
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [imageLoaded]);

  function redraw(previewStroke) {
    const canvas = canvasRef.current;
    const img = imageRef.current;
    if (!canvas || !img) return;
    try {
      const ctx = canvas.getContext("2d");
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      for (const s of strokes) {
        if (s) drawStroke(ctx, s);
      }

      if (previewStroke) {
        if (previewStroke.type === "crop") {
          drawCropMarquee(ctx, previewStroke, canvas.width, canvas.height);
        } else {
          drawStroke(ctx, previewStroke);
        }
      } else if (cropSelection) {
        drawCropMarquee(ctx, cropSelection, canvas.width, canvas.height);
      }
    } catch (err) {
      // Never let a canvas-drawing error take down the whole page — log
      // it with full context so the real cause is visible next time, and
      // just skip this frame instead of crashing.
      console.error("SnapshotAnnotator redraw failed:", err, {
        previewStroke,
        strokeCount: strokes.length,
        cropSelection,
      });
    }
  }

  useEffect(() => {
    if (imageLoaded) redraw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageLoaded, strokes, cropSelection]);

  function pushHistory(snapshot) {
    setHistory((h) => [...h, snapshot]);
    setFuture([]);
  }

  function commitTextEditor() {
    setTextEditor((current) => {
      if (current && current.value.trim()) {
        pushHistory(strokes);
        setStrokes((prev) => [
          ...prev,
          {
            type: "text",
            start: { x: current.x, y: current.y },
            text: current.value.trim(),
            color,
            width,
          },
        ]);
      }
      return null;
    });
  }

  function handlePointerDown(e) {
    if (!imageLoaded) return;
    try {
      // A click elsewhere while the text box is open commits it first.
      if (textEditor) {
        commitTextEditor();
        return;
      }

      const canvas = canvasRef.current;
      const point = getCanvasPoint(canvas, e.clientX, e.clientY);

      if (tool === "text") {
        setTextEditor({ x: point.x, y: point.y, value: "" });
        return;
      }

      if (tool === "eraser") {
        pushHistory(strokes); // one history step per erase-drag, not per pixel
        setStrokes((prev) => prev.filter((s) => !strokeNear(s, point, ERASER_RADIUS)));
        drawingRef.current = { type: "eraser" };
        return;
      }

      canvas.setPointerCapture?.(e.pointerId);

      if (tool === "crop") {
        drawingRef.current = { type: "crop", start: point, end: point };
      } else if (tool === "pen" || tool === "highlighter") {
        drawingRef.current = { type: tool, points: [point], color, width };
      } else {
        drawingRef.current = { type: tool, start: point, end: point, color, width };
      }
    } catch (err) {
      console.error("SnapshotAnnotator pointer-down failed:", err, { tool });
      drawingRef.current = null;
    }
  }

  function handlePointerMove(e) {
    if (!drawingRef.current) return;
    try {
      const canvas = canvasRef.current;
      const point = getCanvasPoint(canvas, e.clientX, e.clientY);

      if (drawingRef.current.type === "eraser") {
        setStrokes((prev) => prev.filter((s) => !strokeNear(s, point, ERASER_RADIUS)));
        return;
      }
      if (drawingRef.current.type === "pen" || drawingRef.current.type === "highlighter") {
        drawingRef.current.points.push(point);
      } else {
        drawingRef.current.end = point;
      }
      redraw(drawingRef.current);
    } catch (err) {
      // Confirmed crash site in a prior session — log full context so the
      // real cause is visible if it recurs, and abandon this stroke
      // cleanly instead of letting it take down the whole page.
      console.error("SnapshotAnnotator pointer-move failed:", err, {
        tool,
        drawing: drawingRef.current,
      });
      drawingRef.current = null;
    }
  }

  function handlePointerUp() {
    if (!drawingRef.current) return;
    try {
      if (drawingRef.current.type === "crop") {
        const { start, end } = drawingRef.current;
        if (Math.abs(end.x - start.x) > 4 && Math.abs(end.y - start.y) > 4) {
          setCropSelection({ start, end });
        }
        return;
      }

      if (drawingRef.current.type !== "eraser") {
        pushHistory(strokes);
        setStrokes((prev) => [...prev, drawingRef.current]);
      }
    } catch (err) {
      console.error("SnapshotAnnotator pointer-up failed:", err, { drawing: drawingRef.current });
    } finally {
      drawingRef.current = null;
    }
  }

  function handleUndo() {
    if (history.length === 0) return;
    setFuture((f) => [...f, strokes]);
    const prevSnapshot = history[history.length - 1];
    setHistory((h) => h.slice(0, -1));
    setStrokes(prevSnapshot);
  }

  function handleRedo() {
    if (future.length === 0) return;
    setHistory((h) => [...h, strokes]);
    const nextSnapshot = future[future.length - 1];
    setFuture((f) => f.slice(0, -1));
    setStrokes(nextSnapshot);
  }

  function handleClearAnnotations() {
    if (strokes.length === 0) return;
    pushHistory(strokes);
    setStrokes([]);
  }

  function selectTool(id) {
    if (textEditor) commitTextEditor();
    if (id !== "crop" && cropSelection) setCropSelection(null);
    setTool(id);
  }

  function handleApplyCrop() {
    if (!cropSelection) return;
    const canvas = canvasRef.current;
    const x = Math.max(0, Math.min(cropSelection.start.x, cropSelection.end.x));
    const y = Math.max(0, Math.min(cropSelection.start.y, cropSelection.end.y));
    const w = Math.min(canvas.width - x, Math.abs(cropSelection.end.x - cropSelection.start.x));
    const h = Math.min(canvas.height - y, Math.abs(cropSelection.end.y - cropSelection.start.y));
    if (w < 4 || h < 4) {
      setCropSelection(null);
      return;
    }

    // Crop bakes in whatever's currently drawn (image + annotations) into
    // a new base image, same as most screenshot tools — you can keep
    // annotating on top of the cropped result, but the crop itself can't
    // be undone once applied.
    const off = document.createElement("canvas");
    off.width = w;
    off.height = h;
    off.getContext("2d").drawImage(canvas, x, y, w, h, 0, 0, w, h);

    const newImg = new Image();
    newImg.onload = () => {
      imageRef.current = newImg;
      canvas.width = w;
      canvas.height = h;
      setStrokes([]);
      setHistory([]);
      setFuture([]);
      setCropSelection(null);
      setManualZoom(false);
      setZoomFactor(1);
      setTool("pen");
    };
    newImg.src = off.toDataURL("image/jpeg", 0.95);
  }

  function handleCancelCrop() {
    setCropSelection(null);
  }

  function handleZoomIn() {
    setManualZoom(true);
    setZoomFactor((f) => Math.min(ZOOM_MAX, Math.round((f + ZOOM_STEP) * 100) / 100));
  }

  function handleZoomOut() {
    setManualZoom(true);
    setZoomFactor((f) => Math.max(ZOOM_MIN, Math.round((f - ZOOM_STEP) * 100) / 100));
  }

  function handleResetZoom() {
    setManualZoom(false);
    setZoomFactor(1);
  }

  function getFlattenedBlob() {
    return new Promise((resolve) => {
      canvasRef.current.toBlob((blob) => resolve(blob), "image/jpeg", 0.92);
    });
  }

  async function handleDownload() {
    const blob = await getFlattenedBlob();
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `telesto-snapshot-${Date.now()}.jpg`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    setMessage({ type: "success", text: "Saved to your device" });
  }

  async function handleSaveToLibrary(shareOverride) {
    setSaving(true);
    setMessage(null);
    try {
      const blob = await getFlattenedBlob();
      if (!blob) throw new Error("Couldn't render image");

      const formData = new FormData();
      formData.append("file", blob, `snapshot-${Date.now()}.jpg`);

      const params = new URLSearchParams({
        depth: telemetry.depth || "",
        coords: telemetry.coords || "",
        temp: telemetry.temp || "",
        salinity: telemetry.salinity || "",
        heading: telemetry.heading || "",
        species_query: speciesQuery || "",
        owner_email: ownerEmail || "",
        annotated: strokes.length > 0 ? "true" : "false",
        shared: shareOverride ? "true" : "false",
      });

      const res = await fetch(`${API_BASE_URL}/snapshot?${params}`, {
        method: "POST",
        body: formData,
      });
      if (!res.ok) throw new Error(`Save failed: ${res.status}`);
      const data = await res.json();

      setMessage({
        type: "success",
        text: shareOverride ? "Saved to the team library" : "Saved to your snapshot library",
      });
      onSaved?.(data);
      return data;
    } catch (err) {
      console.error("Save snapshot failed:", err);
      setMessage({ type: "error", text: "Couldn't save — check connection and try again" });
      return null;
    } finally {
      setSaving(false);
    }
  }

  async function handleShareDevice() {
    setMessage(null);
    try {
      const blob = await getFlattenedBlob();
      if (!blob) throw new Error("Couldn't render image");
      const file = new File([blob], `telesto-snapshot-${Date.now()}.jpg`, { type: "image/jpeg" });

      if (navigator.share && navigator.canShare?.({ files: [file] })) {
        await navigator.share({
          files: [file],
          title: "Telesto Node snapshot",
          text: speciesQuery ? `Discovery Snapshot — ${speciesQuery}` : "Discovery Snapshot",
        });
        return;
      }

      // Fallback: save it first (if not already saved) to get a stable
      // URL, then copy that link to the clipboard.
      const saved = await handleSaveToLibrary();
      if (saved?.url && navigator.clipboard) {
        await navigator.clipboard.writeText(saved.url);
        setMessage({ type: "success", text: "Link copied to clipboard" });
      }
    } catch (err) {
      if (err?.name !== "AbortError") {
        console.error("Share failed:", err);
        setMessage({ type: "error", text: "Couldn't share — try downloading instead" });
      }
    }
  }

  async function handleShareWithTeam() {
    await handleSaveToLibrary(true);
  }

  async function handleConfirmDelete() {
    if (!existingSnapshotId) return;
    setDeleting(true);
    try {
      const params = new URLSearchParams({ owner_email: ownerEmail || "" });
      const res = await fetch(`${API_BASE_URL}/snapshots/${existingSnapshotId}?${params}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error(`Delete failed: ${res.status}`);
      onDeleted?.(existingSnapshotId);
      onClose?.();
    } catch (err) {
      console.error("Delete snapshot failed:", err);
      setMessage({ type: "error", text: "Couldn't delete — check connection and try again" });
      setConfirmingDelete(false);
    } finally {
      setDeleting(false);
    }
  }

  if (!open) return null;

  const textEditorStyle = textEditor
    ? {
        left: `${(textEditor.x / (canvasRef.current?.width || 1)) * 100}%`,
        top: `${(textEditor.y / (canvasRef.current?.height || 1)) * 100}%`,
        color,
      }
    : null;

  const canvasPixelWidth =
    manualZoom && fitWidthRef.current ? fitWidthRef.current * zoomFactor : undefined;
  const canvasPixelHeight =
    manualZoom && fitWidthRef.current && canvasRef.current
      ? canvasPixelWidth * (canvasRef.current.height / canvasRef.current.width)
      : undefined;

  const cursorClass =
    tool === "text"
      ? "cursor-text"
      : tool === "eraser"
      ? "cursor-cell"
      : "cursor-crosshair";

  return (
    <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-3 sm:p-6 font-mono text-sm">
      <div className="w-full max-w-3xl max-h-[92vh] flex flex-col bg-[#1c2226] border border-[#3a444a] rounded-xl overflow-hidden">
        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-2 px-3 sm:px-4 py-2.5 border-b border-[#3a444a]">
          {TOOLS.map((t) => (
            <button
              key={t.id}
              onClick={() => selectTool(t.id)}
              className={`border rounded-lg px-2.5 py-1 text-[10px] uppercase tracking-widest ${
                tool === t.id
                  ? "bg-[#8fa3ad]/20 border-[#8fa3ad]/60 text-[#d3dbe0]"
                  : "bg-white/[0.04] border-[#3a444a] text-[#b7c4cc] hover:bg-white/[0.08]"
              }`}
            >
              {t.label}
            </button>
          ))}

          <div className="flex items-center gap-1 ml-1">
            {SWATCHES.map((c) => (
              <button
                key={c}
                onClick={() => setColor(c)}
                aria-label={`Color ${c}`}
                className={`w-5 h-5 rounded-full border-2 ${
                  color === c ? "border-[#d3dbe0]" : "border-transparent"
                }`}
                style={{ backgroundColor: c }}
              />
            ))}
            {/* Full color picker, like MS Paint's "Edit colors" — native
                browser color dialog gives access to the entire spectrum,
                not just the swatch presets above. */}
            <label
              className="relative w-5 h-5 rounded-full border-2 border-dashed border-[#5a6a72] cursor-pointer overflow-hidden flex items-center justify-center"
              title="Pick any color"
            >
              <span
                className="absolute inset-0.5 rounded-full"
                style={{ background: "conic-gradient(red, yellow, lime, cyan, blue, magenta, red)" }}
              />
              <input
                type="color"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                className="absolute inset-0 opacity-0 cursor-pointer"
              />
            </label>
          </div>

          <input
            type="range"
            min="1"
            max="10"
            value={width}
            onChange={(e) => setWidth(Number(e.target.value))}
            className="w-16 sm:w-20 accent-[#8fa3ad] ml-1"
            title="Stroke width"
          />

          <div className="flex items-center gap-2 ml-auto">
            <button
              onClick={handleUndo}
              disabled={history.length === 0}
              className="text-[10px] uppercase tracking-widest text-[#8fa3ad] hover:text-[#d3dbe0] disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Undo
            </button>
            <button
              onClick={handleRedo}
              disabled={future.length === 0}
              className="text-[10px] uppercase tracking-widest text-[#8fa3ad] hover:text-[#d3dbe0] disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Redo
            </button>
            <button
              onClick={handleClearAnnotations}
              disabled={strokes.length === 0}
              className="text-[10px] uppercase tracking-widest text-[#c47a6e] hover:text-[#d99a8f] disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Remove annotations
            </button>
          </div>
        </div>

        {/* Zoom + crop-apply row */}
        <div className="flex flex-wrap items-center gap-2 px-3 sm:px-4 py-2 border-b border-[#3a444a]">
          <div className="flex items-center gap-1.5">
            <button
              onClick={handleZoomOut}
              className="border border-[#3a444a] rounded-lg w-6 h-6 flex items-center justify-center text-xs text-[#b7c4cc] hover:bg-white/[0.08]"
              title="Zoom out"
            >
              −
            </button>
            <button
              onClick={handleResetZoom}
              className="text-[10px] text-[#5a6a72] hover:text-[#b7c4cc] w-12 text-center"
              title="Reset zoom"
            >
              {Math.round((manualZoom ? zoomFactor : 1) * 100)}%
            </button>
            <button
              onClick={handleZoomIn}
              className="border border-[#3a444a] rounded-lg w-6 h-6 flex items-center justify-center text-xs text-[#b7c4cc] hover:bg-white/[0.08]"
              title="Zoom in"
            >
              +
            </button>
          </div>

          {tool === "crop" && (
            <span className="text-[10px] text-[#5a6a72]">Drag on the image to select an area</span>
          )}

          {cropSelection && (
            <div className="flex items-center gap-2 ml-auto">
              <button
                onClick={handleApplyCrop}
                className="bg-[#8fa3ad]/10 border border-[#8fa3ad]/60 rounded-lg px-2.5 py-1 text-[10px] uppercase tracking-widest hover:bg-[#8fa3ad]/20"
              >
                Apply crop
              </button>
              <button
                onClick={handleCancelCrop}
                className="text-[10px] uppercase tracking-widest text-[#5a6a72] hover:text-[#b7c4cc]"
              >
                Cancel crop
              </button>
            </div>
          )}
        </div>

        {/* Canvas */}
        <div
          className={`flex-1 min-h-0 overflow-auto bg-black/40 flex p-2 sm:p-4 ${
            manualZoom ? "items-start justify-start" : "items-center justify-center"
          }`}
        >
          {!imageLoaded && <p className="text-xs text-[#5a6a72]">Loading image…</p>}
          <div className={`relative ${imageLoaded ? "inline-block" : "hidden"}`}>
            <canvas
              ref={canvasRef}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerLeave={handlePointerUp}
              style={{ width: canvasPixelWidth, height: canvasPixelHeight }}
              className={`block ${
                manualZoom ? "" : "max-w-full max-h-[60vh]"
              } ${cursorClass} touch-none rounded-lg`}
            />
            {textEditor && (
              <input
                autoFocus
                type="text"
                value={textEditor.value}
                onChange={(e) => setTextEditor((cur) => ({ ...cur, value: e.target.value }))}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitTextEditor();
                  if (e.key === "Escape") setTextEditor(null);
                }}
                onBlur={commitTextEditor}
                placeholder="Type annotation…"
                style={textEditorStyle}
                className="absolute bg-black/60 border border-[#8fa3ad] rounded px-1.5 py-0.5 text-sm outline-none min-w-[140px]"
              />
            )}
          </div>
        </div>

        {/* Actions */}
        <div className="flex flex-col gap-2 px-3 sm:px-4 py-3 border-t border-[#3a444a]">
          <div className="flex flex-wrap items-center gap-2 sm:gap-3">
            <button
              onClick={() => handleSaveToLibrary()}
              disabled={saving || !imageLoaded}
              className="bg-[#8fa3ad]/10 border border-[#8fa3ad]/60 rounded-lg px-3 py-1.5 text-[10px] sm:text-xs uppercase tracking-widest hover:bg-[#8fa3ad]/20 disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save to library"}
            </button>
            <button
              onClick={handleDownload}
              disabled={!imageLoaded}
              className="bg-white/[0.04] border border-[#3a444a] rounded-lg px-3 py-1.5 text-[10px] sm:text-xs uppercase tracking-widest text-[#b7c4cc] hover:bg-white/[0.08] disabled:opacity-50"
            >
              Download
            </button>
            <button
              onClick={handleShareDevice}
              disabled={!imageLoaded}
              className="bg-white/[0.04] border border-[#3a444a] rounded-lg px-3 py-1.5 text-[10px] sm:text-xs uppercase tracking-widest text-[#b7c4cc] hover:bg-white/[0.08] disabled:opacity-50"
            >
              Share
            </button>
            <button
              onClick={handleShareWithTeam}
              disabled={saving || !imageLoaded}
              className="bg-white/[0.04] border border-[#3a444a] rounded-lg px-3 py-1.5 text-[10px] sm:text-xs uppercase tracking-widest text-[#b7c4cc] hover:bg-white/[0.08] disabled:opacity-50"
            >
              Share with team
            </button>

            {mode === "view" && existingSnapshotId && !confirmingDelete && (
              <button
                onClick={() => setConfirmingDelete(true)}
                className="text-[10px] sm:text-xs uppercase tracking-widest text-[#c47a6e] hover:text-[#d99a8f]"
              >
                Delete
              </button>
            )}
            {confirmingDelete && (
              <span className="flex items-center gap-2 text-[10px] sm:text-xs">
                <span className="text-[#d8b877]">Delete this snapshot?</span>
                <button
                  onClick={handleConfirmDelete}
                  disabled={deleting}
                  className="uppercase tracking-widest text-[#c47a6e] hover:text-[#d99a8f] disabled:opacity-50"
                >
                  {deleting ? "Deleting…" : "Yes, delete"}
                </button>
                <button
                  onClick={() => setConfirmingDelete(false)}
                  className="uppercase tracking-widest text-[#5a6a72] hover:text-[#b7c4cc]"
                >
                  Cancel
                </button>
              </span>
            )}

            {message && (
              <span
                className={`text-[10px] sm:text-xs ${
                  message.type === "success" ? "text-[#8fa3ad]" : "text-[#c47a6e]"
                }`}
              >
                {message.text}
              </span>
            )}

            <button
              onClick={onClose}
              className="ml-auto text-[10px] sm:text-xs uppercase tracking-widest text-[#5a6a72] hover:text-[#b7c4cc]"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}