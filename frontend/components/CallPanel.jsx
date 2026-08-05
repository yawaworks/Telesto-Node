"use client";

import { useEffect, useRef, useState } from "react";

const JITSI_SCRIPT_SRC = "https://meet.jit.si/external_api.js";

function loadJitsiScript() {
  if (window.JitsiMeetExternalAPI) return Promise.resolve();
  if (window.__jitsiScriptLoading) return window.__jitsiScriptLoading;

  window.__jitsiScriptLoading = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = JITSI_SCRIPT_SRC;
    script.async = true;
    script.onload = resolve;
    script.onerror = () => reject(new Error("Couldn't load meet.jit.si — check your connection"));
    document.body.appendChild(script);
  });

  return window.__jitsiScriptLoading;
}

/**
 * Embeds a live call using meet.jit.si's free public instance via their
 * IFrame API — no signaling server or TURN/STUN of our own, no account,
 * no per-minute metering. `room` should already be the unguessable room
 * name from GET /channels/{id}/call-room or a scheduled meeting's
 * jitsi_room, not raw user input.
 */
export default function CallPanel({ room, displayName, onLeave }) {
  const containerRef = useRef(null);
  const apiRef = useRef(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;

    loadJitsiScript()
      .then(() => {
        if (cancelled || !containerRef.current) return;
        apiRef.current = new window.JitsiMeetExternalAPI("meet.jit.si", {
          roomName: room,
          parentNode: containerRef.current,
          width: "100%",
          height: "100%",
          userInfo: { displayName: displayName || "Researcher" },
          configOverwrite: { prejoinPageEnabled: false },
        });
        apiRef.current.addListener("readyToClose", () => onLeave?.());
      })
      .catch((err) => {
        console.error("Jitsi load failed:", err);
        if (!cancelled) setError(err.message);
      });

    return () => {
      cancelled = true;
      apiRef.current?.dispose();
      apiRef.current = null;
    };
  }, [room, displayName, onLeave]);

  if (error) {
    return (
      <div className="h-full flex items-center justify-center px-6 text-center">
        <p className="text-sm text-[#c47a6e]">{error}</p>
      </div>
    );
  }

  return <div ref={containerRef} className="w-full h-full" />;
}