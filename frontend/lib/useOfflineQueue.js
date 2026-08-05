"use client";

import { useCallback, useEffect, useState } from "react";
import { countPending } from "./offlineStore";

const POLL_INTERVAL_MS = 5000;

/**
 * Live count of unsynced items in the offline queue. IndexedDB has no
 * built-in change-notification API, so this polls — cheap, since it's
 * just a local index scan, not a network call. Exposes `refresh` so
 * callers can force an immediate update right after enqueueing
 * something, instead of waiting up to 5s for the next poll.
 */
export function useOfflineQueueCount(kind = null) {
  const [count, setCount] = useState(0);

  const refresh = useCallback(() => {
    countPending(kind)
      .then(setCount)
      .catch((err) => console.error("Offline queue count failed:", err));
  }, [kind]);

  useEffect(() => {
    refresh();
    const intervalId = setInterval(refresh, POLL_INTERVAL_MS);
    return () => clearInterval(intervalId);
  }, [refresh]);

  return { count, refresh };
}