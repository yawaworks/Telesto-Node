/**
 * Verifies a Cloudflare Turnstile token server-side. Turnstile was chosen
 * over reCAPTCHA/hCaptcha because it's genuinely free with no request cap,
 * privacy-respecting (no tracking cookies), and needs zero npm dependency
 * — just a script tag on the frontend and a plain fetch here.
 *
 * Get free site/secret keys at https://dash.cloudflare.com/?to=/:account/turnstile
 * Set NEXT_PUBLIC_TURNSTILE_SITE_KEY (frontend) and TURNSTILE_SECRET_KEY
 * (backend, this file) in your env vars.
 */
export async function verifyTurnstile(token, remoteIp) {
  if (!process.env.TURNSTILE_SECRET_KEY) {
    // Fails closed in production (no key configured = no bypass), but
    // logs clearly so a missing env var doesn't look like a silent
    // captcha-always-passes bug during local dev/testing.
    console.warn("[turnstile] TURNSTILE_SECRET_KEY is not set — rejecting all captcha checks");
    return false;
  }
  if (!token) return false;

  try {
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        secret: process.env.TURNSTILE_SECRET_KEY,
        response: token,
        ...(remoteIp ? { remoteip: remoteIp } : {}),
      }),
    });
    const data = await res.json();
    return data.success === true;
  } catch (err) {
    console.error("[turnstile] Verification request failed:", err);
    return false; // fail closed — a network hiccup shouldn't let a bot through
  }
}