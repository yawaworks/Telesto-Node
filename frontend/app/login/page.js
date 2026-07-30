"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";
import Link from "next/link";

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState("signin"); // "signin" | "signup"
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleCredentialsSubmit(e) {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      if (mode === "signup") {
        const res = await fetch("/api/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password, name }),
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
        redirect: false,
      });

      if (result?.error) {
        setError("Invalid email or password");
        setLoading(false);
        return;
      }

      router.push("/");
    } catch (err) {
      setError("Something went wrong. Please try again.");
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-[#171d20] text-[#d3dbe0] flex items-center justify-center font-mono">
      <div className="w-full max-w-sm bg-[#1c2226] border border-[#3a444a] rounded-xl p-8">
        <h1 className="text-xl font-bold mb-1 text-[#d3dbe0]">Telesto Node</h1>
        <p className="text-xs text-[#8fa3ad] mb-6">Mission control access</p>

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

        <form onSubmit={handleCredentialsSubmit} className="flex flex-col gap-3">
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

          {error && <p className="text-xs text-[#d8877a]">{error}</p>}

          <button
            type="submit"
            disabled={loading}
            className="bg-[#8fa3ad]/10 border border-[#8fa3ad]/60 rounded-lg px-4 py-2 text-sm text-[#d3dbe0] hover:bg-[#8fa3ad]/20 transition disabled:opacity-50"
          >
            {loading ? "Please wait…" : mode === "signin" ? "Sign in" : "Create account"}
          </button>
        </form>

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