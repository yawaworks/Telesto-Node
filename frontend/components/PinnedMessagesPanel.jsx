"use client";

import { useEffect, useState } from "react";
import { listPinnedMessages } from "../lib/workspaceApi";

export default function PinnedMessagesPanel({ channelId, requesterEmail, onClose, onUnpin }) {
  const [pinned, setPinned] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    listPinnedMessages(channelId, requesterEmail)
      .then((result) => {
        if (!cancelled) setPinned(result);
      })
      .catch((err) => console.error("Failed to load pinned messages:", err))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [channelId, requesterEmail]);

  async function handleUnpin(message) {
    try {
      await onUnpin(message);
      setPinned((prev) => prev.filter((m) => m.id !== message.id));
    } catch (err) {
      console.error("Unpin failed:", err);
    }
  }

  return (
    <div className="absolute left-0 right-0 top-full z-30 bg-[#1c2226] border-b border-[#3a444a] shadow-lg max-h-72 overflow-y-auto">
      <div className="px-4 sm:px-6 py-2.5 border-b border-[#3a444a] flex items-center justify-between sticky top-0 bg-[#1c2226]">
        <h3 className="text-[10px] uppercase tracking-widest text-[#8fa3ad]">Pinned messages</h3>
        <button
          type="button"
          onClick={onClose}
          className="text-[#5a6a72] hover:text-[#d3dbe0] text-sm leading-none"
          aria-label="Close pinned messages"
        >
          ✕
        </button>
      </div>

      {loading && <p className="px-4 sm:px-6 py-3 text-xs text-[#5a6a72]">Loading…</p>}
      {!loading && pinned.length === 0 && (
        <p className="px-4 sm:px-6 py-3 text-xs text-[#5a6a72]">Nothing pinned in this channel yet.</p>
      )}
      {pinned.map((m) => (
        <div key={m.id} className="px-4 sm:px-6 py-2.5 border-b border-[#3a444a]/50 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-bold text-[#d3dbe0]">{m.sender_email}</p>
            <p className="text-xs text-[#b7c4cc] truncate">{m.text || "(attachment)"}</p>
          </div>
          <button
            type="button"
            onClick={() => handleUnpin(m)}
            className="shrink-0 text-[10px] uppercase tracking-widest text-[#5a6a72] hover:text-[#c47a6e]"
          >
            Unpin
          </button>
        </div>
      ))}
    </div>
  );
}