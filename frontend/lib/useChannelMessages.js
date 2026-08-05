"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  deleteMessage as apiDeleteMessage,
  forwardMessage as apiForwardMessage,
  listMessages,
  markChannelRead,
  pinMessage as apiPinMessage,
  postMessage,
  reportMessage as apiReportMessage,
  unpinMessage as apiUnpinMessage,
} from "./workspaceApi";

const POLL_INTERVAL_MS = 4000;
const MARK_READ_INTERVAL_MS = 10000;

/**
 * Polls a channel's messages on an interval and exposes send/reply/
 * delete/pin/forward/report actions plus read-marking. Deliberately
 * polling rather than a WebSocket/managed pub-sub service — see Section
 * 14.6 of the project plan.
 *
 * `since` is tracked in a ref, not state, so the interval callback always
 * reads the current value instead of a stale closure from whenever the
 * effect first ran (the same closure-staleness pattern documented for the
 * gamepad and detection hooks).
 */
export function useChannelMessages(channelId, requesterEmail) {
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const sinceRef = useRef(null);

  const poll = useCallback(async () => {
    if (!channelId || !requesterEmail) return;
    try {
      const fresh = await listMessages(channelId, {
        requesterEmail,
        since: sinceRef.current,
      });
      if (fresh.length > 0) {
        sinceRef.current = fresh[fresh.length - 1].created_at;
        setMessages((prev) => {
          // A message can arrive again with updated fields (pinned,
          // deleted) even after it's already rendered — merge by id
          // instead of blindly appending duplicates.
          const byId = new Map(prev.map((m) => [m.id, m]));
          fresh.forEach((m) => byId.set(m.id, m));
          return Array.from(byId.values()).sort(
            (a, b) => new Date(a.created_at) - new Date(b.created_at)
          );
        });
      }
      setError(null);
    } catch (err) {
      console.error("Channel message poll failed:", err);
      setError("Couldn't reach the workspace right now");
    } finally {
      setLoading(false);
    }
  }, [channelId, requesterEmail]);

  useEffect(() => {
    // Reset when switching channels — a previous channel's messages/
    // timestamp shouldn't bleed into the newly opened one.
    setMessages([]);
    sinceRef.current = null;
    setLoading(true);
    setError(null);

    if (!channelId || !requesterEmail) return;

    let cancelled = false;
    let intervalId = null;

    async function start() {
      await poll();
      if (cancelled) return;
      intervalId = setInterval(poll, POLL_INTERVAL_MS);
    }

    start();

    return () => {
      cancelled = true;
      if (intervalId) clearInterval(intervalId);
    };
  }, [channelId, requesterEmail, poll]);

  // Marks the channel read on open and periodically while it stays open —
  // not on every poll tick, so a channel sitting open all day doesn't
  // hammer the read-receipt endpoint.
  useEffect(() => {
    if (!channelId || !requesterEmail) return;
    let cancelled = false;

    function markRead() {
      if (cancelled) return;
      markChannelRead(channelId, requesterEmail).catch((err) =>
        console.error("Mark channel read failed:", err)
      );
    }

    markRead();
    const intervalId = setInterval(markRead, MARK_READ_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [channelId, requesterEmail]);

  const sendMessage = useCallback(
    async (text, { attachments = [], replyTo = null } = {}) => {
      if (!channelId || !requesterEmail) return;
      const trimmed = text.trim();
      if (!trimmed && attachments.length === 0) return;

      // Optimistic append so sending feels instant instead of waiting for
      // the next poll tick to echo it back.
      const optimisticId = `optimistic-${Date.now()}`;
      const optimistic = {
        id: optimisticId,
        channel_id: channelId,
        sender_email: requesterEmail,
        text: trimmed,
        attachments,
        created_at: new Date().toISOString(),
        reply_to: replyTo,
        reply_preview: null,
        pinned: false,
        deleted: false,
        forwarded_from: null,
      };
      setMessages((prev) => [...prev, optimistic]);

      try {
        const saved = await postMessage(channelId, {
          senderEmail: requesterEmail,
          text: trimmed,
          attachments,
          replyTo,
        });
        sinceRef.current = saved.created_at;
        setMessages((prev) => prev.map((m) => (m.id === optimisticId ? saved : m)));
      } catch (err) {
        console.error("Send message failed:", err);
        setMessages((prev) => prev.filter((m) => m.id !== optimisticId));
        setError("Message didn't send — try again");
      }
    },
    [channelId, requesterEmail]
  );

  const removeMessage = useCallback(async (messageId) => {
    try {
      await apiDeleteMessage(messageId, requesterEmail);
      setMessages((prev) =>
        prev.map((m) => (m.id === messageId ? { ...m, deleted: true, text: "[deleted]", attachments: [] } : m))
      );
    } catch (err) {
      console.error("Delete message failed:", err);
      setError(err.message || "Couldn't delete that message");
    }
  }, [requesterEmail]);

  const togglePin = useCallback(async (message) => {
    try {
      const updated = message.pinned
        ? await apiUnpinMessage(message.id, requesterEmail)
        : await apiPinMessage(message.id, requesterEmail);
      setMessages((prev) => prev.map((m) => (m.id === message.id ? updated : m)));
    } catch (err) {
      console.error("Pin toggle failed:", err);
      setError(err.message || "Couldn't update that pin");
    }
  }, [requesterEmail]);

  const forward = useCallback(
    async (messageId, targetChannelId) => {
      try {
        await apiForwardMessage(messageId, { targetChannelId, forwardedBy: requesterEmail });
      } catch (err) {
        console.error("Forward message failed:", err);
        setError(err.message || "Couldn't forward that message");
        throw err;
      }
    },
    [requesterEmail]
  );

  const report = useCallback(
    async (messageId, reason) => {
      try {
        await apiReportMessage(messageId, { reportedBy: requesterEmail, reason });
      } catch (err) {
        console.error("Report message failed:", err);
        setError(err.message || "Couldn't submit that report");
        throw err;
      }
    },
    [requesterEmail]
  );

  return { messages, loading, error, sendMessage, removeMessage, togglePin, forward, report };
}