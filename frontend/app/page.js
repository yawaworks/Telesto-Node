"use client";

import { useEffect, useRef, useState } from "react";
import { initGamepadNavigation } from "../lib/gamepad-controller";
import { initBathymetryMap } from "../lib/bathymetry-map";

export default function MissionControl() {
  const videoRef = useRef(null);
  const mapContainerRef = useRef(null);
  const [telemetry, setTelemetry] = useState({
    depth: "42.6 m",
    coords: "11.3500 N, 144.2400 E",
    temp: "17.2°C",
    salinity: "34.9 PSU",
    heading: "086°",
  });
  const [alert, setAlert] = useState(false);

  useEffect(() => {
    const map = initBathymetryMap(mapContainerRef.current);
    const cleanupGamepad = initGamepadNavigation({ videoElement: videoRef.current, map });

    return () => {
      cleanupGamepad?.();
      map?.remove?.();
    };
  }, []);

  return (
    <div className="relative w-full h-screen overflow-hidden bg-black text-cyan-200">
      {/* ROV video feed */}
      <video
        ref={videoRef}
        id="feed"
        className="absolute inset-0 w-full h-full object-cover"
        autoPlay
        muted
      />

      {/* 3D bathymetry map */}
      <div ref={mapContainerRef} className="absolute inset-0 w-full h-full" />

      {/* Glassmorphism HUD overlay */}
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute top-4 left-4 backdrop-blur-md bg-white/5 border border-cyan-400/30 rounded-xl px-4 py-2 shadow-[0_0_15px_rgba(34,211,238,0.25)]">
          <p className="text-xs uppercase tracking-widest text-cyan-400">Depth</p>
          <p className="text-2xl font-bold">{telemetry.depth}</p>
        </div>

        <div className="absolute top-4 right-4 backdrop-blur-md bg-white/5 border border-cyan-400/30 rounded-xl px-4 py-2 text-right">
          <p className="text-xs uppercase tracking-widest text-cyan-400">Coordinates</p>
          <p className="text-sm">{telemetry.coords}</p>
        </div>

        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 backdrop-blur-md bg-white/5 border border-cyan-400/30 rounded-xl px-6 py-2 flex gap-6">
          <span>
            TEMP <span className="text-cyan-300">{telemetry.temp}</span>
          </span>
          <span>
            SALINITY <span className="text-cyan-300">{telemetry.salinity}</span>
          </span>
          <span>
            HEADING <span className="text-cyan-300">{telemetry.heading}</span>
          </span>
        </div>

        {/* Targeting reticle */}
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-16 h-16 border border-cyan-400/60 rounded-full animate-pulse" />

        {/* Live alert badge */}
        {alert && (
          <div className="absolute bottom-4 right-4 backdrop-blur-md bg-red-500/10 border border-red-400/50 text-red-300 rounded-xl px-4 py-2 animate-pulse">
            ⚠ Coral Bleaching Detected
          </div>
        )}
      </div>

      {/* CRT scanline texture */}
      <div className="crt-scanlines absolute inset-0 pointer-events-none opacity-10" />
    </div>
  );
}