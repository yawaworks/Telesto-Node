"use client";

// Drop into the Clip Library grid, e.g.:
//   {myClips.map((clip) => <ClipCard key={clip._id} clip={clip} />)}
//
// Expects clip: { thumbnailUrl?, duration, tag, verified, date }

export default function ClipCard({ clip }) {
  const { duration, tag, verified = true, date } = clip || {};

  return (
    <div className="bg-[#1c2226] border border-[#3a444a] rounded-lg overflow-hidden font-mono">
      <div className="h-20 bg-[#262f34] flex items-center justify-center relative text-[#7a8892]">
        <span className="text-xl">▶</span>
        {duration && (
          <span className="absolute bottom-1 right-1.5 text-[9px] text-[#b7c4cc]">{duration}</span>
        )}
      </div>
      <div className="px-2.5 py-2">
        <span
          className={`inline-block text-[9px] rounded-full px-2 py-0.5 mb-1.5 ${
            verified
              ? "text-[#8fa3ad] border border-[#5a6a72]"
              : "text-[#d8b877] border border-dashed border-[#a48a55]"
          }`}
        >
          {tag}
        </span>
        <div className="text-[10px] text-[#7a8892]">{date}</div>
      </div>
    </div>
  );
}

export function EmptyClipSlot() {
  return (
    <div className="border border-dashed border-[#3a444a] rounded-lg flex items-center justify-center min-h-[140px]">
      <span className="text-[11px] text-[#5a6a72] font-mono">no clips logged</span>
    </div>
  );
}