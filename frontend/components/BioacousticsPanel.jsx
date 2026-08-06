"use client";

import { useEffect, useRef, useState } from "react";
import {
  analyzeAcousticClip,
  compareAcousticEvents,
  compareRhythmStandalone,
  createAcousticEvent,
  createAcousticReference,
  deleteAcousticEvent,
  deleteAcousticReference,
  listAcousticEvents,
  listAcousticReferences,
} from "../lib/workspaceApi";
import { TrashIcon, WaveformIcon } from "./icons";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:5050";

function formatTimestamp(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function formatHz(v) {
  if (v === null || v === undefined) return "—";
  return v >= 1000 ? `${(v / 1000).toFixed(2)} kHz` : `${Math.round(v)} Hz`;
}

function formatDb(v) {
  if (v === null || v === undefined) return "—";
  return `${v.toFixed(1)} dB`;
}

function formatPercent(v) {
  if (v === null || v === undefined) return "—";
  return `${Math.round(v * 100)}%`;
}

function formatMs(v) {
  if (v === null || v === undefined) return "—";
  return `${v.toFixed(0)} ms`;
}

// Small labeled stat used inside the metric group cards below.
function Stat({ label, value, caveat }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-widest text-[#5a6a72]">{label}</span>
      <span className="text-sm text-[#d3dbe0] tabular-nums">{value}</span>
      {caveat && <span className="text-[9px] text-[#a48a55] leading-tight">{caveat}</span>}
    </div>
  );
}

function MetricGroupCard({ title, children, note }) {
  return (
    <div className="bg-[#1c2226] border border-[#3a444a] rounded-xl p-4 flex flex-col gap-3">
      <h3 className="text-[10px] uppercase tracking-widest text-[#8fa3ad]">{title}</h3>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-3">{children}</div>
      {note && <p className="text-[10px] text-[#5a6a72] leading-relaxed border-t border-[#3a444a] pt-2">{note}</p>}
    </div>
  );
}

/**
 * Renders one analyze_soundscape() result — used by both solo "quick
 * metrics" mode and the metrics now bundled into embedded similarity
 * search results. These numbers are measured directly from the clip's
 * audio (plain DSP, no model), a fundamentally different confidence
 * level than the SurfPerch similarity matches shown elsewhere on this
 * panel — kept visually separate for that reason, not just organized
 * for layout.
 */
function SoundscapeMetrics({ metrics, durationSeconds }) {
  if (!metrics || Object.keys(metrics).length === 0) return null;
  const { signal_metrics: sig, soundscape_indices: idx, level_metrics: lvl } = metrics;

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[10px] uppercase tracking-widest text-[#5a6a72]">
        Measured from this recording{durationSeconds != null ? ` · ${durationSeconds.toFixed(1)}s clip` : ""}
      </p>

      {sig && (
        <MetricGroupCard title="Signal-level metrics" note={sig.pulse_detection_note}>
          <Stat label="Peak frequency" value={formatHz(sig.peak_frequency_hz)} />
          <Stat label="-3dB bandwidth" value={formatHz(sig.bandwidth_3db_hz)} />
          <Stat label="-10dB bandwidth" value={formatHz(sig.bandwidth_10db_hz)} />
          <Stat label="Pulses detected" value={sig.pulse_count ?? "—"} />
          <Stat label="Mean ICI" value={formatMs(sig.mean_ici_ms)} />
          <Stat
            label="PRR"
            value={sig.prr_hz != null ? `${sig.prr_hz.toFixed(2)} Hz` : "—"}
            caveat={sig.pulse_count >= 2 ? null : "needs 2+ detected pulses"}
          />
          <Stat label="Call rate" value={sig.call_rate_per_min != null ? `${sig.call_rate_per_min.toFixed(1)}/min` : "—"} />
          <Stat label="Duty cycle (est.)" value={formatPercent(sig.duty_cycle_estimate)} />
        </MetricGroupCard>
      )}

      {idx && (
        <MetricGroupCard title="Soundscape indices">
          <Stat label="ACI" value={idx.aci != null ? idx.aci.toFixed(1) : "—"} />
          <Stat label="Spectral entropy (Hf)" value={idx.spectral_entropy_hf != null ? idx.spectral_entropy_hf.toFixed(3) : "—"} />
          <Stat label="Temporal entropy (Ht)" value={idx.temporal_entropy_ht != null ? idx.temporal_entropy_ht.toFixed(3) : "—"} />
          <Stat label="Total entropy (H)" value={idx.total_entropy_h != null ? idx.total_entropy_h.toFixed(3) : "—"} />
          <Stat label="Bioacoustic index" value={idx.bioacoustic_index != null ? idx.bioacoustic_index.toFixed(0) : "—"} />
          <Stat label="ADI" value={idx.adi != null ? idx.adi.toFixed(2) : "—"} />
          <Stat label="AEI" value={idx.aei != null ? idx.aei.toFixed(2) : "—"} />
          <Stat label="NDSI" value={idx.ndsi != null ? idx.ndsi.toFixed(2) : "—"} />
          <Stat label="Biophony" value={formatPercent(idx.biophony_fraction)} />
          <Stat label="Anthrophony" value={formatPercent(idx.anthrophony_fraction)} />
          <Stat
            label="Geophony"
            value={formatPercent(idx.geophony_fraction_provisional)}
            caveat="provisional band, not a validated standard"
          />
        </MetricGroupCard>
      )}

      {lvl && (
        <MetricGroupCard title="Level metrics" note={lvl.calibration_note}>
          <Stat label="RMS level" value={formatDb(lvl.rms_dbfs)} caveat={lvl.calibrated ? null : "relative (dBFS)"} />
          <Stat label="Peak level" value={formatDb(lvl.peak_dbfs)} caveat={lvl.calibrated ? null : "relative (dBFS)"} />
          {lvl.calibrated && <Stat label="Calibrated SPL" value={formatDb(lvl.spl_calibrated_db)} />}
          <Stat label="L10" value={formatDb(lvl.l10_db)} />
          <Stat label="L50" value={formatDb(lvl.l50_db)} />
          <Stat label="L90" value={formatDb(lvl.l90_db)} />
          <Stat label="SNR (est.)" value={formatDb(lvl.snr_estimate_db)} caveat="soundscape-wide estimate" />
        </MetricGroupCard>
      )}
    </div>
  );
}

// --- Acoustic-context tooling: behavior tagging + rhythm comparison ------
// Deliberately NOT a translator — see backend/app/bioacoustics.py's
// rhythm-comparison section docstring for the full rationale. This UI
// only ever shows a quantitative timing-structure distance plus whatever
// context a researcher chose to attach; it never labels what a pattern
// "means".

function RhythmComparisonResult({ result }) {
  if (!result) return null;
  return (
    <div className="bg-black/20 border border-[#3a444a] rounded-lg p-3 flex flex-col gap-2">
      <p className="text-[10px] uppercase tracking-widest text-[#8fa3ad]">Rhythm comparison</p>
      {result.shape_similarity === null ? (
        <p className="text-xs text-[#c47a6e]">{result.warning}</p>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-3">
            <Stat label="Shape similarity" value={formatPercent(result.shape_similarity)} />
            <Stat label="Tempo-normalized DTW" value={result.normalized_dtw.toFixed(2)} />
            <Stat label="Raw DTW" value={`${result.raw_dtw_ms.toFixed(0)} ms`} />
          </div>
          <p className="text-[10px] text-[#5a6a72] leading-relaxed">{result.warning}</p>
        </>
      )}
    </div>
  );
}

function BehavioralContextForm({ context, onChange }) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <div>
        <label className="text-[10px] uppercase tracking-widest text-[#5a6a72] block mb-1">Depth (m)</label>
        <input
          type="number"
          step="0.1"
          value={context.depth_m ?? ""}
          onChange={(e) => onChange({ ...context, depth_m: e.target.value === "" ? null : Number(e.target.value) })}
          className="w-full bg-black/20 border border-[#3a444a] rounded-lg px-3 py-2 text-sm text-[#d3dbe0] outline-none focus:border-[#8fa3ad]"
        />
      </div>
      <div>
        <label className="text-[10px] uppercase tracking-widest text-[#5a6a72] block mb-1">Movement</label>
        <select
          value={context.movement ?? ""}
          onChange={(e) => onChange({ ...context, movement: e.target.value || null })}
          className="w-full bg-black/20 border border-[#3a444a] rounded-lg px-3 py-2 text-sm text-[#d3dbe0] outline-none focus:border-[#8fa3ad]"
        >
          <option value="" className="bg-[#1c2226]">Unknown</option>
          <option value="stationary" className="bg-[#1c2226]">Stationary</option>
          <option value="traveling" className="bg-[#1c2226]">Traveling</option>
          <option value="diving" className="bg-[#1c2226]">Diving</option>
          <option value="surfacing" className="bg-[#1c2226]">Surfacing</option>
        </select>
      </div>
      <div>
        <label className="text-[10px] uppercase tracking-widest text-[#5a6a72] block mb-1">Feeding observed</label>
        <select
          value={context.feeding === null || context.feeding === undefined ? "" : String(context.feeding)}
          onChange={(e) => onChange({ ...context, feeding: e.target.value === "" ? null : e.target.value === "true" })}
          className="w-full bg-black/20 border border-[#3a444a] rounded-lg px-3 py-2 text-sm text-[#d3dbe0] outline-none focus:border-[#8fa3ad]"
        >
          <option value="" className="bg-[#1c2226]">Unknown</option>
          <option value="true" className="bg-[#1c2226]">Yes</option>
          <option value="false" className="bg-[#1c2226]">No</option>
        </select>
      </div>
      <div>
        <label className="text-[10px] uppercase tracking-widest text-[#5a6a72] block mb-1">Social context</label>
        <select
          value={context.social ?? ""}
          onChange={(e) => onChange({ ...context, social: e.target.value || null })}
          className="w-full bg-black/20 border border-[#3a444a] rounded-lg px-3 py-2 text-sm text-[#d3dbe0] outline-none focus:border-[#8fa3ad]"
        >
          <option value="" className="bg-[#1c2226]">Unknown</option>
          <option value="solo" className="bg-[#1c2226]">Solo individual</option>
          <option value="social" className="bg-[#1c2226]">Social group</option>
        </select>
      </div>
      <div className="col-span-2">
        <label className="text-[10px] uppercase tracking-widest text-[#5a6a72] block mb-1">Notes</label>
        <textarea
          value={context.notes ?? ""}
          onChange={(e) => onChange({ ...context, notes: e.target.value })}
          rows={2}
          placeholder="Anything else observed at capture time"
          className="w-full bg-black/20 border border-[#3a444a] rounded-lg px-3 py-2 text-sm text-[#d3dbe0] placeholder-[#5a6a72] outline-none focus:border-[#8fa3ad] resize-none"
        />
      </div>
    </div>
  );
}

