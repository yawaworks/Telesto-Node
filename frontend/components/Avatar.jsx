"use client";

// A small, muted rotation of hues in the same family as the app's existing
// accent (#8fa3ad) — deliberately not saturated brand colors, so avatars
// read as "part of this cockpit" rather than a foreign UI kit pasted in.
const AVATAR_HUES = ["#8fa3ad", "#6e8fa3", "#7f9a8f", "#9a8f7f", "#8f7f9a", "#7f8f9a"];

const STATUS_COLORS = {
  active: "#7fb37f",
  away: "#a48a55",
  busy: "#c47a6e",
  offline: "#3a444a",
};

export const STATUS_LABELS = {
  active: "Active",
  away: "Away",
  busy: "Busy",
  offline: "Offline",
};

function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

function initialsFor(email) {
  const local = (email || "?").split("@")[0];
  const parts = local.split(/[._-]/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return local.slice(0, 2).toUpperCase() || "?";
}

const SIZE_CLASSES = {
  sm: "w-6 h-6 text-[10px]",
  md: "w-8 h-8 text-xs",
  lg: "w-10 h-10 text-sm",
};

/**
 * Deterministic initials avatar — same email always renders the same
 * color, so teammates become visually recognizable across the workspace
 * without needing uploaded profile photos. `status` is one of
 * active/away/busy/offline (see STATUS_COLORS); pass nothing to render a
 * plain avatar with no presence dot at all.
 */
export default function Avatar({ email, size = "md", status = null, ring = false, className = "" }) {
  const color = AVATAR_HUES[hashString(email || "") % AVATAR_HUES.length];
  return (
    <span className={`relative inline-flex shrink-0 ${className}`}>
      <span
        className={`${SIZE_CLASSES[size]} rounded-full flex items-center justify-center font-bold text-[#12161a] ${
          ring ? "ring-2 ring-[#171d20]" : ""
        }`}
        style={{ backgroundColor: color }}
        title={email}
      >
        {initialsFor(email)}
      </span>
      {status && (
        <span
          className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-[#171d20]"
          style={{ backgroundColor: STATUS_COLORS[status] || STATUS_COLORS.offline }}
          title={STATUS_LABELS[status] || "Offline"}
        />
      )}
    </span>
  );
}