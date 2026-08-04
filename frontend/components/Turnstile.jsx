"use client";

import { useEffect, useRef } from "react";

/**
 * Renders a Cloudflare Turnstile widget and reports the verification
 * token via onVerify(token). Handles explicit render/reset itself since
 * the script tag in layout.js uses render=explicit (auto-render doesn't
 * work well with forms that mount/unmount, like switching between
 * sign-in and sign-up on the same page).
 *
 * Usage: <Turnstile onVerify={setToken} onExpire={() => setToken(null)} />
 */
export default function Turnstile({ onVerify, onExpire }) {
  const containerRef = useRef(null);
  const widgetIdRef = useRef(null);

  useEffect(() => {
    const siteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
    if (!siteKey) {
      console.warn(
        "[Turnstile] NEXT_PUBLIC_TURNSTILE_SITE_KEY is not set — captcha widget won't render"
      );
      return;
    }

    let cancelled = false;

    function render() {
      if (cancelled || !containerRef.current || !window.turnstile) return;
      // Guard against double-rendering into the same container (e.g. a
      // fast re-mount during React StrictMode's dev double-invoke).
      if (widgetIdRef.current) return;

      widgetIdRef.current = window.turnstile.render(containerRef.current, {
        sitekey: siteKey,
        theme: "dark",
        callback: (token) => onVerify?.(token),
        "expired-callback": () => onExpire?.(),
        "error-callback": () => onExpire?.(),
      });
    }

    if (window.turnstile) {
      render();
    } else {
      // The script tag loads with strategy="afterInteractive" — if this
      // component mounts before that finishes, poll briefly rather than
      // silently rendering nothing.
      const interval = setInterval(() => {
        if (window.turnstile) {
          clearInterval(interval);
          render();
        }
      }, 100);
      return () => clearInterval(interval);
    }

    return () => {
      cancelled = true;
      if (widgetIdRef.current && window.turnstile) {
        window.turnstile.remove(widgetIdRef.current);
        widgetIdRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div ref={containerRef} className="my-1" />;
}