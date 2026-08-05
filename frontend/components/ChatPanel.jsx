"use client";

import { useEffect, useRef, useState } from "react";
import { useChannelMessages } from "../lib/useChannelMessages";

function formatTime(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

export default function ChatPanel({ channelId, currentEmail }) {
  const { messages, loading, error, sendMessage } = useChannelMessages(channelId, currentEmail);
  const [draft, setDraft] = useState("");
  const bottomRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  function handleSend() {
    if (!draft.trim()) return;
    sendMessage(draft);
    setDraft("");
  }

  function handleKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-4 flex flex-col gap-3">
        {loading && <p className="text-xs text-[#5a6a72]">Loading messages…</p>}
        {!loading && messages.length === 0 && (
          <p className="text-xs text-[#5a6a72]">
            No messages yet — say hello to your team.
          </p>
        )}
        {messages.map((m) => {
          const isMe = m.sender_email === currentEmail;
          return (
            <div
              key={m.id}
              className={`max-w-[80%] sm:max-w-[60%] rounded-xl px-3.5 py-2.5 ${
                isMe
                  ? "self-end bg-[#8fa3ad]/15 border border-[#8fa3ad]/30"
                  : "self-start bg-[#1c2226] border border-[#3a444a]"
              }`}
            >
              {!isMe && (
                <p className="text-[10px] uppercase tracking-widest text-[#8fa3ad] mb-1">
                  {m.sender_email}
                </p>
              )}
              <p className="text-sm text-[#d3dbe0] whitespace-pre-wrap break-words">{m.text}</p>
              <p className="text-[10px] text-[#5a6a72] mt-1 text-right">{formatTime(m.created_at)}</p>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      {error && <p className="px-4 sm:px-6 text-xs text-[#c47a6e] pb-1">{error}</p>}

      <div className="border-t border-[#3a444a] px-4 sm:px-6 py-3 flex items-end gap-3">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={1}
          placeholder="Message the channel…"
          className="flex-1 bg-black/20 border border-[#3a444a] rounded-lg px-3 py-2 text-sm text-[#d3dbe0] placeholder-[#5a6a72] outline-none focus:border-[#8fa3ad] resize-none"
        />
        <button
          type="button"
          onClick={handleSend}
          disabled={!draft.trim()}
          className="bg-[#8fa3ad]/10 border border-[#8fa3ad]/60 rounded-lg px-4 py-2 text-xs uppercase tracking-widest text-[#d3dbe0] hover:bg-[#8fa3ad]/20 transition disabled:opacity-40"
        >
          Send
        </button>
      </div>
    </div>
  );
}