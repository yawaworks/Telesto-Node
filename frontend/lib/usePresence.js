"use client";

import { useEffect, useState } from "react";
import { getPresence, sendHeartbeat } from "./workspaceApi";

const HEARTBEAT_INTERVAL_MS = 30000;
const PRESENCE_POLL_INTERVAL_MS = 15000;

/**
 * Pings the backend every 30s while mounted, marking the given researcher
 * online. Mount this once near the top of the workspace shell — not
 * per-panel — so switching tabs doesn't reset the interval or cause
 * duplicate heartbeats.
 */
export function useHeartbeat(email) {
  useEffect(() => {
    if (!email) return;

    let cancelled = false;

    function beat() {
      if (cancelled) return;
      sendHeartbeat(email).catch((err) => console.error("Presence heartbeat failed:", err));
    }

    beat();
    const intervalId = setInterval(beat, HEARTBEAT_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [email]);
}

/**
 * Polls online/offline status for a list of teammate emails, keyed by
 * email for easy lookup. `emails` should be a stable array — pass a
 * memoized array (e.g. from useMemo keyed on the channel's member list),
 * since a fresh array literal every render restarts the poll on every
 * render instead of on every real membership change.
 */
export function usePresence(emails) {
  const [presence, setPresence] = useState({});
  const emailsKey = emails.join(",");

  useEffect(() => {
    if (!emails.length) {
      setPresence({});
      return;
    }

    let cancelled = false;
    let intervalId = null;

    async function poll() {
      try {
        const entries = await getPresence(emails);
        if (cancelled) return;
        const map = {};
        entries.forEach((entry) => {
          map[entry.email] = entry;
        });
        setPresence(map);
      } catch (err) {
        console.error("Presence poll failed:", err);
      }
    }

    poll();
    intervalId = setInterval(poll, PRESENCE_POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      if (intervalId) clearInterval(intervalId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- emailsKey is the real dependency
  }, [emailsKey]);

  return presence;
}