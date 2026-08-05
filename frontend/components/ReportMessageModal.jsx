"use client";

import { useState } from "react";

export default function ReportMessageModal({ onClose, onReport }) {
  const [reason, setReason] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);

  async function handleSubmit() {
    setSending(true);
    setError(null);
    try {
      await onReport(reason.trim());
      onClose();
    } catch (err) {
      setError(err.message || "Couldn't submit the report");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 px-4">
      <div className="w-full max-w-sm bg-[#1c2226] border border-[#3a444a] rounded-xl p-5 flex flex-col gap-4">
        <h2 className="text-sm uppercase tracking-widest text-[#d3dbe0]">Report message</h2>
        <p className="text-[11px] text-[#5a6a72]">
          Sent to this channel's admins for review — the message isn't hidden or changed for anyone
          unless an admin acts on it.
        </p>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={3}
          placeholder="What's wrong with this message? (optional)"
          className="w-full bg-black/20 border border-[#3a444a] rounded-lg px-3 py-2 text-sm text-[#d3dbe0] placeholder-[#5a6a72] outline-none focus:border-[#8fa3ad] resize-none"
        />

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
            onClick={handleSubmit}
            disabled={sending}
            className="flex-1 bg-[#c47a6e]/10 border border-[#c47a6e]/60 rounded-lg px-4 py-2 text-xs uppercase tracking-widest text-[#c47a6e] hover:bg-[#c47a6e]/20 transition disabled:opacity-50"
          >
            {sending ? "Submitting…" : "Submit report"}
          </button>
        </div>
      </div>
    </div>
  );
}