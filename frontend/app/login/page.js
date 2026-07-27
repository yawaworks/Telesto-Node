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
    <div className="min-h-screen bg-black text-cyan-200 flex items-center justify-center font-mono">
      <div className="w-full max-w-sm backdrop-blur-md bg-white/5 border border-cyan-400/30 rounded-xl p-8">
        <h1 className="text-xl font-bold mb-1">Telesto Node</h1>
        <p className="text-xs text-cyan-400/70 mb-6">Mission Control Access</p>

        <button
          onClick={() => signIn("google", { callbackUrl: "/" })}
          className="w-full mb-4 backdrop-blur-md bg-white/10 border border-cyan-400/30 rounded-lg px-4 py-2 text-sm hover:bg-white/20 transition"
        >
          Continue with Google
        </button>

        <div className="flex items-center gap-2 my-4">
          <div className="flex-1 h-px bg-cyan-400/20" />
          <span className="text-xs text-cyan-400/50">or</span>
          <div className="flex-1 h-px bg-cyan-400/20" />
        </div>

        <form onSubmit={handleCredentialsSubmit} className="flex flex-col gap-3">
          {mode === "signup" && (
            <input
              type="text"
              placeholder="Name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="bg-white/5 border border-cyan-400/30 rounded-lg px-3 py-2 text-sm outline-none focus:border-cyan-400/70"
            />
          )}
          <input
            type="email"
            required
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="bg-white/5 border border-cyan-400/30 rounded-lg px-3 py-2 text-sm outline-none focus:border-cyan-400/70"
          />
          <input
            type="password"
            required
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="bg-white/5 border border-cyan-400/30 rounded-lg px-3 py-2 text-sm outline-none focus:border-cyan-400/70"
          />

          {error && <p className="text-xs text-red-400">{error}</p>}

          <button
            type="submit"
            disabled={loading}
            className="bg-cyan-400/20 border border-cyan-400/60 rounded-lg px-4 py-2 text-sm hover:bg-cyan-400/30 transition disabled:opacity-50"
          >
            {loading ? "Please wait…" : mode === "signin" ? "Sign In" : "Create Account"}
          </button>
        </form>

        <button
          onClick={() => {
            setMode(mode === "signin" ? "signup" : "signin");
            setError("");
          }}
          className="w-full text-center text-xs text-cyan-400/70 mt-4 hover:text-cyan-300"
        >
          {mode === "signin"
            ? "Need an account? Sign up"
            : "Already have an account? Sign in"}
        </button>

        <p className="text-center text-[10px] text-cyan-400/40 mt-6 leading-relaxed">
          By continuing, you agree to Telesto Node's{" "}
          <Link href="/terms" className="underline hover:text-cyan-300">
            Terms of Service
          </Link>
          .
        </p>
      </div>
    </div>
  );
}