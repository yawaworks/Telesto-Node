"use client";

import { useEffect, useState } from "react";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:5050";
const CHART_WIDTH = 440;
const CHART_HEIGHT = 140;
const CHART_PADDING = { top: 10, right: 10, bottom: 24, left: 32 };

function formatPeriodLabel(period) {
  // "2025-03" -> "Mar '25"
  const [year, month] = period.split("-");
  const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${names[parseInt(month, 10) - 1]} '${year.slice(2)}`;
}

/**
 * A small hand-built SVG bar+line chart — this app has no charting
 * library in package.json (recharts/chart.js etc. aren't dependencies
 * here, unlike the sandboxed-artifact environment where they're
 * available), so this is plain SVG rather than pulling in a new
 * dependency for one chart. Bars are species_count per month; the line
 * is mean_bleaching_ratio where readings exist for that month (gaps
 * where there's no bleaching data that period, not interpolated across).
 */
function TrendChart({ trend }) {
  if (trend.length === 0) return null;

  const plotWidth = CHART_WIDTH - CHART_PADDING.left - CHART_PADDING.right;
  const plotHeight = CHART_HEIGHT - CHART_PADDING.top - CHART_PADDING.bottom;
  const maxSpecies = Math.max(1, ...trend.map((t) => t.species_count));
  const barWidth = Math.min(28, (plotWidth / trend.length) * 0.6);
  const step = plotWidth / trend.length;

  const bleachingPoints = trend
    .map((t, i) =>
      t.mean_bleaching_ratio != null
        ? {
            x: CHART_PADDING.left + step * i + step / 2,
            y: CHART_PADDING.top + plotHeight * (1 - t.mean_bleaching_ratio),
          }
        : null
    )
    .filter(Boolean);

  const linePath = bleachingPoints.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ");

  return (
    <svg viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`} className="w-full h-auto">
      {/* Gridlines at 0/50/100% for the bleaching-ratio axis */}
      {[0, 0.5, 1].map((frac) => (
        <line
          key={frac}
          x1={CHART_PADDING.left}
          x2={CHART_WIDTH - CHART_PADDING.right}
          y1={CHART_PADDING.top + plotHeight * (1 - frac)}
          y2={CHART_PADDING.top + plotHeight * (1 - frac)}
          stroke="#3a444a"
          strokeWidth="1"
          strokeDasharray="2,3"
        />
      ))}

      {/* Species-count bars */}
      {trend.map((t, i) => {
        const barHeight = (t.species_count / maxSpecies) * plotHeight;
        const x = CHART_PADDING.left + step * i + (step - barWidth) / 2;
        const y = CHART_PADDING.top + plotHeight - barHeight;
        return (
          <rect
            key={`bar-${t.period}`}
            x={x}
            y={y}
            width={barWidth}
            height={Math.max(1, barHeight)}
            fill="#8fa3ad"
            fillOpacity="0.35"
            rx="1.5"
          />
        );
      })}

      {/* Bleaching-ratio line + points */}
      {bleachingPoints.length > 0 && (
        <path d={linePath} fill="none" stroke="#c47a6e" strokeWidth="1.5" />
      )}
      {bleachingPoints.map((p, i) => (
        <circle key={`pt-${i}`} cx={p.x} cy={p.y} r="2.5" fill="#c47a6e" />
      ))}

      {/* X-axis labels — thin out if there are a lot of months, so labels don't overlap */}
      {trend.map((t, i) => {
        const showEvery = trend.length > 8 ? Math.ceil(trend.length / 8) : 1;
        if (i % showEvery !== 0) return null;
        const x = CHART_PADDING.left + step * i + step / 2;
        return (
          <text
            key={`label-${t.period}`}
            x={x}
            y={CHART_HEIGHT - 6}
            fontSize="8"
            fill="#5a6a72"
            textAnchor="middle"
          >
            {formatPeriodLabel(t.period)}
          </text>
        );
      })}
    </svg>
  );
}

/**
 * Habitat change tracking — species diversity and coral bleaching trend
 * for a location over time, built from the same detection log mission
 * reports use (backend/app/report.py, backend/app/habitat.py). Opened
 * from map mode, centered on wherever the map currently is.
 */
export default function HabitatTrendPanel({ latitude, longitude, currentEmail, onClose }) {
  const [radiusKm, setRadiusKm] = useState(5);
  const [scope, setScope] = useState("team");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [data, setData] = useState(null);

  function fetchTrend() {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({
      latitude: String(latitude),
      longitude: String(longitude),
      radius_km: String(radiusKm),
      scope,
      ...(currentEmail ? { owner_email: currentEmail } : {}),
    });
    fetch(`${API_BASE_URL}/habitat-trend?${params}`)
      .then((res) => {
        if (!res.ok) throw new Error(`Request failed (${res.status})`);
        return res.json();
      })
      .then(setData)
      .catch((err) => setError(err.message || "Couldn't load habitat trend"))
      .finally(() => setLoading(false));
  }

  useEffect(fetchTrend, [latitude, longitude, radiusKm, scope, currentEmail]);

  return (
    <div className="w-full max-w-lg max-h-[85vh] sm:max-h-[75vh] flex flex-col bg-[#1c2226] border border-[#3a444a] rounded-xl overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-[#3a444a]">
        <span className="text-xs uppercase tracking-widest text-[#8fa3ad]">Habitat trend</span>
        <button onClick={onClose} className="text-[#8fa3ad] hover:text-[#d3dbe0] text-sm">
          ✕
        </button>
      </div>

      <div className="px-4 py-3 border-b border-[#3a444a] flex flex-col gap-2">
        <p className="text-[10px] text-[#5a6a72]">
          {latitude.toFixed(3)}, {longitude.toFixed(3)} — centered on the current map view
        </p>
        <div className="flex gap-3">
          <div className="flex-1">
            <label className="text-[10px] uppercase tracking-widest text-[#5a6a72] block mb-1">
              Radius: {radiusKm} km
            </label>
            <input
              type="range"
              min="1"
              max="50"
              step="1"
              value={radiusKm}
              onChange={(e) => setRadiusKm(Number(e.target.value))}
              className="w-full h-1 accent-[#8fa3ad] cursor-pointer"
            />
          </div>
          <div>
            <label className="text-[10px] uppercase tracking-widest text-[#5a6a72] block mb-1">Scope</label>
            <div className="flex gap-1">
              <button
                onClick={() => setScope("team")}
                className={`rounded px-2 py-1 text-[10px] uppercase tracking-widest border ${
                  scope === "team"
                    ? "bg-[#8fa3ad]/20 text-[#d3dbe0] border-[#8fa3ad]/50"
                    : "text-[#8fa3ad] border-transparent hover:text-[#b7c4cc]"
                }`}
              >
                Team
              </button>
              <button
                onClick={() => setScope("mine")}
                className={`rounded px-2 py-1 text-[10px] uppercase tracking-widest border ${
                  scope === "mine"
                    ? "bg-[#8fa3ad]/20 text-[#d3dbe0] border-[#8fa3ad]/50"
                    : "text-[#8fa3ad] border-transparent hover:text-[#b7c4cc]"
                }`}
              >
                Mine
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3 flex flex-col gap-3">
        {loading && <p className="text-xs text-[#5a6a72]">Loading…</p>}
        {error && <p className="text-xs text-[#c47a6e]">{error}</p>}

        {data && !loading && (
          <>
            {data.trend.length === 0 ? (
              <p className="text-xs text-[#5a6a72]">
                No logged detections at this location yet — this trend fills in as missions are
                logged here.
              </p>
            ) : (
              <>
                <TrendChart trend={data.trend} />
                <div className="flex items-center gap-4 text-[9px] uppercase tracking-widest text-[#5a6a72]">
                  <span className="flex items-center gap-1.5">
                    <span className="w-2.5 h-2.5 rounded-sm bg-[#8fa3ad]/35" /> Species detected
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="w-2.5 h-2.5 rounded-full bg-[#c47a6e]" /> Bleaching ratio
                  </span>
                </div>
                <div className="flex flex-col gap-1">
                  {[...data.trend].reverse().map((t) => (
                    <div
                      key={t.period}
                      className="flex items-center justify-between px-3 py-1.5 bg-black/20 border border-[#3a444a] rounded-lg text-xs"
                    >
                      <span className="text-[#b7c4cc]">{formatPeriodLabel(t.period)}</span>
                      <span className="text-[#8fa3ad]">
                        {t.species_count} species
                        {t.mean_bleaching_ratio != null
                          ? ` · ${Math.round(t.mean_bleaching_ratio * 100)}% bleaching`
                          : ""}
                      </span>
                    </div>
                  ))}
                </div>
              </>
            )}
            <p className="text-[10px] text-[#a48a55] leading-relaxed pt-1 border-t border-[#3a444a]">
              {data.warning}
            </p>
          </>
        )}
      </div>
    </div>
  );
}