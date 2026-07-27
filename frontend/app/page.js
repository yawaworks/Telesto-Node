"use client";

import { useEffect, useRef, useState } from "react";
import { initGamepadNavigation } from "../lib/gamepad-controller";
import { initBathymetryMap } from "../lib/bathymetry-map";
import { loadSpeciesMarkers } from "../lib/species-markers";
import { useFrameDetection } from "../lib/useFrameDetection";
import { useTelemetry } from "../lib/useTelemetry";
import DetectionOverlay from "../components/DetectionOverlay";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:5050";
const BLEACHING_ALERT_THRESHOLD = 0.4;
const DEFAULT_SPECIES = "Acropora cervicornis";

export default function MissionControl() {
  const videoRef = useRef(null);
  const mapContainerRef = useRef(null);
  const mapRef = useRef(null);
  const { telemetry } = useTelemetry();
  const [speciesQuery, setSpeciesQuery] = useState(DEFAULT_SPECIES);
  const [viewMode, setViewMode] = useState("video");
  const [exportingReport, setExportingReport] = useState(false);

  const { boxes, coralBleachingRatio, status } = useFrameDetection(videoRef, {
    enabled: viewMode === "video",
  });

  const alert =
    coralBleachingRatio !== null && coralBleachingRatio >= BLEACHING_ALERT_THRESHOLD;

  useEffect(() => {
    const map = initBathymetryMap(mapContainerRef.current);
    mapRef.current = map;
    const cleanupGamepad = initGamepadNavigation({ videoElement: videoRef.current, map });

    if (map) {
      map.on("load", () => {
        loadSpeciesMarkers(map, DEFAULT_SPECIES);
      });
    }

    return () => {
      cleanupGamepad?.();
      map?.remove?.();
    };
  }, []);

  function handleSpeciesSearch(e) {
    e.preventDefault();
    if (mapRef.current) {
      loadSpeciesMarkers(mapRef.current, speciesQuery);
    }
  }

  async function handleExportReport() {
    setExportingReport(true);
    try {
      const params = new URLSearchParams(telemetry);
      const response = await fetch(`${API_BASE_URL}/export-report?${params}`);
      if (!response.ok) throw new Error(`Export failed: ${response.status}`);

      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "telesto-node-mission-report.pdf";
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
    } catch (err) {
      console.error("Report export failed:", err);
    } finally {
      setExportingReport(false);
    }
  }

  const isMapMode = viewMode === "map";

  return (
    <div className="relative w-full h-screen overflow-hidden bg-black text-cyan-200">
      <video
        ref={videoRef}
        id="feed"
        className="absolute inset-0 w-full h-full object-cover"
        src="/rov-feed.mp4"
        autoPlay
        muted
        loop
        playsInline
        style={{ opacity: isMapMode ? 0 : 1 }}
      />

      <DetectionOverlay videoRef={videoRef} boxes={isMapMode ? [] : boxes} />

      <div
        ref={mapContainerRef}
        className="absolute inset-0 w-full h-full"
        style={{
          opacity: isMapMode ? 1 : 0,
          pointerEvents: isMapMode ? "auto" : "none",
        }}
      />

      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute top-4 left-4 backdrop-blur-md bg-white/5 border border-cyan-400/30 rounded-xl px-4 py-2 shadow-[0_0_15px_rgba(34,211,238,0.25)]">
          <p className="text-xs uppercase tracking-widest text-cyan-400">Depth</p>
          <p className="text-2xl font-bold">{telemetry.depth}</p>
        </div>

        <div className="absolute top-4 right-4 backdrop-blur-md bg-white/5 border border-cyan-400/30 rounded-xl px-4 py-2 text-right">
          <p className="text-xs uppercase tracking-widest text-cyan-400">Coordinates</p>
          <p className="text-sm">{telemetry.coords}</p>
        </div>

        <div className="absolute top-4 left-1/2 -translate-x-1/2 pointer-events-auto flex gap-2">
          <button
            onClick={() => setViewMode("video")}
            className={`backdrop-blur-md border rounded-xl px-4 py-1 text-xs uppercase tracking-widest ${
              !isMapMode
                ? "bg-cyan-400/20 border-cyan-400/60"
                : "bg-white/5 border-cyan-400/30 hover:bg-white/10"
            }`}
          >
            ROV Feed
          </button>
          <button
            onClick={() => setViewMode("map")}
            className={`backdrop-blur-md border rounded-xl px-4 py-1 text-xs uppercase tracking-widest ${
              isMapMode
                ? "bg-cyan-400/20 border-cyan-400/60"
                : "bg-white/5 border-cyan-400/30 hover:bg-white/10"
            }`}
          >
            Bathymetry Map
          </button>
        </div>

        {!isMapMode && (
          <div className="absolute top-16 left-1/2 -translate-x-1/2 backdrop-blur-md bg-white/5 border border-cyan-400/30 rounded-xl px-4 py-1 flex items-center gap-2">
            <span
              className={`w-2 h-2 rounded-full ${
                status === "live"
                  ? "bg-green-400 animate-pulse"
                  : status === "error"
                  ? "bg-red-400"
                  : "bg-yellow-400 animate-pulse"
              }`}
            />
            <span className="text-xs uppercase tracking-widest">
              {status === "live" ? "Inference Live" : status === "error" ? "Inference Error" : "Connecting…"}
            </span>
          </div>
        )}

        {isMapMode && (
          <form
            onSubmit={handleSpeciesSearch}
            className="absolute top-16 left-1/2 -translate-x-1/2 pointer-events-auto flex gap-2"
          >
            <input
              type="text"
              value={speciesQuery}
              onChange={(e) => setSpeciesQuery(e.target.value)}
              placeholder="Scientific name (e.g. Acropora cervicornis)"
              className="backdrop-blur-md bg-white/5 border border-cyan-400/30 rounded-lg px-3 py-1 text-xs text-cyan-200 placeholder:text-cyan-200/40 outline-none focus:border-cyan-400/70 w-64"
            />
            <button
              type="submit"
              className="backdrop-blur-md bg-cyan-400/10 border border-cyan-400/30 rounded-lg px-3 py-1 text-xs uppercase tracking-widest hover:bg-cyan-400/20"
            >
              Plot
            </button>
          </form>
        )}

        {/* Export Field Report button */}
        <button
          onClick={handleExportReport}
          disabled={exportingReport}
          className="absolute top-4 right-56 pointer-events-auto backdrop-blur-md bg-cyan-400/10 border border-cyan-400/40 rounded-xl px-4 py-2 text-xs uppercase tracking-widest hover:bg-cyan-400/20 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
        >
          {exportingReport ? (
            <>
              <span className="w-2 h-2 rounded-full bg-cyan-300 animate-pulse" />
              Generating…
            </>
          ) : (
            <>Export Field Report</>
          )}
        </button>

        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 backdrop-blur-md bg-white/5 border border-cyan-400/30 rounded-xl px-6 py-2 flex gap-6">
          <span>
            TEMP <span className="text-cyan-300">{telemetry.temp}</span>
            {telemetry.tempSource === "live" && (
              <span className="ml-1 text-[10px] text-green-400 align-super">LIVE</span>
            )}
          </span>
          <span>
            SALINITY <span className="text-cyan-300">{telemetry.salinity}</span>
          </span>
          <span>
            HEADING <span className="text-cyan-300">{telemetry.heading}</span>
          </span>
          {!isMapMode && coralBleachingRatio !== null && (
            <span>
              CORAL{" "}
              <span className={alert ? "text-red-400" : "text-cyan-300"}>
                {(coralBleachingRatio * 100).toFixed(0)}% bleached
              </span>
            </span>
          )}
        </div>

        {!isMapMode && (
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-16 h-16 border border-cyan-400/60 rounded-full animate-pulse" />
        )}

        {!isMapMode && alert && (
          <div className="absolute bottom-4 right-4 backdrop-blur-md bg-red-500/10 border border-red-400/50 text-red-300 rounded-xl px-4 py-2 animate-pulse">
            ⚠ Coral Bleaching Detected
          </div>
        )}
      </div>

      <div className="crt-scanlines absolute inset-0 pointer-events-none opacity-10" />
    </div>
  );
}