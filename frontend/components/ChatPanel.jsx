"use client";

import { useEffect, useRef, useState } from "react";
import { useChannelMessages } from "../lib/useChannelMessages";
import { listTranslationLanguages } from "../lib/workspaceApi";
import MessageRow from "./MessageRow";
import MessageComposer from "./MessageComposer";
import ForwardMessageModal from "./ForwardMessageModal";
import ReportMessageModal from "./ReportMessageModal";
import { TranslateIcon } from "./icons";

const GROUP_WINDOW_MS = 5 * 60 * 1000; // messages within 5 minutes of the same sender collapse into one group

function isSameGroup(a, b) {
  if (!a || !b) return false;
  if (a.sender_email !== b.sender_email) return false;
  if (a.reply_preview || b.reply_preview || a.forwarded_from || b.forwarded_from) return false;
  const gap = new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  return gap >= 0 && gap < GROUP_WINDOW_MS;
}

export default function ChatPanel({ channelId, currentEmail, channels, isAdmin }) {
  const { messages, loading, error, sendMessage, removeMessage, togglePin, forward, report } =
    useChannelMessages(channelId, currentEmail);

  const [replyingTo, setReplyingTo] = useState(null);
  const [forwardTarget, setForwardTarget] = useState(null); // message being forwarded
  const [reportTarget, setReportTarget] = useState(null); // message being reported
  const bottomRef = useRef(null);

  // Per-channel "translate to" language — set once, applies to every
  // message's translate button in this channel. Defaults to the
  // browser's own language if it's a real ISO 639-1 code, else "en".
  // Session-only, same as Mission Control's other lightweight
  // preferences — not persisted server-side.
  const [languages, setLanguages] = useState([{ code: "en", name: "English" }]);
  const [targetLang, setTargetLang] = useState(() => {
    if (typeof navigator !== "undefined" && navigator.language) {
      const short = navigator.language.split("-")[0];
      if (short && short.length === 2) return short;
    }
    return "en";
  });

  useEffect(() => {
    listTranslationLanguages()
      .then(setLanguages)
      .catch((err) => console.error("Failed to load translation languages:", err));
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  function handleSend(text, options) {
    sendMessage(text, options);
    setReplyingTo(null);
  }

  function handleDelete(message) {
    if (window.confirm("Delete this message? This can't be undone.")) {
      removeMessage(message.id);
    }
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-end gap-1.5 px-4 sm:px-6 pt-2 shrink-0">
        <TranslateIcon className="w-3 h-3 text-[#5a6a72]" />
        <label htmlFor="chat-translate-lang" className="sr-only">
          Translate messages to
        </label>
        <select
          id="chat-translate-lang"
          value={targetLang}
          onChange={(e) => setTargetLang(e.target.value)}
          className="bg-transparent border border-[#3a444a] rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-[#8fa3ad] outline-none focus:border-[#8fa3ad] cursor-pointer"
        >
          {languages.map((lang) => (
            <option key={lang.code} value={lang.code} className="bg-[#1c2226] text-[#d3dbe0]">
              {lang.name}
            </option>
          ))}
        </select>
      </div>

      <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-4 flex flex-col">
        {loading && <p className="text-xs text-[#5a6a72]">Loading messages…</p>}
        {!loading && messages.length === 0 && (
          <p className="text-xs text-[#5a6a72]">No messages yet — say hello to your team.</p>
        )}
        {messages.map((m, i) => (
          <MessageRow
            key={m.id}
            message={m}
            grouped={isSameGroup(messages[i - 1], m)}
            currentEmail={currentEmail}
            isAdmin={isAdmin}
            targetLang={targetLang}
            onReply={setReplyingTo}
            onForward={setForwardTarget}
            onTogglePin={togglePin}
            onDelete={handleDelete}
            onReport={setReportTarget}
          />
        ))}
        <div ref={bottomRef} />
      </div>

      {error && <p className="px-4 sm:px-6 text-xs text-[#c47a6e] pb-1">{error}</p>}

      <MessageComposer
        channelId={channelId}
        currentEmail={currentEmail}
        replyingTo={replyingTo}
        onCancelReply={() => setReplyingTo(null)}
        onSend={handleSend}
      />

      {forwardTarget && (
        <ForwardMessageModal
          channels={channels}
          currentChannelId={channelId}
          onClose={() => setForwardTarget(null)}
          onForward={(targetChannelId) => forward(forwardTarget.id, targetChannelId)}
        />
      )}

      {reportTarget && (
        <ReportMessageModal
          onClose={() => setReportTarget(null)}
          onReport={(reason) => report(reportTarget.id, reason)}
        />
      )}
    </div>
  );
}