"use client";

import { useState } from "react";
import Avatar, { STATUS_LABELS } from "./Avatar";

const OPTIONS = ["active", "away", "busy", "offline"];

export default function StatusPicker({ email, status, onChange }) {
  const [open, setOpen] = useState(false);
  const effective = status || "active";

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="rounded-full hover:ring-2 hover:ring-[#8fa3ad]/40 transition"
        title={`You're ${STATUS_LABELS[effective]}`}
      >
        <Avatar email={email} size="md" status={effective} />
      </button>

      {open && (
        <>
          {/* Click-outside catcher */}
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute left-full ml-2 bottom-0 z-50 w-36 bg-[#1c2226] border border-[#3a444a] rounded-lg overflow-hidden shadow-lg">
            {OPTIONS.map((opt) => (
              <button
                key={opt}
                type="button"
                onClick={() => {
                  onChange(opt);
                  setOpen(false);
                }}
                className={`w-full flex items-center gap-2 px-3 py-2 text-xs text-left hover:bg-white/[0.06] ${
                  opt === effective ? "text-[#d3dbe0]" : "text-[#b7c4cc]"
                }`}
              >
                <span
                  className="w-2 h-2 rounded-full shrink-0"
                  style={{
                    backgroundColor:
                      { active: "#7fb37f", away: "#a48a55", busy: "#c47a6e", offline: "#3a444a" }[opt],
                  }}
                />
                {STATUS_LABELS[opt]}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}