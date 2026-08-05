"use client";

import { useEffect, useState } from "react";

/**
 * Tracks real browser connectivity. This is `navigator.onLine`, which
 * only reflects whether the device has a network interface that's up —
 * not whether the backend is actually reachable (wifi with no real
 * internet still reports "online"). Good enough to drive the offline
 * banner; not a substitute for the sync engine's own request failures
 * when it actually tries to reach the backend.
 */
export function useOnlineStatus() {
  const [online, setOnline] = useState(typeof navigator !== "undefined" ? navigator.onLine : true);

  useEffect(() => {
    function goOnline() {
      setOnline(true);
    }
    function goOffline() {
      setOnline(false);
    }

    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);

  return online;
}