const EMPTY_CONTEXT = { depth_m: null, movement: null, feeding: null, social: null, notes: "" };

function contextSummary(context) {
  const parts = [];
  if (context.depth_m != null) parts.push(`${context.depth_m}m`);
  if (context.movement) parts.push(context.movement);
  if (context.feeding === true) parts.push("feeding");
  if (context.social) parts.push(context.social);
  return parts.length ? parts.join(" · ") : "no context logged";
}

// --- Embedded mode: persisted per-channel reference library ---------------

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
      setError('Give this sound a label first (e.g. "snapping shrimp")');
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
        A short clip (a few seconds) of one known call or sound, shared with the whole channel. Later
        recordings can be searched for moments that sound similar to it.
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

function EmbeddedBioacoustics({ channelId, currentEmail }) {
  const [references, setReferences] = useState([]);
  const [loadingReferences, setLoadingReferences] = useState(true);
  const [selectedReferenceId, setSelectedReferenceId] = useState(null);
  const [threshold, setThreshold] = useState(0.6);
  const [analyzing, setAnalyzing] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const analyzeInputRef = useRef(null);

  // Acoustic-context tooling — behavior tagging on the clip just
  // analyzed above, plus the channel's saved-event library for
  // comparison across missions/days.
  const [logContext, setLogContext] = useState(EMPTY_CONTEXT);
  const [logLabel, setLogLabel] = useState("");
  const [logging, setLogging] = useState(false);
  const [logError, setLogError] = useState(null);
  const [events, setEvents] = useState([]);
  const [loadingEvents, setLoadingEvents] = useState(true);
  const [selectedEventIds, setSelectedEventIds] = useState([]);
  const [comparing, setComparing] = useState(false);
  const [compareResult, setCompareResult] = useState(null);
  const [compareError, setCompareError] = useState(null);

  function reloadEvents() {
    setLoadingEvents(true);
    listAcousticEvents(channelId, currentEmail)
      .then(setEvents)
      .catch((err) => console.error("Failed to load acoustic events:", err))
      .finally(() => setLoadingEvents(false));
  }

  useEffect(reloadEvents, [channelId, currentEmail]);

  async function handleLogEvent() {
    const iciMs = result?.metrics?.signal_metrics?.ici_ms || [];
    setLogging(true);
    setLogError(null);
    try {
      const event = await createAcousticEvent(channelId, {
        label: logLabel,
        createdBy: currentEmail,
        context: logContext,
        iciMs,
        durationSeconds: result?.metrics?.duration_seconds,
      });
      setEvents((prev) => [event, ...prev]);
      setLogLabel("");
      setLogContext(EMPTY_CONTEXT);
    } catch (err) {
      setLogError(err.message || "Couldn't save this event");
    } finally {
      setLogging(false);
    }
  }

  function toggleEventSelected(id) {
    setCompareResult(null);
    setCompareError(null);
    setSelectedEventIds((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= 2) return [prev[1], id]; // keep the most recent two picks
      return [...prev, id];
    });
  }

  async function handleDeleteEvent(id) {
    if (!window.confirm("Remove this logged acoustic event?")) return;
    try {
      await deleteAcousticEvent(id, currentEmail);
      setEvents((prev) => prev.filter((e) => e.id !== id));
      setSelectedEventIds((prev) => prev.filter((x) => x !== id));
    } catch (err) {
      console.error("Delete acoustic event failed:", err);
    }
  }

  async function handleCompareEvents() {
    if (selectedEventIds.length !== 2) return;
    setComparing(true);
    setCompareError(null);
    setCompareResult(null);
    try {
      const cmp = await compareAcousticEvents(channelId, {
        requesterEmail: currentEmail,
        eventIdA: selectedEventIds[0],
        eventIdB: selectedEventIds[1],
      });
      setCompareResult(cmp);
    } catch (err) {
      setCompareError(err.message || "Comparison failed");
    } finally {
      setComparing(false);
    }
  }

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
    <div className="h-full overflow-y-auto px-4 sm:px-6 py-5 flex flex-col gap-5 max-w-2xl mx-auto">
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
          Up to 3 minutes per clip on the free tier. Similarity search, not species identification —
          verify matches by ear. Soundscape/signal metrics below are measured directly from the clip,
          independent of this search.
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
          <div className="mt-2 border-t border-[#3a444a] pt-3 flex flex-col gap-4">
            <div>
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

            <SoundscapeMetrics metrics={result.metrics} />

            {(result.metrics?.signal_metrics?.ici_ms?.length ?? 0) >= 1 && (
              <div className="bg-[#1c2226] border border-[#3a444a] rounded-xl p-4 flex flex-col gap-3">
                <h3 className="text-[10px] uppercase tracking-widest text-[#8fa3ad]">
                  Log this clip's rhythm as an acoustic event
                </h3>
                <p className="text-[11px] text-[#5a6a72]">
                  Saves the timing pattern above plus whatever behavioral context you tag here, shared
                  with the channel — not the audio itself. Builds a comparable record over time, not a
                  translation of what it means.
                </p>
                <input
                  type="text"
                  value={logLabel}
                  onChange={(e) => setLogLabel(e.target.value)}
                  placeholder="Label (e.g. coda near feeding site)"
                  className="w-full bg-black/20 border border-[#3a444a] rounded-lg px-3 py-2 text-sm text-[#d3dbe0] placeholder-[#5a6a72] outline-none focus:border-[#8fa3ad]"
                />
                <BehavioralContextForm context={logContext} onChange={setLogContext} />
                {logError && <p className="text-xs text-[#c47a6e]">{logError}</p>}
                <button
                  type="button"
                  onClick={handleLogEvent}
                  disabled={logging}
                  className="self-start bg-[#8fa3ad]/10 border border-[#8fa3ad]/60 rounded-lg px-4 py-2 text-xs uppercase tracking-widest text-[#d3dbe0] hover:bg-[#8fa3ad]/20 transition disabled:opacity-40"
                >
                  {logging ? "Saving…" : "Save as acoustic event"}
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="bg-[#1c2226] border border-[#3a444a] rounded-xl overflow-hidden">
        <h3 className="text-[10px] uppercase tracking-widest text-[#8fa3ad] px-4 pt-3 pb-2">
          Logged acoustic events — select two to compare rhythm
        </h3>
        {loadingEvents && <p className="px-4 pb-4 text-xs text-[#5a6a72]">Loading…</p>}
        {!loadingEvents && events.length === 0 && (
          <p className="px-4 pb-4 text-xs text-[#5a6a72]">
            No events logged yet — analyze a clip above, then save it with behavioral context.
          </p>
        )}
        {events.map((ev) => {
          const selected = selectedEventIds.includes(ev.id);
          return (
            <div
              key={ev.id}
              className={`flex items-center justify-between gap-3 px-4 py-2.5 border-b border-[#3a444a]/50 transition ${
                selected ? "bg-[#8fa3ad]/12" : ""
              }`}
            >
              <label className="flex items-center gap-2 min-w-0 flex-1 cursor-pointer">
                <input
                  type="checkbox"
                  checked={selected}
                  onChange={() => toggleEventSelected(ev.id)}
                  className="accent-[#8fa3ad] shrink-0"
                />
                <div className="min-w-0">
                  <p className="text-sm text-[#d3dbe0] truncate">{ev.label || "Untitled event"}</p>
                  <p className="text-[10px] text-[#5a6a72] truncate">
                    {ev.rhythm_signature.click_count} clicks
                    {ev.rhythm_signature.mean_ici_ms != null ? ` · ${ev.rhythm_signature.mean_ici_ms.toFixed(0)}ms mean ICI` : ""}
                    {" · "}
                    {contextSummary(ev.context)}
                  </p>
                </div>
              </label>
              <span
                role="button"
                tabIndex={0}
                onClick={() => handleDeleteEvent(ev.id)}
                className="shrink-0 text-[#5a6a72] hover:text-[#c47a6e]"
                aria-label={`Delete ${ev.label || "event"}`}
              >
                <TrashIcon className="w-3.5 h-3.5" />
              </span>
            </div>
          );
        })}
        {events.length > 0 && (
          <div className="px-4 py-3 flex flex-col gap-2">
            <button
              type="button"
              onClick={handleCompareEvents}
              disabled={selectedEventIds.length !== 2 || comparing}
              className="self-start bg-[#8fa3ad]/10 border border-[#8fa3ad]/60 rounded-lg px-4 py-2 text-xs uppercase tracking-widest text-[#d3dbe0] hover:bg-[#8fa3ad]/20 transition disabled:opacity-40"
            >
              {comparing ? "Comparing…" : "Compare selected"}
            </button>
            {compareError && <p className="text-xs text-[#c47a6e]">{compareError}</p>}
            <RhythmComparisonResult result={compareResult} />
          </div>
        )}
      </div>
    </div>
  );
}

