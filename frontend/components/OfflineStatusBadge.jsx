"use client";

import { useOnlineStatus } from "../lib/useOnlineStatus";
import { useOfflineQueueCount } from "../lib/useOfflineQueue";

/**
 * Visible connectivity + pending-sync indicator. Deliberately always
 * shown, not just when offline — silently going offline with no
 * indication at all is exactly the kind of "looks fine, isn't" failure
 * this app avoids everywhere else (see the measured-vs-simulated
 * telemetry styling). A researcher should always be able to glance at
 * this and know whether what they're doing right now is reaching the
 * backend or only being recorded locally.
 */
export default function OfflineStatusBadge({ className = "" }) {
  const online = useOnlineStatus();
  const { count } = useOfflineQueueCount();

  return (
    <div
      className={`flex items-center gap-1.5 border rounded-lg px-2.5 py-1.5 text-[10px] uppercase tracking-widest whitespace-nowrap ${
        online
          ? "bg-white/[0.04] border-[#3a444a] text-[#5a6a72]"
          : "bg-[#a48a55]/10 border-[#a48a55]/60 text-[#a48a55]"
      } ${className}`}
      title={
        online
          ? "Connected — actions save directly to the backend"
          : "Offline — actions are queued locally and will sync when connectivity returns"
      }
    >
      <span className={`w-1.5 h-1.5 rounded-full ${online ? "bg-[#7fb37f]" : "bg-[#a48a55] animate-pulse"}`} />
      {online ? "Online" : "Offline"}
      {count > 0 && <span>· {count} pending</span>}
    </div>
  );
}