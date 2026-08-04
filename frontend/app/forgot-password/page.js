"use client";

import { useState } from "react";
import Link from "next/link";
import Turnstile from "../../components/Turnstile";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState("idle"); // idle | loading | done
  const [error, setError] = useState("");
  const [turnstileToken, setTurnstileToken] = useState(null);

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");

    if (!turnstileToken) {
      setError("Please complete the captcha");
      return;
    }

    setStatus("loading");

    try {
      const res = await fetch("/api/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, turnstileToken }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Something went wrong");
        setStatus("idle");
        return;
      }
      setStatus("done");
    } catch (err) {
      setError("Something went wrong. Please try again.");
      setStatus("idle");
    }
  }

  return (
    <div className="min-h-screen bg-[#171d20] text-[#d3dbe0] flex items-center justify-center font-mono px-4">
      <div className="w-full max-w-sm bg-[#1c2226] border border-[#3a444a] rounded-xl p-8">
        <h1 className="text-xl font-bold mb-1 text-[#d3dbe0]">Reset password</h1>
        <p className="text-xs text-[#8fa3ad] mb-6">
          Enter your email and we'll send you a reset link.
        </p>

        {status === "done" ? (
          <p className="text-sm text-[#8fa3ad]">
            If an account with that email exists, a reset link has been sent.
          </p>
        ) : (
          <form onSubmit={handleSubmit} className="flex flex-col gap-3">
            <input
              type="email"
              required
              placeholder="Email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="bg-black/20 border border-[#3a444a] rounded-lg px-3 py-2 text-sm text-[#d3dbe0] placeholder-[#5a6a72] outline-none focus:border-[#8fa3ad]"
            />
            <Turnstile onVerify={setTurnstileToken} onExpire={() => setTurnstileToken(null)} />
            {error && <p className="text-xs text-[#d8877a]">{error}</p>}
            <button
              type="submit"
              disabled={status === "loading"}
              className="bg-[#8fa3ad]/10 border border-[#8fa3ad]/60 rounded-lg px-4 py-2 text-sm text-[#d3dbe0] hover:bg-[#8fa3ad]/20 transition disabled:opacity-50"
            >
              {status === "loading" ? "Sending…" : "Send reset link"}
            </button>
          </form>
        )}

        <Link href="/login" className="block text-center text-xs text-[#8fa3ad] mt-6 hover:text-[#d3dbe0]">
          Back to sign in
        </Link>
      </div>
    </div>
  );
}