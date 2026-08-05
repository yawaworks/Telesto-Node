"use client";

import Link from "next/link";
import Avatar from "./Avatar";

function BrandMark() {
  // Same inline-SVG language as the onboarding tour icons (targeting
  // reticle), so the rail reads as part of Telesto rather than a
  // borrowed icon set.
  return (
    <svg viewBox="0 0 64 64" className="w-6 h-6" fill="none">
      <circle cx="32" cy="32" r="22" stroke="#8fa3ad" strokeWidth="3" />
      <circle cx="32" cy="32" r="4" fill="#8fa3ad" />
      <path d="M32 4v10M32 50v10M4 32h10M50 32h10" stroke="#5a6a72" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export default function AppRail({ email }) {
  return (
    <div className="w-14 shrink-0 bg-[#12161a] border-r border-[#3a444a] flex flex-col items-center py-3 h-full">
      <Link
        href="/"
        title="Mission Control (full screen)"
        className="w-10 h-10 flex items-center justify-center rounded-lg hover:bg-white/[0.06] transition"
      >
        <BrandMark />
      </Link>

      <div className="w-6 h-px bg-[#3a444a] my-3" />

      <div
        className="relative w-10 h-10 flex items-center justify-center rounded-lg bg-[#8fa3ad]/15"
        title="Workspace"
      >
        <span className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-full bg-[#8fa3ad]" />
        <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none">
          <path
            d="M4 6h16M4 12h16M4 18h10"
            stroke="#d3dbe0"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
      </div>

      <div className="flex-1" />

      <Link href="/profile" title="Your profile" className="rounded-full hover:ring-2 hover:ring-[#8fa3ad]/40 transition">
        <Avatar email={email} size="md" online={Boolean(email)} />
      </Link>
    </div>
  );
}