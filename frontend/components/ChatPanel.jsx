"use client";

import { useEffect, useRef, useState } from "react";
import { useChannelMessages } from "../lib/useChannelMessages";
import Avatar from "./Avatar";

const GROUP_WINDOW_MS = 5 * 60 * 1000; // messages within 5 minutes of the same sender collapse into one group

function formatTime(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

function isSameGroup(a, b) {
  if (!a || !b) return false;
  if (a.sender_email !== b.sender_email) return false;
  const gap = new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  return gap >= 0 && gap < GROUP_WINDOW_MS;
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
      <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-4 flex flex-col">
        {loading && <p className="text-xs text-[#5a6a72]">Loading messages…</p>}
        {!loading && messages.length === 0 && (
          <p className="text-xs text-[#5a6a72]">No messages yet — say hello to your team.</p>
        )}
        {messages.map((m, i) => {
          const prev = messages[i - 1];
          const grouped = isSameGroup(prev, m);
          const isMe = m.sender_email === currentEmail;

          return (
            <div
              key={m.id}
              className={`group flex gap-3 px-2 -mx-2 rounded-lg hover:bg-white/[0.03] ${
                grouped ? "py-0.5" : "pt-3 pb-0.5"
              }`}
            >
              <div className="w-8 shrink-0 flex items-start justify-center pt-0.5">
                {!grouped && <Avatar email={m.sender_email} size="sm" />}
                {grouped && (
                  <span className="hidden group-hover:block text-[9px] text-[#5a6a72] pt-1">
                    {formatTime(m.created_at)}
                  </span>
                )}
              </div>
              <div className="min-w-0 flex-1">
                {!grouped && (
                  <p className="flex items-baseline gap-2 mb-0.5">
                    <span className="text-xs font-bold text-[#d3dbe0]">
                      {isMe ? "You" : m.sender_email}
                    </span>
                    <span className="text-[10px] text-[#5a6a72]">{formatTime(m.created_at)}</span>
                  </p>
                )}
                <p className="text-sm text-[#b7c4cc] whitespace-pre-wrap break-words leading-relaxed">
                  {m.text}
                </p>
              </div>
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