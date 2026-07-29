"use client";

// Drop into app/page.js near the MapLibre container, e.g.:
//   <div ref={mapContainerRef} className="relative ...">
//     <MapLegend />
//   </div>

export default function MapLegend() {
  return (
    <div className="absolute bottom-3 left-3 flex gap-3.5 font-mono pointer-events-none">
      <div className="flex items-center gap-1">
        <span className="w-1.5 h-1.5 rounded-full bg-[#8fa3ad]" />
        <span className="text-[10px] text-[#b7c4cc]">verified sighting</span>
      </div>
      <div className="flex items-center gap-1">
        <span className="w-1.5 h-1.5 rounded-full bg-[#a48a55]" />
        <span className="text-[10px] text-[#d8b877]">unvalidated detection</span>
      </div>
    </div>
  );
}