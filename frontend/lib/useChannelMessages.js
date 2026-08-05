"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { listMessages, postMessage } from "./workspaceApi";

const POLL_INTERVAL_MS = 4000;

/**
 * Polls a channel's messages on an interval and exposes a sendMessage
 * helper. Deliberately polling rather than a WebSocket/managed pub-sub
 * service — see Section 14.6 of the project plan.
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
        setMessages((prev) => [...prev, ...fresh]);
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

  const sendMessage = useCallback(
    async (text, attachments = []) => {
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
      };
      setMessages((prev) => [...prev, optimistic]);

      try {
        const saved = await postMessage(channelId, {
          senderEmail: requesterEmail,
          text: trimmed,
          attachments,
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

  return { messages, loading, error, sendMessage };
}