"use client";

import Avatar from "./Avatar";

function formatTime(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

function AttachmentView({ attachment }) {
  if (attachment.kind === "voice") {
    return (
      <div className="mt-1.5 flex items-center gap-2 bg-black/20 border border-[#3a444a] rounded-lg px-3 py-2 max-w-xs">
        <audio controls src={attachment.url} className="h-8 flex-1" />
      </div>
    );
  }

  const isImage = /\.(png|jpe?g|gif|webp)$/i.test(attachment.name || attachment.url);
  if (isImage) {
    return (
      <a href={attachment.url} target="_blank" rel="noreferrer" className="mt-1.5 block max-w-xs">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={attachment.url} alt={attachment.name} className="rounded-lg border border-[#3a444a] max-h-56" />
      </a>
    );
  }

  return (
    <a
      href={attachment.url}
      target="_blank"
      rel="noreferrer"
      className="mt-1.5 flex items-center gap-2 bg-black/20 border border-[#3a444a] rounded-lg px-3 py-2 max-w-xs text-xs text-[#8fa3ad] hover:text-[#d3dbe0] hover:border-[#8fa3ad]/60 transition"
    >
      📎 <span className="truncate">{attachment.name}</span>
    </a>
  );
}

function ActionButton({ title, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="w-6 h-6 flex items-center justify-center rounded text-[11px] text-[#5a6a72] hover:text-[#d3dbe0] hover:bg-white/[0.08]"
    >
      {children}
    </button>
  );
}

export default function MessageRow({
  message,
  grouped,
  currentEmail,
  isAdmin,
  onReply,
  onForward,
  onTogglePin,
  onDelete,
  onReport,
}) {
  const isMe = message.sender_email === currentEmail;
  const canDelete = !message.deleted && (isMe || isAdmin);

  return (
    <div
      className={`group flex gap-3 px-2 -mx-2 rounded-lg hover:bg-white/[0.03] relative ${
        grouped ? "py-0.5" : "pt-3 pb-0.5"
      }`}
    >
      <div className="w-8 shrink-0 flex items-start justify-center pt-0.5">
        {!grouped && <Avatar email={message.sender_email} size="sm" />}
        {grouped && (
          <span className="hidden group-hover:block text-[9px] text-[#5a6a72] pt-1">
            {formatTime(message.created_at)}
          </span>
        )}
      </div>

      <div className="min-w-0 flex-1">
        {!grouped && (
          <p className="flex items-baseline gap-2 mb-0.5">
            <span className="text-xs font-bold text-[#d3dbe0]">{isMe ? "You" : message.sender_email}</span>
            <span className="text-[10px] text-[#5a6a72]">{formatTime(message.created_at)}</span>
            {message.pinned && <span className="text-[10px] text-[#8fa3ad]">📌 Pinned</span>}
          </p>
        )}

        {message.forwarded_from && (
          <p className="text-[10px] text-[#5a6a72] italic mb-0.5">
            ↪ Forwarded from {message.forwarded_from.sender_email}
          </p>
        )}

        {message.reply_preview && (
          <div className="border-l-2 border-[#3a444a] pl-2 mb-1 text-[11px] text-[#5a6a72] truncate">
            <span className="text-[#8fa3ad]">{message.reply_preview.sender_email}</span>{" "}
            {message.reply_preview.text}
          </div>
        )}

        {message.deleted ? (
          <p className="text-sm text-[#5a6a72] italic">Message deleted</p>
        ) : (
          <>
            {message.text && (
              <p className="text-sm text-[#b7c4cc] whitespace-pre-wrap break-words leading-relaxed">
                {message.text}
              </p>
            )}
            {message.attachments?.map((a, i) => (
              <AttachmentView key={`${a.url}-${i}`} attachment={a} />
            ))}
          </>
        )}
      </div>

      {!message.deleted && (
        <div className="hidden group-hover:flex items-center gap-0.5 absolute right-1 -top-2 bg-[#1c2226] border border-[#3a444a] rounded-md px-1 py-0.5 shadow-sm">
          <ActionButton title="Reply" onClick={() => onReply(message)}>
            ↩
          </ActionButton>
          <ActionButton title="Forward" onClick={() => onForward(message)}>
            ↪
          </ActionButton>
          <ActionButton title={message.pinned ? "Unpin" : "Pin"} onClick={() => onTogglePin(message)}>
            📌
          </ActionButton>
          <ActionButton title="Report" onClick={() => onReport(message)}>
            ⚑
          </ActionButton>
          {canDelete && (
            <ActionButton title="Delete" onClick={() => onDelete(message)}>
              🗑
            </ActionButton>
          )}
        </div>
      )}
    </div>
  );
}