"use client";

import { useRef, useState } from "react";
import { uploadChannelAttachment } from "../lib/workspaceApi";

function AttachmentChip({ attachment, onRemove }) {
  return (
    <span className="flex items-center gap-1.5 bg-[#8fa3ad]/10 border border-[#8fa3ad]/40 rounded-md pl-2 pr-1 py-1 text-xs text-[#b7c4cc]">
      {attachment.kind === "voice" ? (
        <>🎙️ Voice message{attachment.duration_seconds ? ` · ${Math.round(attachment.duration_seconds)}s` : ""}</>
      ) : (
        <>📎 {attachment.name}</>
      )}
      <button
        type="button"
        onClick={onRemove}
        className="text-[#8fa3ad] hover:text-[#d3dbe0] px-1"
        aria-label={`Remove ${attachment.name}`}
      >
        ✕
      </button>
    </span>
  );
}

export default function MessageComposer({ channelId, currentEmail, replyingTo, onCancelReply, onSend }) {
  const [draft, setDraft] = useState("");
  const [pendingAttachments, setPendingAttachments] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [recording, setRecording] = useState(false);
  const [uploadError, setUploadError] = useState(null);

  const fileInputRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const chunksRef = useRef([]);
  const recordStartRef = useRef(0);

  async function handleFilePicked(e) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow picking the same file twice in a row
    if (!file) return;

    setUploading(true);
    setUploadError(null);
    try {
      const uploaded = await uploadChannelAttachment(channelId, {
        file,
        uploaderEmail: currentEmail,
        kind: "file",
      });
      setPendingAttachments((prev) => [...prev, uploaded]);
    } catch (err) {
      console.error("Attachment upload failed:", err);
      setUploadError(err.message || "Upload failed — the file may be over the 15MB cap");
    } finally {
      setUploading(false);
    }
  }

  async function startRecording() {
    setUploadError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];
      recordStartRef.current = Date.now();

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      recorder.onstop = async () => {
        stream.getTracks().forEach((track) => track.stop());
        const durationSeconds = (Date.now() - recordStartRef.current) / 1000;
        const blob = new Blob(chunksRef.current, { type: "audio/webm" });
        const file = new File([blob], `voice-message-${Date.now()}.webm`, { type: "audio/webm" });

        setUploading(true);
        try {
          const uploaded = await uploadChannelAttachment(channelId, {
            file,
            uploaderEmail: currentEmail,
            kind: "voice",
          });
          setPendingAttachments((prev) => [...prev, { ...uploaded, duration_seconds: durationSeconds }]);
        } catch (err) {
          console.error("Voice message upload failed:", err);
          setUploadError(err.message || "Couldn't upload the voice message");
        } finally {
          setUploading(false);
        }
      };

      mediaRecorderRef.current = recorder;
      recorder.start();
      setRecording(true);
    } catch (err) {
      console.error("Microphone access failed:", err);
      setUploadError("Microphone access denied or unavailable");
    }
  }

  function stopRecording() {
    mediaRecorderRef.current?.stop();
    setRecording(false);
  }

  function handleSend() {
    if (!draft.trim() && pendingAttachments.length === 0) return;
    onSend(draft, {
      attachments: pendingAttachments.map((a) => ({
        url: a.url,
        name: a.name,
        kind: a.kind,
        duration_seconds: a.duration_seconds ?? null,
      })),
      replyTo: replyingTo?.id || null,
    });
    setDraft("");
    setPendingAttachments([]);
    onCancelReply?.();
  }

  function handleKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  return (
    <div className="border-t border-[#3a444a] px-4 sm:px-6 py-3 flex flex-col gap-2">
      {replyingTo && (
        <div className="flex items-center justify-between gap-2 bg-black/20 border border-[#3a444a] rounded-lg px-3 py-1.5">
          <p className="text-xs text-[#8fa3ad] truncate">
            Replying to <span className="text-[#b7c4cc]">{replyingTo.sender_email}</span>:{" "}
            <span className="text-[#5a6a72]">{replyingTo.text.slice(0, 80)}</span>
          </p>
          <button
            type="button"
            onClick={onCancelReply}
            className="text-[#5a6a72] hover:text-[#d3dbe0] text-xs shrink-0"
          >
            Cancel
          </button>
        </div>
      )}

      {pendingAttachments.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {pendingAttachments.map((a, i) => (
            <AttachmentChip
              key={`${a.url}-${i}`}
              attachment={a}
              onRemove={() => setPendingAttachments((prev) => prev.filter((_, idx) => idx !== i))}
            />
          ))}
        </div>
      )}

      {uploadError && <p className="text-xs text-[#c47a6e]">{uploadError}</p>}

      <div className="flex items-end gap-2">
        <input ref={fileInputRef} type="file" onChange={handleFilePicked} className="hidden" />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading || recording}
          title="Attach a file"
          className="shrink-0 w-9 h-9 flex items-center justify-center rounded-lg border border-[#3a444a] text-[#b7c4cc] hover:bg-white/[0.06] disabled:opacity-40"
        >
          📎
        </button>
        <button
          type="button"
          onClick={recording ? stopRecording : startRecording}
          disabled={uploading}
          title={recording ? "Stop recording" : "Record a voice message"}
          className={`shrink-0 w-9 h-9 flex items-center justify-center rounded-lg border transition disabled:opacity-40 ${
            recording
              ? "bg-[#c47a6e]/20 border-[#c47a6e]/60 text-[#c47a6e] animate-pulse"
              : "border-[#3a444a] text-[#b7c4cc] hover:bg-white/[0.06]"
          }`}
        >
          🎙️
        </button>

        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={1}
          placeholder={recording ? "Recording…" : "Message the channel…"}
          disabled={recording}
          className="flex-1 bg-black/20 border border-[#3a444a] rounded-lg px-3 py-2 text-sm text-[#d3dbe0] placeholder-[#5a6a72] outline-none focus:border-[#8fa3ad] resize-none disabled:opacity-60"
        />
        <button
          type="button"
          onClick={handleSend}
          disabled={(!draft.trim() && pendingAttachments.length === 0) || uploading || recording}
          className="shrink-0 bg-[#8fa3ad]/10 border border-[#8fa3ad]/60 rounded-lg px-4 py-2 text-xs uppercase tracking-widest text-[#d3dbe0] hover:bg-[#8fa3ad]/20 transition disabled:opacity-40"
        >
          Send
        </button>
      </div>
    </div>
  );
}