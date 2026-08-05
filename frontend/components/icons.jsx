"use client";

// Small UI icons in the same stroke-based, currentColor style as the
// onboarding tour icons and AppRail's brand mark — kept deliberately
// plain (no fill, no color of their own) so they read as instrumentation,
// not decoration, appropriate for a tool researchers use professionally.

const base = { viewBox: "0 0 24 24", fill: "none" };

export function PaperclipIcon({ className = "w-3.5 h-3.5" }) {
  return (
    <svg {...base} className={className} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17.5 8.5l-7 7a3 3 0 004.24 4.24l7.02-7.02a5 5 0 00-7.07-7.07L7.5 12.84a7 7 0 009.9 9.9" />
    </svg>
  );
}

export function MicIcon({ className = "w-3.5 h-3.5" }) {
  return (
    <svg {...base} className={className} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0014 0M12 18v3" />
    </svg>
  );
}

export function PinIcon({ className = "w-3.5 h-3.5" }) {
  return (
    <svg {...base} className={className} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 4h6l-1 6 3 3v2H7v-2l3-3-1-6z" />
      <path d="M12 15v5" />
    </svg>
  );
}

export function FlagIcon({ className = "w-3.5 h-3.5" }) {
  return (
    <svg {...base} className={className} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 21V4" />
      <path d="M5 4h13l-3 4 3 4H5" />
    </svg>
  );
}

export function TrashIcon({ className = "w-3.5 h-3.5" }) {
  return (
    <svg {...base} className={className} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" />
    </svg>
  );
}

export function PhoneIcon({ className = "w-3.5 h-3.5" }) {
  return (
    <svg {...base} className={className} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 4h4l1.5 5-2.2 1.7a11 11 0 006 6L15.8 14l5 1.5v4a2 2 0 01-2.2 2A16 16 0 015 6.2 2 2 0 015 4z" />
    </svg>
  );
}

export function ReplyIcon({ className = "w-3.5 h-3.5" }) {
  return (
    <svg {...base} className={className} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 8l-5 4 5 4" />
      <path d="M5 12h9a5 5 0 015 5v1" />
    </svg>
  );
}

export function ForwardIcon({ className = "w-3.5 h-3.5" }) {
  return (
    <svg {...base} className={className} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 8l5 4-5 4" />
      <path d="M19 12h-9a5 5 0 00-5 5v1" />
    </svg>
  );
}