"use client";

import { useEffect, useRef, useState } from "react";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:5050";

const TOOLS = [
  { id: "pen", label: "Pen" },
  { id: "arrow", label: "Arrow" },
  { id: "rect", label: "Box" },
  { id: "text", label: "Text" },
];

const COLORS = ["#d3dbe0", "#8fa3ad", "#c47a6e", "#d8b877", "#6ec49a"];

function getCanvasPoint(canvas, clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  return { x: (clientX - rect.left) * scaleX, y: (clientY - rect.top) * scaleY };
}

function drawArrowhead(ctx, from, to, color) {
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const headLength = 14;
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
  ctx.strokeStyle = stroke.color;
  ctx.fillStyle = stroke.color;
  ctx.lineWidth = stroke.width;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  if (stroke.type === "pen") {
    if (stroke.points.length < 2) return;
    ctx.beginPath();
    ctx.moveTo(stroke.points[0].x, stroke.points[0].y);
    for (const p of stroke.points.slice(1)) ctx.lineTo(p.x, p.y);
    ctx.stroke();
  } else if (stroke.type === "arrow") {
    ctx.beginPath();
    ctx.moveTo(stroke.start.x, stroke.start.y);
    ctx.lineTo(stroke.end.x, stroke.end.y);
    ctx.stroke();
    drawArrowhead(ctx, stroke.start, stroke.end, stroke.color);
  } else if (stroke.type === "rect") {
    const x = Math.min(stroke.start.x, stroke.end.x);
    const y = Math.min(stroke.start.y, stroke.end.y);
    const w = Math.abs(stroke.end.x - stroke.start.x);
    const h = Math.abs(stroke.end.y - stroke.start.y);
    ctx.strokeRect(x, y, w, h);
  } else if (stroke.type === "text") {
    ctx.font = `${Math.max(16, stroke.width * 6)}px monospace`;
    ctx.fillText(stroke.text, stroke.start.x, stroke.start.y);
  }
}

/**
 * A screenshot-tool-style annotation editor for Discovery Snapshots.
 *
 * mode="new"  — imageSrc is a freshly captured data URL, not saved yet.
 *               Shows Save to library / Download / Share / Discard.
 * mode="view" — imageSrc is an existing saved snapshot's Cloudinary URL.
 *               Re-annotating and saving creates a NEW snapshot entry
 *               (the original stays intact) — same as most screenshot
 *               tools treat "edit a saved shot".
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
  const [tool, setTool] = useState("pen");
  const [color, setColor] = useState(COLORS[0]);
  const [width, setWidth] = useState(3);
  const drawingRef = useRef(null); // in-progress stroke, not yet committed

  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [message, setMessage] = useState(null);

  useEffect(() => {
    if (!open || !imageSrc) return;
    setImageLoaded(false);
    setStrokes([]);
    setMessage(null);

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

  function redraw(previewStroke) {
    const canvas = canvasRef.current;
    const img = imageRef.current;
    if (!canvas || !img) return;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    for (const s of strokes) drawStroke(ctx, s);
    if (previewStroke) drawStroke(ctx, previewStroke);
  }

  useEffect(() => {
    if (imageLoaded) redraw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageLoaded, strokes]);

  function handlePointerDown(e) {
    if (!imageLoaded) return;
    const canvas = canvasRef.current;
    const point = getCanvasPoint(canvas, e.clientX, e.clientY);

    if (tool === "text") {
      const text = window.prompt("Annotation text:");
      if (text && text.trim()) {
        setStrokes((prev) => [
          ...prev,
          { type: "text", start: point, text: text.trim(), color, width },
        ]);
      }
      return;
    }

    canvas.setPointerCapture?.(e.pointerId);
    if (tool === "pen") {
      drawingRef.current = { type: "pen", points: [point], color, width };
    } else {
      drawingRef.current = { type: tool, start: point, end: point, color, width };
    }
  }

  function handlePointerMove(e) {
    if (!drawingRef.current) return;
    const canvas = canvasRef.current;
    const point = getCanvasPoint(canvas, e.clientX, e.clientY);

    if (drawingRef.current.type === "pen") {
      drawingRef.current.points.push(point);
    } else {
      drawingRef.current.end = point;
    }
    redraw(drawingRef.current);
  }

  function handlePointerUp() {
    if (!drawingRef.current) return;
    setStrokes((prev) => [...prev, drawingRef.current]);
    drawingRef.current = null;
  }

  function handleUndo() {
    setStrokes((prev) => prev.slice(0, -1));
  }

  function handleClearAnnotations() {
    setStrokes([]);
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

  async function handleSaveToLibrary() {
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
      });

      const res = await fetch(`${API_BASE_URL}/snapshot?${params}`, {
        method: "POST",
        body: formData,
      });
      if (!res.ok) throw new Error(`Save failed: ${res.status}`);
      const data = await res.json();

      setMessage({ type: "success", text: "Saved to your snapshot library" });
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

  async function handleShare() {
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

  async function handleDelete() {
    if (!existingSnapshotId) return;
    if (!window.confirm("Delete this snapshot? This can't be undone.")) return;
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
    } finally {
      setDeleting(false);
    }
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-3 sm:p-6 font-mono text-sm">
      <div className="w-full max-w-3xl max-h-[92vh] flex flex-col bg-[#1c2226] border border-[#3a444a] rounded-xl overflow-hidden">
        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-2 px-3 sm:px-4 py-2.5 border-b border-[#3a444a]">
          {TOOLS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTool(t.id)}
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
            {COLORS.map((c) => (
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
          </div>

          <input
            type="range"
            min="1"
            max="10"
            value={width}
            onChange={(e) => setWidth(Number(e.target.value))}
            className="w-16 sm:w-20 accent-[#8fa3ad] ml-1"
          />

          <div className="flex items-center gap-2 ml-auto">
            <button
              onClick={handleUndo}
              disabled={strokes.length === 0}
              className="text-[10px] uppercase tracking-widest text-[#8fa3ad] hover:text-[#d3dbe0] disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Undo
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

        {/* Canvas */}
        <div className="flex-1 min-h-0 overflow-auto bg-black/40 flex items-center justify-center p-2 sm:p-4">
          {!imageLoaded && <p className="text-xs text-[#5a6a72]">Loading image…</p>}
          <canvas
            ref={canvasRef}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerLeave={handlePointerUp}
            className={`max-w-full max-h-full ${imageLoaded ? "block" : "hidden"} ${
              tool === "text" ? "cursor-text" : "cursor-crosshair"
            } touch-none rounded-lg`}
          />
        </div>

        {/* Actions */}
        <div className="flex flex-wrap items-center gap-2 sm:gap-3 px-3 sm:px-4 py-3 border-t border-[#3a444a]">
          <button
            onClick={handleSaveToLibrary}
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
            onClick={handleShare}
            disabled={!imageLoaded}
            className="bg-white/[0.04] border border-[#3a444a] rounded-lg px-3 py-1.5 text-[10px] sm:text-xs uppercase tracking-widest text-[#b7c4cc] hover:bg-white/[0.08] disabled:opacity-50"
          >
            Share
          </button>

          {mode === "view" && existingSnapshotId && (
            <button
              onClick={handleDelete}
              disabled={deleting}
              className="text-[10px] sm:text-xs uppercase tracking-widest text-[#c47a6e] hover:text-[#d99a8f] disabled:opacity-50"
            >
              {deleting ? "Deleting…" : "Delete"}
            </button>
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
  );
}