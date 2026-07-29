"use client";

// Presentational overlay for the mission-control video feed.
// Drop into app/page.js alongside <video> and <DetectionOverlay>, e.g.:
//
//   <div className="relative">
//     <video ref={videoRef} ... />
//     <HUDOverlay telemetry={telemetry} alert={alert} boxes={boxes} />
//   </div>

export default function HUDOverlay({ telemetry, alert, boxes = [] }) {
  const { lat, lng, temperature, depth, salinity, heading } = telemetry || {};

  return (
    <div className="absolute inset-0 pointer-events-none font-mono">
      <div className="absolute top-3 left-3 flex items-center gap-1.5 bg-white/[0.06] border border-[#7a8892] rounded-md px-2.5 py-1">
        <span className="w-1.5 h-1.5 rounded-full bg-[#b7c4cc]" />
        <span className="text-[11px] text-[#d3dbe0]">live feed</span>
      </div>

      {alert && (
        <div className="absolute top-3 right-3 flex items-center gap-1.5 bg-[#a48a55]/15 border border-[#b38d47] rounded-md px-2.5 py-1">
          <span className="text-[11px] text-[#d8b877]">possible bleaching — unverified</span>
        </div>
      )}

      {boxes.map((box, i) => (
        <div
          key={i}
          className={`absolute border ${box.confidence < 0.75 ? "border-dashed opacity-70" : ""} border-[#8fa3ad]`}
          style={{ top: box.top, left: box.left, width: box.width, height: box.height }}
        >
          <div className="absolute -top-[30px] left-0 flex flex-col gap-0.5 whitespace-nowrap">
            <span className="text-[10px] text-[#b7c4cc] bg-[#1c2226] px-1">
              {box.label} {box.confidence?.toFixed(2)}
            </span>
            <span className="text-[9px] text-[#d8b877] bg-[#1c2226] px-1">unvalidated model</span>
          </div>
        </div>
      ))}

      <div className="absolute bottom-0 left-0 right-0 px-3.5 py-2 bg-black/40 border-t border-[#b7c4cc]/25">
        <div className="flex justify-between mb-1">
          <span className="text-[9px] tracking-wide text-[#8fa3ad]">measured</span>
          <span className="text-[9px] tracking-wide text-[#a48a55]">simulated</span>
        </div>
        <div className="flex justify-between text-[11px]">
          <span className="text-[#d3dbe0]">TEMP {temperature ?? "—"}°C</span>
          <span className="text-[#d3dbe0]">{lat ?? "—"}, {lng ?? "—"}</span>
          <span className="text-[#a48a55] border-b border-dashed border-[#a48a55]">DEPTH {depth ?? "—"}m</span>
          <span className="text-[#a48a55] border-b border-dashed border-[#a48a55]">SAL {salinity ?? "—"} PSU</span>
          <span className="text-[#a48a55] border-b border-dashed border-[#a48a55]">HDG {heading ?? "—"}°</span>
        </div>
      </div>
    </div>
  );
}