"use client";

import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";

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

const inputClass =
  "w-full bg-black/20 border border-[#3a444a] rounded-lg px-3 py-2 text-sm text-[#d3dbe0] placeholder-[#5a6a72] outline-none focus:border-[#8fa3ad]";

function Field({ label, hint, children }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-widest text-[#8fa3ad] mb-1.5">{label}</p>
      {hint && <p className="text-[11px] text-[#5a6a72] mb-2">{hint}</p>}
      {children}
    </div>
  );
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

// Small inline icons (no external image assets) for the tour slides.
function FeedIcon() {
  return (
    <svg viewBox="0 0 64 64" className="w-14 h-14 sm:w-16 sm:h-16" fill="none">
      <rect x="6" y="14" width="52" height="34" rx="4" stroke="#8fa3ad" strokeWidth="2.5" />
      <circle cx="32" cy="31" r="9" stroke="#8fa3ad" strokeWidth="2.5" />
      <circle cx="32" cy="31" r="3" fill="#8fa3ad" />
      <path d="M18 52h28" stroke="#5a6a72" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}
function TargetIcon() {
  return (
    <svg viewBox="0 0 64 64" className="w-14 h-14 sm:w-16 sm:h-16" fill="none">
      <circle cx="32" cy="32" r="22" stroke="#8fa3ad" strokeWidth="2.5" />
      <circle cx="32" cy="32" r="13" stroke="#8fa3ad" strokeWidth="2.5" />
      <circle cx="32" cy="32" r="4" fill="#8fa3ad" />
      <path d="M32 4v10M32 50v10M4 32h10M50 32h10" stroke="#5a6a72" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}
function MapIcon() {
  return (
    <svg viewBox="0 0 64 64" className="w-14 h-14 sm:w-16 sm:h-16" fill="none">
      <path d="M8 16l16-6 16 6 16-6v38l-16 6-16-6-16 6V16z" stroke="#8fa3ad" strokeWidth="2.5" strokeLinejoin="round" />
      <path d="M24 10v38M40 16v38" stroke="#5a6a72" strokeWidth="2" />
    </svg>
  );
}
function FolderIcon() {
  return (
    <svg viewBox="0 0 64 64" className="w-14 h-14 sm:w-16 sm:h-16" fill="none">
      <path
        d="M8 18a3 3 0 013-3h13l5 6h24a3 3 0 013 3v22a3 3 0 01-3 3H11a3 3 0 01-3-3V18z"
        stroke="#8fa3ad"
        strokeWidth="2.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}
function BellIcon() {
  return (
    <svg viewBox="0 0 64 64" className="w-14 h-14 sm:w-16 sm:h-16" fill="none">
      <path
        d="M32 8c-7 0-12 5.5-12 13v8l-5 9h34l-5-9v-8c0-7.5-5-13-12-13z"
        stroke="#8fa3ad"
        strokeWidth="2.5"
        strokeLinejoin="round"
      />
      <path d="M26 44a6 6 0 0012 0" stroke="#8fa3ad" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}
function DocIcon() {
  return (
    <svg viewBox="0 0 64 64" className="w-14 h-14 sm:w-16 sm:h-16" fill="none">
      <path d="M16 6h22l10 10v42a2 2 0 01-2 2H16a2 2 0 01-2-2V8a2 2 0 012-2z" stroke="#8fa3ad" strokeWidth="2.5" strokeLinejoin="round" />
      <path d="M38 6v10h10" stroke="#8fa3ad" strokeWidth="2.5" strokeLinejoin="round" />
      <path d="M22 34h20M22 42h20M22 26h10" stroke="#5a6a72" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

const SLIDES = [
  {
    icon: FeedIcon,
    title: "Live ROV mission control",
    body: "Pilot with a gamepad or the on-screen controls while watching the live feed, telemetry, and inference status all in one HUD.",
  },
  {
    icon: TargetIcon,
    title: "Species detection & snapshots",
    body: "Marine life is detected live on the video feed. Press the gamepad's A button (or hit Snapshot) to capture a Discovery Snapshot with telemetry attached.",
  },
  {
    icon: FeedIcon,
    title: "Annotate what you capture",
    body: "Every snapshot opens in an editor with pen, highlighter, arrow, text, and crop tools — plus undo/redo and zoom — before you save, download, or share it.",
  },
  {
    icon: MapIcon,
    title: "3D bathymetry map",
    body: "Switch to map mode to see live seafloor terrain and plot species sightings by scientific name.",
  },
  {
    icon: FolderIcon,
    title: "Clip & snapshot libraries",
    body: "Save clips and snapshots to your personal library, or mark them shared so the rest of your team can see them too.",
  },
  {
    icon: BellIcon,
    title: "Detection alerts",
    body: "Opt in on your profile to get emailed when a high-confidence species detection fires during a live session.",
  },
  {
    icon: DocIcon,
    title: "Field reports",
    body: "Export a PDF mission report or email one to yourself straight from mission control, any time.",
  },
];

export default function OnboardingPage() {
  const { data: session, status: sessionStatus } = useSession();
  const router = useRouter();

  useEffect(() => {
    if (sessionStatus === "unauthenticated") router.push("/login");
  }, [sessionStatus, router]);

  const [step, setStep] = useState("profile"); // "profile" | "tour"
  const [slideIndex, setSlideIndex] = useState(0);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const [profile, setProfile] = useState({
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
  });

  useEffect(() => {
    if (sessionStatus !== "authenticated") return;
    async function load() {
      setLoading(true);
      try {
        const res = await fetch("/api/profile");
        if (res.ok) {
          const data = await res.json();
          setProfile((prev) => ({ ...prev, ...data, name: data.name || session?.user?.name || "" }));
          // Someone who somehow lands back here after already finishing
          // onboarding shouldn't be trapped in it again.
          if (data.onboardingCompleted) router.push("/");
        }
      } catch (err) {
        console.error("Failed to load profile for onboarding:", err);
      } finally {
        setLoading(false);
      }
    }
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionStatus]);

  function update(field, value) {
    setProfile((prev) => ({ ...prev, [field]: value }));
  }

  async function saveProfileFields(extra = {}) {
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
        ...extra,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Couldn't save your profile");
    return data;
  }

  async function handleContinueFromProfile() {
    setSaving(true);
    setError(null);
    try {
      await saveProfileFields();
      setStep("tour");
      setSlideIndex(0);
    } catch (err) {
      setError(err.message || "Couldn't save — try again");
    } finally {
      setSaving(false);
    }
  }

  function handleSkipProfile() {
    setStep("tour");
    setSlideIndex(0);
  }

  async function handleFinish() {
    setSaving(true);
    setError(null);
    try {
      await saveProfileFields({ onboardingCompleted: true });
      router.push("/");
    } catch (err) {
      setError(err.message || "Couldn't finish setup — try again");
      setSaving(false);
    }
  }

  async function handleSkipAll() {
    setSaving(true);
    try {
      await fetch("/api/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ onboardingCompleted: true }),
      });
    } catch (err) {
      console.error("Failed to mark onboarding skipped:", err);
    } finally {
      router.push("/");
    }
  }

  if (sessionStatus === "unauthenticated") return null;

  const isLastSlide = slideIndex === SLIDES.length - 1;

  return (
    <div className="min-h-screen bg-[#171d20] text-[#d3dbe0] font-mono text-sm flex flex-col">
      <div className="flex items-center justify-between px-4 sm:px-6 h-14 border-b border-[#3a444a] shrink-0">
        <span className="text-xs uppercase tracking-widest text-[#8fa3ad]">
          {step === "profile" ? "Set up your profile" : "Quick tour"}
        </span>
        <button
          onClick={handleSkipAll}
          disabled={saving}
          className="text-[10px] sm:text-xs uppercase tracking-widest text-[#5a6a72] hover:text-[#b7c4cc] disabled:opacity-50"
        >
          Skip for now
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-6 sm:py-10">
        {loading ? (
          <p className="text-xs text-[#5a6a72] text-center">Loading…</p>
        ) : step === "profile" ? (
          <div className="max-w-2xl mx-auto flex flex-col gap-6">
            <div>
              <h1 className="text-lg sm:text-xl font-bold text-[#d3dbe0]">
                Welcome to Telesto Node{profile.name ? `, ${profile.name.split(" ")[0]}` : ""}
              </h1>
              <p className="text-xs text-[#8fa3ad] mt-1">
                A few details help your team (and future you) make sense of your discoveries. You
                can change any of this later from your profile.
              </p>
            </div>

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
              <Field label="ORCID iD" hint="If you have one (orcid.org)">
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
                  rows={3}
                  maxLength={1000}
                  placeholder="A short summary of your research background and interests…"
                  className={`${inputClass} resize-none`}
                />
              </Field>
            </section>

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

            <section className="bg-[#1c2226] border border-[#3a444a] rounded-xl p-4 sm:p-5 flex flex-col gap-4">
              <h2 className="text-xs uppercase tracking-widest text-[#5a6a72]">
                Links &amp; contact
              </h2>
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

            <section className="bg-[#1c2226] border border-[#3a444a] rounded-xl p-4 sm:p-5 flex items-center justify-between gap-4">
              <div>
                <h2 className="text-xs uppercase tracking-widest text-[#5a6a72] mb-1">
                  Detection alert emails
                </h2>
                <p className="text-[11px] text-[#5a6a72]">
                  Get emailed when a high-confidence species detection fires during a live
                  session.
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

            {error && <p className="text-xs text-[#c47a6e]">{error}</p>}

            <div className="flex flex-col-reverse sm:flex-row items-center gap-3 pb-4">
              <button
                onClick={handleSkipProfile}
                disabled={saving}
                className="w-full sm:w-auto text-xs uppercase tracking-widest text-[#5a6a72] hover:text-[#b7c4cc] disabled:opacity-50"
              >
                Skip this step
              </button>
              <button
                onClick={handleContinueFromProfile}
                disabled={saving}
                className="w-full sm:w-auto sm:ml-auto bg-[#8fa3ad]/10 border border-[#8fa3ad]/60 rounded-lg px-5 py-2 text-xs uppercase tracking-widest text-[#d3dbe0] hover:bg-[#8fa3ad]/20 transition disabled:opacity-50"
              >
                {saving ? "Saving…" : "Continue"}
              </button>
            </div>
          </div>
        ) : (
          <div className="max-w-md mx-auto flex flex-col items-center text-center gap-6 py-4 sm:py-8">
            <div className="flex gap-1.5">
              {SLIDES.map((_, i) => (
                <span
                  key={i}
                  className={`h-1.5 rounded-full transition-all ${
                    i === slideIndex ? "w-6 bg-[#8fa3ad]" : "w-1.5 bg-[#3a444a]"
                  }`}
                />
              ))}
            </div>

            <div className="w-full bg-[#1c2226] border border-[#3a444a] rounded-xl p-6 sm:p-10 flex flex-col items-center gap-4 sm:gap-5 min-h-[280px] sm:min-h-[320px] justify-center">
              {(() => {
                const Slide = SLIDES[slideIndex];
                const Icon = Slide.icon;
                return (
                  <>
                    <div className="w-20 h-20 sm:w-24 sm:h-24 rounded-full bg-[#8fa3ad]/10 border border-[#8fa3ad]/40 flex items-center justify-center">
                      <Icon />
                    </div>
                    <h2 className="text-base sm:text-lg font-bold text-[#d3dbe0]">{Slide.title}</h2>
                    <p className="text-xs sm:text-sm text-[#b7c4cc] leading-relaxed">{Slide.body}</p>
                  </>
                );
              })()}
            </div>

            {error && <p className="text-xs text-[#c47a6e]">{error}</p>}

            <div className="w-full flex items-center gap-3">
              <button
                onClick={() => setSlideIndex((i) => Math.max(0, i - 1))}
                disabled={slideIndex === 0}
                className="border border-[#3a444a] rounded-lg px-4 py-2 text-xs uppercase tracking-widest text-[#b7c4cc] hover:bg-white/[0.08] disabled:opacity-30 disabled:cursor-not-allowed"
              >
                Back
              </button>

              {isLastSlide ? (
                <button
                  onClick={handleFinish}
                  disabled={saving}
                  className="flex-1 bg-[#8fa3ad]/10 border border-[#8fa3ad]/60 rounded-lg px-4 py-2 text-xs uppercase tracking-widest text-[#d3dbe0] hover:bg-[#8fa3ad]/20 transition disabled:opacity-50"
                >
                  {saving ? "Finishing…" : "Enter mission control"}
                </button>
              ) : (
                <button
                  onClick={() => setSlideIndex((i) => Math.min(SLIDES.length - 1, i + 1))}
                  className="flex-1 bg-[#8fa3ad]/10 border border-[#8fa3ad]/60 rounded-lg px-4 py-2 text-xs uppercase tracking-widest text-[#d3dbe0] hover:bg-[#8fa3ad]/20 transition"
                >
                  Next
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}