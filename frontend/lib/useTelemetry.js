"use client";

import { useEffect, useRef, useState } from "react";

const WS_BASE_URL =
  (process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:5050").replace(
    /^http/,
    "ws"
  ) + "/ws/telemetry";

function formatCoords(lat, lng) {
  const latDir = lat >= 0 ? "N" : "S";
  const lngDir = lng >= 0 ? "E" : "W";
  return `${Math.abs(lat).toFixed(4)} ${latDir}, ${Math.abs(lng).toFixed(4)} ${lngDir}`;
}

/**
 * Connects to the backend's /ws/telemetry stream and returns live-updating
 * mission telemetry, reconnecting automatically if the connection drops.
 *
 * Exposes raw `lat`/`lng` alongside the formatted `coords` string so
 * callers (e.g. useFrameDetection, for n8n detection alerts) can attach
 * real coordinates without re-parsing the display string.
 */
export function useTelemetry() {
  const [telemetry, setTelemetry] = useState({
    depth: "42.6 m",
    coords: "11.3500 N, 144.2400 E",
    lat: 11.35,
    lng: 144.24,
    temp: "17.2°C",
    salinity: "34.9 PSU",
    heading: "086°",
  });
  const [connected, setConnected] = useState(false);
  const wsRef = useRef(null);
  const reconnectTimeoutRef = useRef(null);

  useEffect(() => {
    let cancelled = false;

    function connect() {
      if (cancelled) return;

      const ws = new WebSocket(WS_BASE_URL);
      wsRef.current = ws;

      ws.onopen = () => setConnected(true);

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          setTelemetry({
            depth: `${data.depth.toFixed(1)} m`,
            coords: formatCoords(data.lat, data.lng),
            lat: data.lat,
            lng: data.lng,
            temp: `${data.temp.toFixed(1)}°C`,
            salinity: `${data.salinity.toFixed(1)} PSU`,
            heading: `${String(Math.round(data.heading)).padStart(3, "0")}°`,
            tempSource: data.temp_source || "simulated",
          });
        } catch (err) {
          console.error("Telemetry parse error:", err);
        }
      };

      ws.onclose = () => {
        setConnected(false);
        if (!cancelled) {
          // Retry after a couple seconds rather than giving up entirely
          reconnectTimeoutRef.current = setTimeout(connect, 2000);
        }
      };

      ws.onerror = () => {
        ws.close();
      };
    }

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
      wsRef.current?.close();
    };
  }, []);

  return { telemetry, connected };
}