// --- Solo mode: session-only, no persisted library -------------------------

function SoloBioacoustics() {
  // Quick metrics — a single clip, no reference needed.
  const [metricsFile, setMetricsFile] = useState(null);
  const [calibrationOffset, setCalibrationOffset] = useState("");
  const [metricsAnalyzing, setMetricsAnalyzing] = useState(false);
  const [metricsResult, setMetricsResult] = useState(null);
  const [metricsError, setMetricsError] = useState(null);
  const metricsInputRef = useRef(null);

  // One-off similarity search — reference + target uploaded together,
  // nothing persisted server-side.
  const [referenceFile, setReferenceFile] = useState(null);
  const [targetFile, setTargetFile] = useState(null);
  const [threshold, setThreshold] = useState(0.6);
  const [searchAnalyzing, setSearchAnalyzing] = useState(false);
  const [searchResult, setSearchResult] = useState(null);
  const [searchError, setSearchError] = useState(null);
  const referenceInputRef = useRef(null);
  const targetInputRef = useRef(null);

  // Rhythm comparison — two in-session "quick metrics" results held in
  // memory for comparison, nothing persisted. This is the solo-mode
  // equivalent of the channel library's saved-event comparison, minus
  // behavioral context tagging (which only makes sense with persistence
  // to attach it to).
  const [slotA, setSlotA] = useState(null); // { label, iciMs } | null
  const [slotB, setSlotB] = useState(null);
  const [comparing, setComparing] = useState(false);
  const [compareResult, setCompareResult] = useState(null);
  const [compareError, setCompareError] = useState(null);

  function saveToSlot(slot) {
    if (!metricsFile || !metricsResult) return;
    const iciMs = metricsResult.metrics?.signal_metrics?.ici_ms || [];
    const entry = { label: metricsFile.name, iciMs };
    if (slot === "a") setSlotA(entry);
    else setSlotB(entry);
    setCompareResult(null);
    setCompareError(null);
  }

  async function handleCompareSlots() {
    if (!slotA || !slotB) return;
    setComparing(true);
    setCompareError(null);
    setCompareResult(null);
    try {
      const cmp = await compareRhythmStandalone({ iciAMs: slotA.iciMs, iciBMs: slotB.iciMs });
      setCompareResult(cmp);
    } catch (err) {
      setCompareError(err.message || "Comparison failed");
    } finally {
      setComparing(false);
    }
  }

  async function handleMetricsFilePicked(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setMetricsFile(file);
    setMetricsAnalyzing(true);
    setMetricsError(null);
    setMetricsResult(null);
    try {
      const form = new FormData();
      form.append("file", file);
      if (calibrationOffset.trim()) {
        form.append("calibration_offset_db", calibrationOffset.trim());
      }
      const res = await fetch(`${API_BASE_URL}/acoustic-metrics`, { method: "POST", body: form });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail || `Metrics request failed (${res.status})`);
      }
      setMetricsResult(await res.json());
    } catch (err) {
      setMetricsError(err.message || "Metrics computation failed");
    } finally {
      setMetricsAnalyzing(false);
    }
  }

  async function handleRunSimilarity() {
    if (!referenceFile || !targetFile) return;
    setSearchAnalyzing(true);
    setSearchError(null);
    setSearchResult(null);
    try {
      const form = new FormData();
      form.append("reference_file", referenceFile);
      form.append("target_file", targetFile);
      form.append("threshold", String(threshold));
      const res = await fetch(`${API_BASE_URL}/acoustic-similarity`, { method: "POST", body: form });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail || `Similarity search failed (${res.status})`);
      }
      setSearchResult(await res.json());
    } catch (err) {
      setSearchError(err.message || "Similarity search failed");
    } finally {
      setSearchAnalyzing(false);
    }
  }

  return (
    <div className="h-full overflow-y-auto px-4 sm:px-6 py-5 flex flex-col gap-5 max-w-2xl mx-auto">
      <p className="text-[11px] text-[#5a6a72] -mb-1">
        Solo mode — nothing here is saved. Open this from inside a Team Workspace channel instead
        for a persisted, shared reference-sound library.
      </p>

      <div className="bg-[#1c2226] border border-[#3a444a] rounded-xl p-4 flex flex-col gap-3">
        <h3 className="text-[10px] uppercase tracking-widest text-[#8fa3ad]">Quick metrics</h3>
        <p className="text-[11px] text-[#5a6a72]">
          Upload one recording for soundscape and signal-level metrics — peak frequency, ICI/PRR, NDSI,
          ACI, ADI/AEI, and level readings. No reference clip needed for this.
        </p>

        <div>
          <label className="text-[10px] uppercase tracking-widest text-[#5a6a72] block mb-1">
            Hydrophone calibration offset (dB, optional)
          </label>
          <input
            type="number"
            step="0.1"
            value={calibrationOffset}
            onChange={(e) => setCalibrationOffset(e.target.value)}
            placeholder="Leave blank for relative (dBFS) levels"
            className="w-full bg-black/20 border border-[#3a444a] rounded-lg px-3 py-2 text-sm text-[#d3dbe0] placeholder-[#5a6a72] outline-none focus:border-[#8fa3ad]"
          />
        </div>

        <input
          ref={metricsInputRef}
          type="file"
          accept="audio/*,video/*"
          onChange={handleMetricsFilePicked}
          className="hidden"
        />
        <button
          type="button"
          onClick={() => metricsInputRef.current?.click()}
          disabled={metricsAnalyzing}
          className="self-start bg-[#8fa3ad]/10 border border-[#8fa3ad]/60 rounded-lg px-4 py-2 text-xs uppercase tracking-widest text-[#d3dbe0] hover:bg-[#8fa3ad]/20 transition disabled:opacity-40"
        >
          {metricsAnalyzing ? "Analyzing…" : metricsFile ? "Choose a different clip" : "Choose a clip"}
        </button>

        {metricsError && <p className="text-xs text-[#c47a6e]">{metricsError}</p>}
        {metricsResult && (
          <div className="mt-1 border-t border-[#3a444a] pt-3 flex flex-col gap-3">
            <p className="text-[11px] text-[#a48a55] mb-2">{metricsResult.warning}</p>
            <SoundscapeMetrics metrics={metricsResult.metrics} durationSeconds={metricsResult.duration_seconds} />
            {(metricsResult.metrics?.signal_metrics?.ici_ms?.length ?? 0) >= 1 && (
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => saveToSlot("a")}
                  className="flex-1 bg-white/[0.04] border border-[#3a444a] rounded-lg px-3 py-2 text-[10px] uppercase tracking-widest text-[#b7c4cc] hover:bg-white/[0.08]"
                >
                  Save as Clip A for comparison
                </button>
                <button
                  type="button"
                  onClick={() => saveToSlot("b")}
                  className="flex-1 bg-white/[0.04] border border-[#3a444a] rounded-lg px-3 py-2 text-[10px] uppercase tracking-widest text-[#b7c4cc] hover:bg-white/[0.08]"
                >
                  Save as Clip B for comparison
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {(slotA || slotB) && (
        <div className="bg-[#1c2226] border border-[#3a444a] rounded-xl p-4 flex flex-col gap-3">
          <h3 className="text-[10px] uppercase tracking-widest text-[#8fa3ad]">Rhythm comparison</h3>
          <p className="text-[11px] text-[#5a6a72]">
            Compares click-train timing structure between two clips analyzed above — not saved
            anywhere, just held in this session.
          </p>
          <div className="grid grid-cols-2 gap-3">
            <div className="bg-black/20 border border-[#3a444a] rounded-lg px-3 py-2">
              <p className="text-[10px] uppercase tracking-widest text-[#5a6a72] mb-1">Clip A</p>
              <p className="text-sm text-[#d3dbe0] truncate">{slotA ? slotA.label : "not set"}</p>
            </div>
            <div className="bg-black/20 border border-[#3a444a] rounded-lg px-3 py-2">
              <p className="text-[10px] uppercase tracking-widest text-[#5a6a72] mb-1">Clip B</p>
              <p className="text-sm text-[#d3dbe0] truncate">{slotB ? slotB.label : "not set"}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={handleCompareSlots}
            disabled={!slotA || !slotB || comparing}
            className="self-start bg-[#8fa3ad]/10 border border-[#8fa3ad]/60 rounded-lg px-4 py-2 text-xs uppercase tracking-widest text-[#d3dbe0] hover:bg-[#8fa3ad]/20 transition disabled:opacity-40"
          >
            {comparing ? "Comparing…" : "Compare A vs B"}
          </button>
          {compareError && <p className="text-xs text-[#c47a6e]">{compareError}</p>}
          <RhythmComparisonResult result={compareResult} />
        </div>
      )}

      <div className="bg-[#1c2226] border border-[#3a444a] rounded-xl p-4 flex flex-col gap-3">
        <h3 className="text-[10px] uppercase tracking-widest text-[#8fa3ad]">One-off similarity search</h3>
        <p className="text-[11px] text-[#5a6a72]">
          Upload a short reference clip of a known sound, plus the recording to search — both in this
          one request. Nothing is saved; do this again next time with the same reference clip.
        </p>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <input
              ref={referenceInputRef}
              type="file"
              accept="audio/*,video/*"
              onChange={(e) => {
                setReferenceFile(e.target.files?.[0] || null);
                e.target.value = "";
              }}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => referenceInputRef.current?.click()}
              className="w-full bg-white/[0.04] border border-[#3a444a] rounded-lg px-3 py-2 text-xs uppercase tracking-widest text-[#b7c4cc] hover:bg-white/[0.08] truncate"
            >
              {referenceFile ? referenceFile.name : "Reference clip"}
            </button>
          </div>
          <div>
            <input
              ref={targetInputRef}
              type="file"
              accept="audio/*,video/*"
              onChange={(e) => {
                setTargetFile(e.target.files?.[0] || null);
                e.target.value = "";
              }}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => targetInputRef.current?.click()}
              className="w-full bg-white/[0.04] border border-[#3a444a] rounded-lg px-3 py-2 text-xs uppercase tracking-widest text-[#b7c4cc] hover:bg-white/[0.08] truncate"
            >
              {targetFile ? targetFile.name : "Recording to search"}
            </button>
          </div>
        </div>

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

        <button
          type="button"
          onClick={handleRunSimilarity}
          disabled={!referenceFile || !targetFile || searchAnalyzing}
          className="self-start bg-[#8fa3ad]/10 border border-[#8fa3ad]/60 rounded-lg px-4 py-2 text-xs uppercase tracking-widest text-[#d3dbe0] hover:bg-[#8fa3ad]/20 transition disabled:opacity-40"
        >
          {searchAnalyzing ? "Analyzing…" : "Run search"}
        </button>

        {searchAnalyzing && (
          <p className="text-[11px] text-[#5a6a72]">
            Running on CPU — this can take a minute or more depending on clip length.
          </p>
        )}

        {searchError && <p className="text-xs text-[#c47a6e]">{searchError}</p>}

        {searchResult && (
          <div className="mt-2 border-t border-[#3a444a] pt-3">
            <p className="text-[11px] text-[#a48a55] mb-2">{searchResult.warning}</p>
            <p className="text-[11px] text-[#5a6a72] mb-2">
              {searchResult.windows_analyzed} window{searchResult.windows_analyzed === 1 ? "" : "s"} analyzed ·{" "}
              {searchResult.matches.length} match{searchResult.matches.length === 1 ? "" : "es"} above threshold
            </p>
            {searchResult.matches.length === 0 ? (
              <p className="text-xs text-[#5a6a72]">No similar moments found at this sensitivity.</p>
            ) : (
              <div className="flex flex-col gap-1">
                {searchResult.matches.map((m, i) => (
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

/**
 * Bioacoustics section for Mission Control — a peer to the ROV feed and
 * Bathymetry map view modes, not a Workspace-only tab anymore.
 *
 * With a channelId (Mission Control embedded inside a Team Workspace
 * channel): full persisted reference-sound library, shared with the
 * channel, same as before — just relocated.
 *
 * Without one (standalone "/" Mission Control): session-only — quick
 * metrics on a single clip, and one-off similarity search with both
 * clips uploaded together. Nothing persists, matching the rest of this
 * standalone view's session-only controls (confidence slider, etc.).
 */
export default function BioacousticsPanel({ channelId, currentEmail }) {
  if (channelId) {
    return <EmbeddedBioacoustics channelId={channelId} currentEmail={currentEmail} />;
  }
  return <SoloBioacoustics />;
}