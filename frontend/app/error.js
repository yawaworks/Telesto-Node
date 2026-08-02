"use client";

import { useEffect } from "react";

export default function GlobalError({ error, reset }) {
  useEffect(() => {
    // Logged so it's still visible in the console/error tracking even
    // though the user now sees a friendly recovery screen instead of a
    // blank crash page.
    console.error("Unhandled client error:", error);
  }, [error]);

  return (
    <div className="min-h-screen bg-[#171d20] text-[#d3dbe0] flex items-center justify-center font-mono text-sm px-4">
      <div className="w-full max-w-sm bg-[#1c2226] border border-[#3a444a] rounded-xl p-8 text-center">
        <p className="text-sm text-[#d8877a] mb-2">Something went wrong</p>
        <p className="text-xs text-[#8fa3ad] mb-6">
          This screen hit an unexpected error. Your data is safe — this only affects the current
          view.
        </p>
        <button
          onClick={() => reset()}
          className="bg-[#8fa3ad]/10 border border-[#8fa3ad]/60 rounded-lg px-4 py-2 text-xs uppercase tracking-widest text-[#d3dbe0] hover:bg-[#8fa3ad]/20 transition"
        >
          Try again
        </button>
      </div>
    </div>
  );
}