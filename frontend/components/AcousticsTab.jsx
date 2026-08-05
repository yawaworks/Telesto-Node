"use client";

import { useEffect, useRef, useState } from "react";
import {
  analyzeAcousticClip,
  createAcousticReference,
  deleteAcousticReference,
  listAcousticReferences,
} from "../lib/workspaceApi";
import { TrashIcon, WaveformIcon } from "./icons";

function formatTimestamp(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function AddReferenceForm({ channelId, currentEmail, onAdded }) {
  const [label, setLabel] = useState("");
  const fileInputRef = useRef(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  async function handleFilePicked(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!label.trim()) {
      setError("Give this sound a label first (e.g. \"snapping shrimp\")");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const reference = await createAcousticReference(channelId, {
        file,
        label: label.trim(),
        createdBy: currentEmail,
      });
      onAdded(reference);
      setLabel("");
    } catch (err) {
      setError(err.message || "Couldn't add that reference sound");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="bg-[#1c2226] border border-[#3a444a] rounded-xl p-4 flex flex-col gap-3">
      <h3 className="text-[10px] uppercase tracking-widest text-[#8fa3ad]">Add a reference sound</h3>
      <p className="text-[11px] text-[#5a6a72]">
        A short clip (a few seconds) of one known call or sound. Later recordings can be searched for
        moments that sound similar to it.
      </p>
      <div className="flex gap-3">
        <input
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="e.g. Humpback whale song"
          className="flex-1 bg-black/20 border border-[#3a444a] rounded-lg px-3 py-2 text-sm text-[#d3dbe0] placeholder-[#5a6a72] outline-none focus:border-[#8fa3ad]"
        />
        <input ref={fileInputRef} type="file" accept="audio/*,video/*" onChange={handleFilePicked} className="hidden" />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={saving}
          className="shrink-0 bg-[#8fa3ad]/10 border border-[#8fa3ad]/60 rounded-lg px-4 py-2 text-xs uppercase tracking-widest text-[#d3dbe0] hover:bg-[#8fa3ad]/20 transition disabled:opacity-50"
        >
          {saving ? "Uploading…" : "Choose clip"}
        </button>
      </div>
      {error && <p className="text-xs text-[#c47a6e]">{error}</p>}
    </div>
  );
}

function ReferenceRow({ reference, currentEmail, selected, onSelect, onDeleted }) {
  const [deleting, setDeleting] = useState(false);

  async function handleDelete(e) {
    e.stopPropagation();
    if (!window.confirm(`Remove reference sound "${reference.label}"?`)) return;
    setDeleting(true);
    try {
      await deleteAcousticReference(reference.id, currentEmail);
      onDeleted(reference.id);
    } catch (err) {
      console.error("Delete reference failed:", err);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <button
      type="button"
      onClick={() => onSelect(reference.id)}
      className={`w-full flex items-center justify-between gap-3 px-4 py-2.5 text-left border-b border-[#3a444a]/50 transition ${
        selected ? "bg-[#8fa3ad]/12" : "hover:bg-white/[0.03]"
      }`}
    >
      <div className="flex items-center gap-2 min-w-0">
        <WaveformIcon className="w-3.5 h-3.5 text-[#8fa3ad] shrink-0" />
        <span className="text-sm text-[#d3dbe0] truncate">{reference.label}</span>
      </div>
      <span
        role="button"
        tabIndex={0}
        onClick={handleDelete}
        className="shrink-0 text-[#5a6a72] hover:text-[#c47a6e]"
        aria-label={`Delete ${reference.label}`}
      >
        {deleting ? "…" : <TrashIcon className="w-3.5 h-3.5" />}
      </span>
    </button>
  );
}

export default function AcousticsTab({ channelId, currentEmail }) {
  const [references, setReferences] = useState([]);
  const [loadingReferences, setLoadingReferences] = useState(true);
  const [selectedReferenceId, setSelectedReferenceId] = useState(null);
  const [threshold, setThreshold] = useState(0.6);
  const [analyzing, setAnalyzing] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const analyzeInputRef = useRef(null);

  function reloadReferences() {
    setLoadingReferences(true);
    listAcousticReferences(channelId, currentEmail)
      .then((result) => {
        setReferences(result);
        setSelectedReferenceId((current) => current || result[0]?.id || null);
      })
      .catch((err) => console.error("Failed to load reference sounds:", err))
      .finally(() => setLoadingReferences(false));
  }

  useEffect(reloadReferences, [channelId, currentEmail]);

  function handleReferenceAdded(reference) {
    setReferences((prev) => [reference, ...prev]);
    setSelectedReferenceId(reference.id);
  }

  function handleReferenceDeleted(id) {
    setReferences((prev) => prev.filter((r) => r.id !== id));
    setSelectedReferenceId((current) => (current === id ? null : current));
  }

  async function handleAnalyzeFilePicked(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !selectedReferenceId) return;

    setAnalyzing(true);
    setError(null);
    setResult(null);
    try {
      const analysis = await analyzeAcousticClip(channelId, {
        file,
        referenceId: selectedReferenceId,
        requesterEmail: currentEmail,
        threshold,
      });
      setResult(analysis);
    } catch (err) {
      setError(err.message || "Analysis failed");
    } finally {
      setAnalyzing(false);
    }
  }

  const selectedReference = references.find((r) => r.id === selectedReferenceId);

  return (
    <div className="h-full overflow-y-auto px-4 sm:px-6 py-5 flex flex-col gap-5 max-w-2xl">
      <AddReferenceForm channelId={channelId} currentEmail={currentEmail} onAdded={handleReferenceAdded} />

      <div className="bg-[#1c2226] border border-[#3a444a] rounded-xl overflow-hidden">
        <h3 className="text-[10px] uppercase tracking-widest text-[#8fa3ad] px-4 pt-3 pb-2">
          Reference sounds — select one to search against
        </h3>
        {loadingReferences && <p className="px-4 pb-4 text-xs text-[#5a6a72]">Loading…</p>}
        {!loadingReferences && references.length === 0 && (
          <p className="px-4 pb-4 text-xs text-[#5a6a72]">
            No reference sounds yet — add one above to get started.
          </p>
        )}
        {references.map((r) => (
          <ReferenceRow
            key={r.id}
            reference={r}
            currentEmail={currentEmail}
            selected={r.id === selectedReferenceId}
            onSelect={setSelectedReferenceId}
            onDeleted={handleReferenceDeleted}
          />
        ))}
      </div>

      <div className="bg-[#1c2226] border border-[#3a444a] rounded-xl p-4 flex flex-col gap-3">
        <h3 className="text-[10px] uppercase tracking-widest text-[#8fa3ad]">
          Search a recording for "{selectedReference?.label || "…"}"
        </h3>
        <p className="text-[11px] text-[#5a6a72]">
          Up to 3 minutes per clip on the free tier. This is similarity search, not species
          identification — verify matches by ear.
        </p>

        <div>
          <div className="flex items-center justify-between text-[11px] text-[#5a6a72] mb-1">
            <span>Match sensitivity</span>
            <span>{threshold.toFixed(2)}</span>
          </div>
          <input
            type="range"
            min="0.3"
            max="0.9"
            step="0.05"
            value={threshold}
            onChange={(e) => setThreshold(Number(e.target.value))}
            className="w-full accent-[#8fa3ad]"
          />
        </div>

        <input
          ref={analyzeInputRef}
          type="file"
          accept="audio/*,video/*"
          onChange={handleAnalyzeFilePicked}
          className="hidden"
        />
        <button
          type="button"
          onClick={() => analyzeInputRef.current?.click()}
          disabled={!selectedReferenceId || analyzing}
          className="self-start bg-[#8fa3ad]/10 border border-[#8fa3ad]/60 rounded-lg px-4 py-2 text-xs uppercase tracking-widest text-[#d3dbe0] hover:bg-[#8fa3ad]/20 transition disabled:opacity-40"
        >
          {analyzing ? "Analyzing…" : "Choose a recording to search"}
        </button>

        {analyzing && (
          <p className="text-[11px] text-[#5a6a72]">
            Running on CPU — this can take a minute or more depending on clip length.
          </p>
        )}

        {error && <p className="text-xs text-[#c47a6e]">{error}</p>}

        {result && (
          <div className="mt-2 border-t border-[#3a444a] pt-3">
            <p className="text-[11px] text-[#a48a55] mb-2">{result.warning}</p>
            <p className="text-[11px] text-[#5a6a72] mb-2">
              {result.windows_analyzed} window{result.windows_analyzed === 1 ? "" : "s"} analyzed ·{" "}
              {result.matches.length} match{result.matches.length === 1 ? "" : "es"} above threshold
            </p>
            {result.matches.length === 0 ? (
              <p className="text-xs text-[#5a6a72]">No similar moments found at this sensitivity.</p>
            ) : (
              <div className="flex flex-col gap-1">
                {result.matches.map((m, i) => (
                  <div
                    key={i}
                    className="flex items-center justify-between px-3 py-1.5 bg-black/20 border border-[#3a444a] rounded-lg"
                  >
                    <span className="text-sm text-[#d3dbe0]">{formatTimestamp(m.start_seconds)}</span>
                    <span className="text-xs text-[#8fa3ad]">{(m.score * 100).toFixed(0)}% similar</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}