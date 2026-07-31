"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";

function ResetPasswordForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get("token");
  const email = searchParams.get("email");

  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");

    if (password !== confirmPassword) {
      setError("Passwords don't match");
      return;
    }

    setLoading(true);
    try {
      const res = await fetch("/api/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, token, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Something went wrong");
        setLoading(false);
        return;
      }
      setDone(true);
      setTimeout(() => router.push("/login"), 2000);
    } catch (err) {
      setError("Something went wrong. Please try again.");
      setLoading(false);
    }
  }

  if (!token || !email) {
    return (
      <div className="min-h-screen bg-[#171d20] text-[#d3dbe0] flex items-center justify-center font-mono px-4">
        <div className="w-full max-w-sm bg-[#1c2226] border border-[#3a444a] rounded-xl p-8 text-center">
          <p className="text-sm text-[#d8877a]">Invalid reset link.</p>
          <Link href="/forgot-password" className="text-xs text-[#8fa3ad] hover:text-[#d3dbe0] mt-4 block">
            Request a new one
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#171d20] text-[#d3dbe0] flex items-center justify-center font-mono px-4">
      <div className="w-full max-w-sm bg-[#1c2226] border border-[#3a444a] rounded-xl p-8">
        <h1 className="text-xl font-bold mb-1 text-[#d3dbe0]">Set new password</h1>
        <p className="text-xs text-[#8fa3ad] mb-6">for {email}</p>

        {done ? (
          <p className="text-sm text-[#8fa3ad]">Password updated. Redirecting to sign in…</p>
        ) : (
          <form onSubmit={handleSubmit} className="flex flex-col gap-3">
            <input
              type="password"
              required
              placeholder="New password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="bg-black/20 border border-[#3a444a] rounded-lg px-3 py-2 text-sm text-[#d3dbe0] placeholder-[#5a6a72] outline-none focus:border-[#8fa3ad]"
            />
            <input
              type="password"
              required
              placeholder="Confirm new password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              className="bg-black/20 border border-[#3a444a] rounded-lg px-3 py-2 text-sm text-[#d3dbe0] placeholder-[#5a6a72] outline-none focus:border-[#8fa3ad]"
            />
            {error && <p className="text-xs text-[#d8877a]">{error}</p>}
            <button
              type="submit"
              disabled={loading}
              className="bg-[#8fa3ad]/10 border border-[#8fa3ad]/60 rounded-lg px-4 py-2 text-sm text-[#d3dbe0] hover:bg-[#8fa3ad]/20 transition disabled:opacity-50"
            >
              {loading ? "Updating…" : "Update password"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-[#171d20] text-[#d3dbe0] flex items-center justify-center font-mono px-4">
          <p className="text-sm text-[#8fa3ad]">Loading…</p>
        </div>
      }
    >
      <ResetPasswordForm />
    </Suspense>
  );
}