"use client";

import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import Link from "next/link";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:5050";

const ROLE_OPTIONS = [
  "Marine Biologist",
  "Research Diver",
  "ROV Pilot",
  "Graduate Student",
  "Principal Investigator",
  "Field Technician",
  "Conservation Officer",
  "Citizen Scientist",
  "Other",
];

function initials(name, email) {
  const source = (name || email || "").trim();
  if (!source) return "?";
  const parts = source.split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function TagInput({ label, hint, values, onChange, placeholder }) {
  const [draft, setDraft] = useState("");

  function commitDraft() {
    const v = draft.trim();
    if (v && !values.includes(v)) onChange([...values, v]);
    setDraft("");
  }

  function handleKeyDown(e) {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      commitDraft();
    } else if (e.key === "Backspace" && !draft && values.length > 0) {
      onChange(values.slice(0, -1));
    }
  }

  return (
    <div>
      <p className="text-[10px] uppercase tracking-widest text-[#8fa3ad] mb-1.5">{label}</p>
      {hint && <p className="text-[11px] text-[#5a6a72] mb-2">{hint}</p>}
      <div className="flex flex-wrap gap-1.5 bg-black/20 border border-[#3a444a] rounded-lg px-2.5 py-2 focus-within:border-[#8fa3ad]">
        {values.map((v) => (
          <span
            key={v}
            className="flex items-center gap-1 bg-[#8fa3ad]/10 border border-[#8fa3ad]/40 rounded-md pl-2 pr-1 py-0.5 text-xs text-[#b7c4cc]"
          >
            {v}
            <button
              type="button"
              onClick={() => onChange(values.filter((x) => x !== v))}
              className="text-[#8fa3ad] hover:text-[#d3dbe0] px-1"
              aria-label={`Remove ${v}`}
            >
              ✕
            </button>
          </span>
        ))}
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={commitDraft}
          placeholder={placeholder}
          className="flex-1 min-w-[120px] bg-transparent text-sm text-[#d3dbe0] placeholder-[#5a6a72] outline-none py-0.5"
        />
      </div>
    </div>
  );
}

function Field({ label, hint, children }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-widest text-[#8fa3ad] mb-1.5">{label}</p>
      {hint && <p className="text-[11px] text-[#5a6a72] mb-2">{hint}</p>}
      {children}
    </div>
  );
}

const inputClass =
  "w-full bg-black/20 border border-[#3a444a] rounded-lg px-3 py-2 text-sm text-[#d3dbe0] placeholder-[#5a6a72] outline-none focus:border-[#8fa3ad]";

