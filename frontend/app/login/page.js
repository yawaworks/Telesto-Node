"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import Turnstile from "../../components/Turnstile";

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState("signin"); // "signin" | "signup"
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState(null);

  // Two-factor step: once authorize() signals 2FA_REQUIRED, we hold onto
  // the already-entered email/password and show a second form for just
  // the 6-digit code, re-submitting all three together.
  const [needsTotp, setNeedsTotp] = useState(false);
  const [totp, setTotp] = useState("");

  async function handleCredentialsSubmit(e) {
    e.preventDefault();
    setError("");

    if (!turnstileToken) {
      setError("Please complete the captcha");
      return;
    }

    setLoading(true);

    try {
      if (mode === "signup" && !needsTotp) {
        const res = await fetch("/api/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password, name, turnstileToken }),
        });
        const data = await res.json();
        if (!res.ok) {
          setError(data.error || "Registration failed");
          setLoading(false);
          return;
        }
      }

      const result = await signIn("credentials", {
        email,
        password,
        turnstileToken,
        totp: needsTotp ? totp : undefined,
        redirect: false,
      });

      if (result?.error === "2FA_REQUIRED") {
        setNeedsTotp(true);
        setError("");
        setLoading(false);
        return;
      }

      if (result?.error) {
        setError(
          result.error === "Invalid two-factor code"
            ? "That code doesn't match — check your app and try again"
            : "Invalid email or password"
        );
        setLoading(false);
        return;
      }

      router.push(mode === "signup" ? "/onboarding" : "/");
    } catch (err) {
      setError("Something went wrong. Please try again.");
      setLoading(false);
    }
  }

  function resetToCredentialsStep() {
    setNeedsTotp(false);
    setTotp("");
    setError("");
  }

  return (
    <div className="min-h-screen bg-[#171d20] text-[#d3dbe0] flex items-center justify-center font-mono px-4">
      <div className="w-full max-w-sm bg-[#1c2226] border border-[#3a444a] rounded-xl p-8">
        <h1 className="text-xl font-bold mb-1 text-[#d3dbe0]">Telesto Node</h1>
        <p className="text-xs text-[#8fa3ad] mb-6">Mission control access</p>

        {!needsTotp && (
          <>
            <button
              onClick={() => signIn("google", { callbackUrl: "/" })}
              className="w-full mb-4 bg-white/[0.03] border border-[#5a6a72] rounded-lg px-4 py-2 text-sm text-[#d3dbe0] hover:bg-white/[0.06] transition"
            >
              Continue with Google
            </button>

            <div className="flex items-center gap-2 my-4">
              <div className="flex-1 h-px bg-[#3a444a]" />
              <span className="text-xs text-[#5a6a72]">or</span>
              <div className="flex-1 h-px bg-[#3a444a]" />
            </div>
          </>
        )}

        <form onSubmit={handleCredentialsSubmit} className="flex flex-col gap-3">
          {needsTotp ? (
            <>
              <p className="text-xs text-[#8fa3ad] -mt-1 mb-1">
                Enter the 6-digit code from your authenticator app, or one of your backup codes.
              </p>
              <input
                type="text"
                required
                autoFocus
                placeholder="123456"
                value={totp}
                onChange={(e) => setTotp(e.target.value)}
                className="bg-black/20 border border-[#3a444a] rounded-lg px-3 py-2 text-sm text-[#d3dbe0] placeholder-[#5a6a72] outline-none focus:border-[#8fa3ad] tracking-widest text-center"
              />
            </>
          ) : (
            <>
              {mode === "signup" && (
                <input
                  type="text"
                  placeholder="Name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="bg-black/20 border border-[#3a444a] rounded-lg px-3 py-2 text-sm text-[#d3dbe0] placeholder-[#5a6a72] outline-none focus:border-[#8fa3ad]"
                />
              )}
              <input
                type="email"
                required
                placeholder="Email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="bg-black/20 border border-[#3a444a] rounded-lg px-3 py-2 text-sm text-[#d3dbe0] placeholder-[#5a6a72] outline-none focus:border-[#8fa3ad]"
              />
              <input
                type="password"
                required
                placeholder="Password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="bg-black/20 border border-[#3a444a] rounded-lg px-3 py-2 text-sm text-[#d3dbe0] placeholder-[#5a6a72] outline-none focus:border-[#8fa3ad]"
              />

              {mode === "signin" && (
                <div className="text-right -mt-1">
                  <Link href="/forgot-password" className="text-xs text-[#8fa3ad] hover:text-[#d3dbe0]">
                    Forgot password?
                  </Link>
                </div>
              )}

              <Turnstile onVerify={setTurnstileToken} onExpire={() => setTurnstileToken(null)} />
            </>
          )}

          {error && <p className="text-xs text-[#d8877a]">{error}</p>}

          <button
            type="submit"
            disabled={loading}
            className="bg-[#8fa3ad]/10 border border-[#8fa3ad]/60 rounded-lg px-4 py-2 text-sm text-[#d3dbe0] hover:bg-[#8fa3ad]/20 transition disabled:opacity-50"
          >
            {loading
              ? "Please wait…"
              : needsTotp
              ? "Verify code"
              : mode === "signin"
              ? "Sign in"
              : "Create account"}
          </button>

          {needsTotp && (
            <button
              type="button"
              onClick={resetToCredentialsStep}
              className="text-xs text-[#5a6a72] hover:text-[#b7c4cc] text-center"
            >
              ← Back
            </button>
          )}
        </form>

        {!needsTotp && (
          <button
            onClick={() => {
              setMode(mode === "signin" ? "signup" : "signin");
              setError("");
            }}
            className="w-full text-center text-xs text-[#8fa3ad] mt-4 hover:text-[#d3dbe0]"
          >
            {mode === "signin"
              ? "Need an account? Sign up"
              : "Already have an account? Sign in"}
          </button>
        )}

        <p className="text-center text-[10px] text-[#5a6a72] mt-6 leading-relaxed">
          By continuing, you agree to Telesto Node's{" "}
          <Link href="/terms" className="underline hover:text-[#8fa3ad]">
            Terms of Service
          </Link>
          .
        </p>
      </div>
    </div>
  );
}