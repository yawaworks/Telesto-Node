"use client";

import { useState } from "react";

export default function ForwardMessageModal({ channels, currentChannelId, onClose, onForward }) {
  const [targetId, setTargetId] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);

  const options = channels.filter((c) => c.id !== currentChannelId);

  async function handleForward() {
    if (!targetId) {
      setError("Pick a channel first");
      return;
    }
    setSending(true);
    setError(null);
    try {
      await onForward(targetId);
      onClose();
    } catch (err) {
      setError(err.message || "Couldn't forward that message");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 px-4">
      <div className="w-full max-w-sm bg-[#1c2226] border border-[#3a444a] rounded-xl p-5 flex flex-col gap-4">
        <h2 className="text-sm uppercase tracking-widest text-[#d3dbe0]">Forward message</h2>

        {options.length === 0 ? (
          <p className="text-xs text-[#5a6a72]">You're not in any other channels to forward this to.</p>
        ) : (
          <div className="flex flex-col gap-1.5 max-h-56 overflow-y-auto">
            {options.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => setTargetId(c.id)}
                className={`text-left px-3 py-2 rounded-lg text-sm ${
                  targetId === c.id
                    ? "bg-[#8fa3ad]/15 text-[#d3dbe0] border border-[#8fa3ad]/40"
                    : "text-[#b7c4cc] hover:bg-white/[0.05] border border-transparent"
                }`}
              >
                # {c.name}
              </button>
            ))}
          </div>
        )}

        {error && <p className="text-xs text-[#c47a6e]">{error}</p>}

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onClose}
            disabled={sending}
            className="flex-1 border border-[#3a444a] rounded-lg px-4 py-2 text-xs uppercase tracking-widest text-[#b7c4cc] hover:bg-white/[0.08] disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleForward}
            disabled={sending || options.length === 0}
            className="flex-1 bg-[#8fa3ad]/10 border border-[#8fa3ad]/60 rounded-lg px-4 py-2 text-xs uppercase tracking-widest text-[#d3dbe0] hover:bg-[#8fa3ad]/20 transition disabled:opacity-40"
          >
            {sending ? "Forwarding…" : "Forward"}
          </button>
        </div>
      </div>
    </div>
  );
}