export default function ProfilePage() {
  const { data: session, status: sessionStatus } = useSession();
  const router = useRouter();

  useEffect(() => {
    if (sessionStatus === "unauthenticated") router.push("/login");
  }, [sessionStatus, router]);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState(null);
  const [clipCount, setClipCount] = useState(null);
  const [profile, setProfile] = useState({
    email: "",
    name: "",
    institution: "",
    role: "",
    orcid: "",
    bio: "",
    researchFocus: [],
    fieldSites: [],
    certifications: [],
    contactEmail: "",
    scholarUrl: "",
    websiteUrl: "",
    alertsOptIn: true,
    memberSince: null,
  });

  useEffect(() => {
    if (sessionStatus !== "authenticated") return;

    async function load() {
      setLoading(true);
      try {
        const res = await fetch("/api/profile");
        if (res.ok) {
          const data = await res.json();
          setProfile((prev) => ({ ...prev, ...data }));
        }
      } catch (err) {
        console.error("Failed to load profile:", err);
      } finally {
        setLoading(false);
      }
    }
    load();

    async function loadStats() {
      try {
        const params = new URLSearchParams({
          scope: "mine",
          owner_email: session?.user?.email || "",
        });
        const res = await fetch(`${API_BASE_URL}/clips?${params}`);
        if (res.ok) {
          const data = await res.json();
          setClipCount(Array.isArray(data) ? data.length : null);
        }
      } catch (err) {
        console.error("Failed to load activity stats:", err);
      }
    }
    loadStats();
  }, [sessionStatus, session?.user?.email]);

  function update(field, value) {
    setProfile((prev) => ({ ...prev, [field]: value }));
  }

  async function handleSave() {
    setSaving(true);
    setSaveMessage(null);
    try {
      const res = await fetch("/api/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: profile.name,
          institution: profile.institution,
          role: profile.role,
          orcid: profile.orcid,
          bio: profile.bio,
          researchFocus: profile.researchFocus,
          fieldSites: profile.fieldSites,
          certifications: profile.certifications,
          contactEmail: profile.contactEmail,
          scholarUrl: profile.scholarUrl,
          websiteUrl: profile.websiteUrl,
          alertsOptIn: profile.alertsOptIn,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Save failed");
      setSaveMessage({ type: "success", text: "Profile saved" });
    } catch (err) {
      setSaveMessage({ type: "error", text: err.message || "Couldn't save — try again" });
    } finally {
      setSaving(false);
      setTimeout(() => setSaveMessage(null), 3500);
    }
  }

  if (sessionStatus === "unauthenticated") return null;

  return (
    <div className="min-h-screen bg-[#171d20] text-[#d3dbe0] font-mono text-sm">
      <div className="sticky top-0 z-10 h-14 flex items-center justify-between px-4 sm:px-6 bg-[#1c2226]/90 border-b border-[#3a444a]">
        <Link
          href="/"
          className="text-xs uppercase tracking-widest text-[#8fa3ad] hover:text-[#d3dbe0]"
        >
          ← Mission control
        </Link>
        <span className="text-xs uppercase tracking-widest text-[#5a6a72]">Researcher profile</span>
      </div>

      <div className="max-w-2xl mx-auto px-4 sm:px-6 py-6 sm:py-10">
        {loading ? (
          <p className="text-xs text-[#5a6a72]">Loading profile…</p>
        ) : (
          <>
            {/* Identity header */}
            <div className="flex items-center gap-4 mb-8">
              <div className="w-16 h-16 rounded-full bg-[#8fa3ad]/15 border border-[#8fa3ad]/50 flex items-center justify-center text-lg font-bold text-[#b7c4cc] shrink-0">
                {initials(profile.name, profile.email)}
              </div>
              <div className="min-w-0">
                <h1 className="text-xl font-bold text-[#d3dbe0] truncate">
                  {profile.name || profile.email}
                </h1>
                <p className="text-xs text-[#8fa3ad] truncate">
                  {profile.role || "Role not set"}
                  {profile.institution ? ` · ${profile.institution}` : ""}
                </p>
              </div>
            </div>

            {/* Activity snapshot */}
            <div className="grid grid-cols-2 gap-3 mb-8">
              <div className="bg-[#1c2226] border border-[#3a444a] rounded-xl px-4 py-3">
                <p className="text-[10px] uppercase tracking-widest text-[#8fa3ad]">Clips saved</p>
                <p className="text-lg font-bold">{clipCount === null ? "—" : clipCount}</p>
              </div>
              <div className="bg-[#1c2226] border border-[#3a444a] rounded-xl px-4 py-3">
                <p className="text-[10px] uppercase tracking-widest text-[#8fa3ad]">Member since</p>
                <p className="text-lg font-bold">
                  {profile.memberSince
                    ? new Date(profile.memberSince).toLocaleDateString(undefined, {
                        month: "short",
                        year: "numeric",
                      })
                    : "—"}
                </p>
              </div>
            </div>

            <div className="flex flex-col gap-8">
              {/* Identity & affiliation */}
              <section className="bg-[#1c2226] border border-[#3a444a] rounded-xl p-4 sm:p-5 flex flex-col gap-4">
                <h2 className="text-xs uppercase tracking-widest text-[#5a6a72]">
                  Identity &amp; affiliation
                </h2>

                <Field label="Full name">
                  <input
                    type="text"
                    value={profile.name}
                    onChange={(e) => update("name", e.target.value)}
                    className={inputClass}
                  />
                </Field>

                <div className="grid sm:grid-cols-2 gap-4">
                  <Field label="Institution / organization">
                    <input
                      type="text"
                      value={profile.institution}
                      onChange={(e) => update("institution", e.target.value)}
                      placeholder="e.g. Scripps Institution of Oceanography"
                      className={inputClass}
                    />
                  </Field>
                  <Field label="Role">
                    <select
                      value={profile.role}
                      onChange={(e) => update("role", e.target.value)}
                      className={inputClass}
                    >
                      <option value="">Select a role…</option>
                      {ROLE_OPTIONS.map((r) => (
                        <option key={r} value={r}>
                          {r}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>

                <Field
                  label="ORCID iD"
                  hint="Your researcher identifier, if you have one (orcid.org)"
                >
                  <input
                    type="text"
                    value={profile.orcid}
                    onChange={(e) => update("orcid", e.target.value)}
                    placeholder="0000-0002-1825-0097"
                    className={inputClass}
                  />
                </Field>

                <Field label="Bio">
                  <textarea
                    value={profile.bio}
                    onChange={(e) => update("bio", e.target.value)}
                    rows={4}
                    maxLength={1000}
                    placeholder="A short summary of your research background and interests…"
                    className={`${inputClass} resize-none`}
                  />
                </Field>
              </section>

              {/* Research focus */}
              <section className="bg-[#1c2226] border border-[#3a444a] rounded-xl p-4 sm:p-5 flex flex-col gap-4">
                <h2 className="text-xs uppercase tracking-widest text-[#5a6a72]">Research focus</h2>

                <TagInput
                  label="Species / ecosystem interests"
                  hint="Press Enter or comma to add each one"
                  values={profile.researchFocus}
                  onChange={(v) => update("researchFocus", v)}
                  placeholder="e.g. Acropora cervicornis, coral bleaching"
                />

                <TagInput
                  label="Field sites / regions"
                  values={profile.fieldSites}
                  onChange={(v) => update("fieldSites", v)}
                  placeholder="e.g. Coral Triangle, Gulf of Mexico"
                />
              </section>

              {/* Certifications */}
              <section className="bg-[#1c2226] border border-[#3a444a] rounded-xl p-4 sm:p-5 flex flex-col gap-4">
                <h2 className="text-xs uppercase tracking-widest text-[#5a6a72]">
                  Certifications &amp; qualifications
                </h2>
                <TagInput
                  label="Certifications"
                  hint="Diving, ROV piloting, or other relevant credentials"
                  values={profile.certifications}
                  onChange={(v) => update("certifications", v)}
                  placeholder="e.g. PADI Rescue Diver, ROV Pilot Tech II"
                />
              </section>

              {/* Links & contact */}
              <section className="bg-[#1c2226] border border-[#3a444a] rounded-xl p-4 sm:p-5 flex flex-col gap-4">
                <h2 className="text-xs uppercase tracking-widest text-[#5a6a72]">
                  Links &amp; contact
                </h2>

                <Field label="Login email" hint="Used to sign in — not editable here">
                  <input
                    type="text"
                    value={profile.email}
                    disabled
                    className={`${inputClass} opacity-60 cursor-not-allowed`}
                  />
                </Field>

                <Field label="Public contact email" hint="Shown to collaborators, if different from login email">
                  <input
                    type="email"
                    value={profile.contactEmail}
                    onChange={(e) => update("contactEmail", e.target.value)}
                    placeholder="you@institution.edu"
                    className={inputClass}
                  />
                </Field>

                <div className="grid sm:grid-cols-2 gap-4">
                  <Field label="Google Scholar / ResearchGate">
                    <input
                      type="url"
                      value={profile.scholarUrl}
                      onChange={(e) => update("scholarUrl", e.target.value)}
                      placeholder="https://scholar.google.com/citations?user=…"
                      className={inputClass}
                    />
                  </Field>
                  <Field label="Personal / lab website">
                    <input
                      type="url"
                      value={profile.websiteUrl}
                      onChange={(e) => update("websiteUrl", e.target.value)}
                      placeholder="https://"
                      className={inputClass}
                    />
                  </Field>
                </div>
              </section>

              {/* Alerts */}
              <section className="bg-[#1c2226] border border-[#3a444a] rounded-xl p-4 sm:p-5 flex items-center justify-between gap-4">
                <div>
                  <h2 className="text-xs uppercase tracking-widest text-[#5a6a72] mb-1">
                    Detection alert emails
                  </h2>
                  <p className="text-[11px] text-[#5a6a72]">
                    Get emailed when a high-confidence species detection fires during a live session.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => update("alertsOptIn", !profile.alertsOptIn)}
                  className={`shrink-0 w-11 h-6 rounded-full border transition relative ${
                    profile.alertsOptIn
                      ? "bg-[#8fa3ad]/30 border-[#8fa3ad]/60"
                      : "bg-white/[0.04] border-[#3a444a]"
                  }`}
                  aria-pressed={profile.alertsOptIn}
                  aria-label="Toggle detection alert emails"
                >
                  <span
                    className={`absolute top-0.5 w-4 h-4 rounded-full bg-[#d3dbe0] transition ${
                      profile.alertsOptIn ? "left-6" : "left-0.5"
                    }`}
                  />
                </button>
              </section>

              {/* Save bar */}
              <div className="flex items-center gap-3 pb-8">
                <button
                  onClick={handleSave}
                  disabled={saving}
                  className="bg-[#8fa3ad]/10 border border-[#8fa3ad]/60 rounded-lg px-5 py-2 text-xs uppercase tracking-widest text-[#d3dbe0] hover:bg-[#8fa3ad]/20 transition disabled:opacity-50"
                >
                  {saving ? "Saving…" : "Save changes"}
                </button>
                {saveMessage && (
                  <span
                    className={`text-xs ${
                      saveMessage.type === "success" ? "text-[#8fa3ad]" : "text-[#c47a6e]"
                    }`}
                  >
                    {saveMessage.text}
                  </span>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}