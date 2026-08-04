"use client";

import { Suspense, useEffect, useState } from "react";
import { useSession, signOut } from "next-auth/react";
import { useRouter, useSearchParams } from "next/navigation";
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

function ProfileContent() {
  const { data: session, status: sessionStatus, update: updateSession } = useSession();
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    if (sessionStatus === "unauthenticated") router.push("/login");
  }, [sessionStatus, router]);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState(null);
  const [clipCount, setClipCount] = useState(null);
  const [snapshotCount, setSnapshotCount] = useState(null);
  const [hasPassword, setHasPassword] = useState(true);

  const [emailFormOpen, setEmailFormOpen] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [emailSaving, setEmailSaving] = useState(false);
  const [emailMessage, setEmailMessage] = useState(null);

  // Two-factor authentication
  const [twoFactorEnabled, setTwoFactorEnabled] = useState(false);
  const [twoFAStep, setTwoFAStep] = useState("idle"); // idle | settingUp | showingBackupCodes | disabling
  const [qrCodeDataUrl, setQrCodeDataUrl] = useState(null);
  const [manualSecret, setManualSecret] = useState("");
  const [verifyCode, setVerifyCode] = useState("");
  const [backupCodes, setBackupCodes] = useState([]);
  const [twoFASaving, setTwoFASaving] = useState(false);
  const [twoFAMessage, setTwoFAMessage] = useState(null);
  const [disablePassword, setDisablePassword] = useState("");
  const [disableTotp, setDisableTotp] = useState("");

  // Download my data
  const [downloadingData, setDownloadingData] = useState(false);

  // Delete account
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deletePassword, setDeletePassword] = useState("");
  const [deleteTotp, setDeleteTotp] = useState("");
  const [deleteConfirmText, setDeleteConfirmText] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteMessage, setDeleteMessage] = useState(null);

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

  async function loadProfile() {
    setLoading(true);
    try {
      const res = await fetch("/api/profile");
      if (res.ok) {
        const data = await res.json();
        setProfile((prev) => ({ ...prev, ...data }));
        setHasPassword(Boolean(data.hasPassword));
        setTwoFactorEnabled(Boolean(data.twoFactorEnabled));
        return data;
      }
    } catch (err) {
      console.error("Failed to load profile:", err);
    } finally {
      setLoading(false);
    }
    return null;
  }

  useEffect(() => {
    if (sessionStatus !== "authenticated") return;

    loadProfile();

    async function loadStats() {
      const ownerEmail = session?.user?.email || "";
      try {
        const params = new URLSearchParams({ scope: "mine", owner_email: ownerEmail });
        const res = await fetch(`${API_BASE_URL}/clips?${params}`);
        if (res.ok) {
          const data = await res.json();
          setClipCount(Array.isArray(data) ? data.length : null);
        }
      } catch (err) {
        console.error("Failed to load clip stats:", err);
      }

      try {
        const params = new URLSearchParams({ owner_email: ownerEmail });
        const res = await fetch(`${API_BASE_URL}/snapshots/count?${params}`);
        if (res.ok) {
          const data = await res.json();
          setSnapshotCount(typeof data.count === "number" ? data.count : null);
        }
      } catch (err) {
        console.error("Failed to load snapshot stats:", err);
      }
    }
    loadStats();
  }, [sessionStatus, session?.user?.email]);

  useEffect(() => {
    const emailChange = searchParams.get("emailChange");
    if (!emailChange) return;

    async function handleReturnFromConfirmLink() {
      if (emailChange === "success") {
        const data = await loadProfile();
        if (data?.email) {
          // Refresh the JWT so session.user.email (used across the app for
          // owner_email lookups) reflects the new address immediately.
          await updateSession({ email: data.email });
        }
        setEmailMessage({ type: "success", text: "Email address confirmed and updated" });
      } else {
        const reason = searchParams.get("reason");
        const reasonText =
          {
            expired: "That confirmation link expired. Request the change again.",
            invalid_token: "That confirmation link isn't valid. Request the change again.",
            email_taken: "That email was claimed by another account before it could be confirmed.",
            missing_token: "That confirmation link is incomplete.",
          }[reason] || "Couldn't confirm that email change.";
        setEmailMessage({ type: "error", text: reasonText });
      }
      // Strip the query params so a page refresh doesn't replay this.
      router.replace("/profile");
    }
    handleReturnFromConfirmLink();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  useEffect(() => {
    if (!emailMessage) return;
    const t = setTimeout(() => setEmailMessage(null), 6000);
    return () => clearTimeout(t);
  }, [emailMessage]);

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

  async function handleChangeEmail() {
    setEmailSaving(true);
    setEmailMessage(null);
    try {
      const res = await fetch("/api/account/email", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          newEmail,
          ...(hasPassword ? { currentPassword } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Couldn't change email");

      // Nothing changes in the DB yet — the address still has to be
      // confirmed via the link we just emailed to it.
      setEmailFormOpen(false);
      setNewEmail("");
      setCurrentPassword("");
      setEmailMessage({
        type: "success",
        text: data.message || `Confirmation link sent to ${newEmail}`,
      });
    } catch (err) {
      setEmailMessage({ type: "error", text: err.message || "Couldn't change email" });
    } finally {
      setEmailSaving(false);
    }
  }

  async function handleStartTwoFactorSetup() {
    setTwoFASaving(true);
    setTwoFAMessage(null);
    try {
      const res = await fetch("/api/account/2fa/setup", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Couldn't start 2FA setup");
      setQrCodeDataUrl(data.qrCodeDataUrl);
      setManualSecret(data.secret);
      setTwoFAStep("settingUp");
    } catch (err) {
      setTwoFAMessage({ type: "error", text: err.message || "Couldn't start 2FA setup" });
    } finally {
      setTwoFASaving(false);
    }
  }

  async function handleVerifyTwoFactor() {
    setTwoFASaving(true);
    setTwoFAMessage(null);
    try {
      const res = await fetch("/api/account/2fa/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: verifyCode }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Couldn't verify code");
      setBackupCodes(data.backupCodes);
      setTwoFactorEnabled(true);
      setTwoFAStep("showingBackupCodes");
      setVerifyCode("");
    } catch (err) {
      setTwoFAMessage({ type: "error", text: err.message || "Couldn't verify code" });
    } finally {
      setTwoFASaving(false);
    }
  }

  function handleFinishTwoFactorSetup() {
    // Backup codes are only ever shown once (this exact moment) — closing
    // this out discards them from memory. The user was told to save them.
    setTwoFAStep("idle");
    setBackupCodes([]);
    setQrCodeDataUrl(null);
    setManualSecret("");
    setTwoFAMessage({ type: "success", text: "Two-factor authentication is now enabled" });
  }

  async function handleDisableTwoFactor() {
    setTwoFASaving(true);
    setTwoFAMessage(null);
    try {
      const res = await fetch("/api/account/2fa/disable", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(hasPassword ? { currentPassword: disablePassword } : {}),
          totpCode: disableTotp || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Couldn't disable 2FA");
      setTwoFactorEnabled(false);
      setTwoFAStep("idle");
      setDisablePassword("");
      setDisableTotp("");
      setTwoFAMessage({ type: "success", text: "Two-factor authentication disabled" });
    } catch (err) {
      setTwoFAMessage({ type: "error", text: err.message || "Couldn't disable 2FA" });
    } finally {
      setTwoFASaving(false);
    }
  }

  async function handleDownloadData() {
    setDownloadingData(true);
    try {
      const res = await fetch("/api/account/export");
      if (!res.ok) throw new Error("Export failed");
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `telesto-node-data-export-${Date.now()}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
    } catch (err) {
      console.error("Data export failed:", err);
    } finally {
      setDownloadingData(false);
    }
  }

  async function handleDeleteAccount() {
    setDeleting(true);
    setDeleteMessage(null);
    try {
      const res = await fetch("/api/account/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(hasPassword ? { currentPassword: deletePassword } : {}),
          ...(twoFactorEnabled ? { totpCode: deleteTotp } : {}),
          confirmationText: deleteConfirmText,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Couldn't delete account");

      // Account is gone server-side — sign out locally and leave.
      await signOut({ callbackUrl: "/login" });
    } catch (err) {
      setDeleteMessage({ type: "error", text: err.message || "Couldn't delete account" });
      setDeleting(false);
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
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-8">
              <div className="bg-[#1c2226] border border-[#3a444a] rounded-xl px-4 py-3">
                <p className="text-[10px] uppercase tracking-widest text-[#8fa3ad]">Clips saved</p>
                <p className="text-lg font-bold">{clipCount === null ? "—" : clipCount}</p>
              </div>
              <div className="bg-[#1c2226] border border-[#3a444a] rounded-xl px-4 py-3">
                <p className="text-[10px] uppercase tracking-widest text-[#8fa3ad]">Snapshots taken</p>
                <p className="text-lg font-bold">{snapshotCount === null ? "—" : snapshotCount}</p>
              </div>
              <div className="bg-[#1c2226] border border-[#3a444a] rounded-xl px-4 py-3 col-span-2 sm:col-span-1">
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

            <div className="flex flex-col gap-8 pb-8">
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

              {/* Account & security */}
              <section className="bg-[#1c2226] border border-[#3a444a] rounded-xl p-4 sm:p-5 flex flex-col gap-4">
                <h2 className="text-xs uppercase tracking-widest text-[#5a6a72]">
                  Account &amp; security
                </h2>

                <div>
                  <p className="text-[10px] uppercase tracking-widest text-[#8fa3ad] mb-1.5">
                    Login email
                  </p>
                  <div className="flex items-center gap-3 flex-wrap">
                    <span className="text-sm text-[#d3dbe0]">{profile.email}</span>
                    {!emailFormOpen && (
                      <button
                        type="button"
                        onClick={() => {
                          setEmailFormOpen(true);
                          setNewEmail(profile.email);
                        }}
                        className="text-xs uppercase tracking-widest text-[#8fa3ad] hover:text-[#d3dbe0]"
                      >
                        Change
                      </button>
                    )}
                  </div>

                  {emailFormOpen && (
                    <div className="mt-3 flex flex-col gap-3 bg-black/20 border border-[#3a444a] rounded-lg p-3">
                      <p className="text-[11px] text-[#5a6a72]">
                        We'll send a confirmation link to the new address. Nothing changes until you
                        click it.
                      </p>
                      <Field label="New email">
                        <input
                          type="email"
                          value={newEmail}
                          onChange={(e) => setNewEmail(e.target.value)}
                          className={inputClass}
                        />
                      </Field>
                      {hasPassword && (
                        <Field label="Current password" hint="Required to confirm this request">
                          <input
                            type="password"
                            value={currentPassword}
                            onChange={(e) => setCurrentPassword(e.target.value)}
                            className={inputClass}
                          />
                        </Field>
                      )}
                      {!hasPassword && (
                        <p className="text-[11px] text-[#5a6a72]">
                          This account signs in with Google, so no password confirmation is needed.
                        </p>
                      )}
                      <div className="flex items-center gap-3">
                        <button
                          type="button"
                          onClick={handleChangeEmail}
                          disabled={emailSaving || !newEmail}
                          className="bg-[#8fa3ad]/10 border border-[#8fa3ad]/60 rounded-lg px-4 py-1.5 text-xs uppercase tracking-widest hover:bg-[#8fa3ad]/20 disabled:opacity-50"
                        >
                          {emailSaving ? "Sending…" : "Send confirmation link"}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setEmailFormOpen(false);
                            setNewEmail("");
                            setCurrentPassword("");
                          }}
                          className="text-xs uppercase tracking-widest text-[#5a6a72] hover:text-[#b7c4cc]"
                        >
                          Cancel
                        </button>
                        {emailMessage && (
                          <span
                            className={`text-xs ${
                              emailMessage.type === "success" ? "text-[#8fa3ad]" : "text-[#c47a6e]"
                            }`}
                          >
                            {emailMessage.text}
                          </span>
                        )}
                      </div>
                    </div>
                  )}
                  {!emailFormOpen && emailMessage && (
                    <p
                      className={`text-xs mt-2 ${
                        emailMessage.type === "success" ? "text-[#8fa3ad]" : "text-[#c47a6e]"
                      }`}
                    >
                      {emailMessage.text}
                    </p>
                  )}
                </div>

                {/* Two-factor authentication */}
                <div className="pt-3 border-t border-[#3a444a]">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-[10px] uppercase tracking-widest text-[#8fa3ad] mb-1">
                        Two-factor authentication
                      </p>
                      <p className="text-[11px] text-[#5a6a72]">
                        {twoFactorEnabled
                          ? "Enabled — an authenticator code is required at sign-in"
                          : "Not enabled"}
                      </p>
                    </div>
                    {twoFAStep === "idle" && !twoFactorEnabled && (
                      <button
                        type="button"
                        onClick={handleStartTwoFactorSetup}
                        disabled={twoFASaving}
                        className="text-xs uppercase tracking-widest text-[#8fa3ad] hover:text-[#d3dbe0] disabled:opacity-50"
                      >
                        {twoFASaving ? "Starting..." : "Enable"}
                      </button>
                    )}
                    {twoFAStep === "idle" && twoFactorEnabled && (
                      <button
                        type="button"
                        onClick={() => setTwoFAStep("disabling")}
                        className="text-xs uppercase tracking-widest text-[#c47a6e] hover:text-[#d99a8f]"
                      >
                        Disable
                      </button>
                    )}
                  </div>

                  {twoFAStep === "settingUp" && (
                    <div className="mt-3 flex flex-col gap-3 bg-black/20 border border-[#3a444a] rounded-lg p-3">
                      <p className="text-[11px] text-[#5a6a72]">
                        Scan this with an authenticator app (Google Authenticator, Authy, 1Password, etc.), then enter the 6-digit code it generates.
                      </p>
                      {qrCodeDataUrl && (
                        /* eslint-disable-next-line @next/next/no-img-element */
                        <img
                          src={qrCodeDataUrl}
                          alt="Two-factor authentication QR code"
                          className="w-40 h-40 self-center bg-white p-2 rounded-lg"
                        />
                      )}
                      <Field label="Can't scan? Enter this code manually">
                        <p className="text-xs font-bold text-[#d3dbe0] break-all bg-black/30 rounded px-2 py-1.5">
                          {manualSecret}
                        </p>
                      </Field>
                      <Field label="6-digit code">
                        <input
                          type="text"
                          value={verifyCode}
                          onChange={(e) => setVerifyCode(e.target.value)}
                          placeholder="123456"
                          className={`${inputClass} tracking-widest text-center`}
                        />
                      </Field>
                      <div className="flex items-center gap-3">
                        <button
                          type="button"
                          onClick={handleVerifyTwoFactor}
                          disabled={twoFASaving || !verifyCode}
                          className="bg-[#8fa3ad]/10 border border-[#8fa3ad]/60 rounded-lg px-4 py-1.5 text-xs uppercase tracking-widest hover:bg-[#8fa3ad]/20 disabled:opacity-50"
                        >
                          {twoFASaving ? "Verifying..." : "Verify & enable"}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setTwoFAStep("idle");
                            setQrCodeDataUrl(null);
                            setManualSecret("");
                            setVerifyCode("");
                          }}
                          className="text-xs uppercase tracking-widest text-[#5a6a72] hover:text-[#b7c4cc]"
                        >
                          Cancel
                        </button>
                      </div>
                      {twoFAMessage?.type === "error" && (
                        <p className="text-xs text-[#c47a6e]">{twoFAMessage.text}</p>
                      )}
                    </div>
                  )}

                  {twoFAStep === "showingBackupCodes" && (
                    <div className="mt-3 flex flex-col gap-3 bg-black/20 border border-[#a48a55] rounded-lg p-3">
                      <p className="text-[11px] text-[#d8b877]">
                        Save these backup codes somewhere safe -- each works once, and this is the only time they'll be shown. Use one if you lose access to your authenticator app.
                      </p>
                      <div className="grid grid-cols-2 gap-1.5 bg-black/30 rounded-lg p-3">
                        {backupCodes.map((code) => (
                          <span key={code} className="text-xs font-bold text-[#d3dbe0] text-center">
                            {code}
                          </span>
                        ))}
                      </div>
                      <button
                        type="button"
                        onClick={handleFinishTwoFactorSetup}
                        className="bg-[#8fa3ad]/10 border border-[#8fa3ad]/60 rounded-lg px-4 py-1.5 text-xs uppercase tracking-widest hover:bg-[#8fa3ad]/20"
                      >
                        I've saved these -- done
                      </button>
                    </div>
                  )}

                  {twoFAStep === "disabling" && (
                    <div className="mt-3 flex flex-col gap-3 bg-black/20 border border-[#3a444a] rounded-lg p-3">
                      <p className="text-[11px] text-[#5a6a72]">
                        Confirm with your password{hasPassword ? " and/or" : " or"} a current 2FA code.
                      </p>
                      {hasPassword && (
                        <Field label="Current password">
                          <input
                            type="password"
                            value={disablePassword}
                            onChange={(e) => setDisablePassword(e.target.value)}
                            className={inputClass}
                          />
                        </Field>
                      )}
                      <Field label="2FA code (or backup code)">
                        <input
                          type="text"
                          value={disableTotp}
                          onChange={(e) => setDisableTotp(e.target.value)}
                          className={inputClass}
                        />
                      </Field>
                      <div className="flex items-center gap-3">
                        <button
                          type="button"
                          onClick={handleDisableTwoFactor}
                          disabled={twoFASaving || (!disablePassword && !disableTotp)}
                          className="bg-[#c47a6e]/10 border border-[#c47a6e]/60 rounded-lg px-4 py-1.5 text-xs uppercase tracking-widest text-[#d99a8f] hover:bg-[#c47a6e]/20 disabled:opacity-50"
                        >
                          {twoFASaving ? "Disabling..." : "Disable 2FA"}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setTwoFAStep("idle");
                            setDisablePassword("");
                            setDisableTotp("");
                          }}
                          className="text-xs uppercase tracking-widest text-[#5a6a72] hover:text-[#b7c4cc]"
                        >
                          Cancel
                        </button>
                      </div>
                      {twoFAMessage?.type === "error" && (
                        <p className="text-xs text-[#c47a6e]">{twoFAMessage.text}</p>
                      )}
                    </div>
                  )}

                  {twoFAStep === "idle" && twoFAMessage && (
                    <p
                      className={`text-xs mt-2 ${
                        twoFAMessage.type === "success" ? "text-[#8fa3ad]" : "text-[#c47a6e]"
                      }`}
                    >
                      {twoFAMessage.text}
                    </p>
                  )}
                </div>

                <div className="pt-3 border-t border-[#3a444a] flex items-center justify-between">
                  <p className="text-[11px] text-[#5a6a72]">Signed in to Telesto Node mission control</p>
                  <button
                    type="button"
                    onClick={() => signOut({ callbackUrl: "/login" })}
                    className="text-xs uppercase tracking-widest text-[#c47a6e] hover:text-[#d99a8f]"
                  >
                    Sign out
                  </button>
                </div>
              </section>

              {/* Links & contact */}
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
              <div className="flex items-center gap-3">
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

              {/* Data & privacy */}
              <section className="bg-[#1c2226] border border-[#3a444a] rounded-xl p-4 sm:p-5 flex items-center justify-between gap-4">
                <div>
                  <h2 className="text-xs uppercase tracking-widest text-[#5a6a72] mb-1">
                    Data &amp; privacy
                  </h2>
                  <p className="text-[11px] text-[#5a6a72]">
                    Download a copy of your profile, clips, and snapshots as a JSON file.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={handleDownloadData}
                  disabled={downloadingData}
                  className="shrink-0 bg-[#8fa3ad]/10 border border-[#8fa3ad]/60 rounded-lg px-4 py-2 text-xs uppercase tracking-widest text-[#d3dbe0] hover:bg-[#8fa3ad]/20 transition disabled:opacity-50"
                >
                  {downloadingData ? "Preparing…" : "Download my data"}
                </button>
              </section>

              {/* Danger zone */}
              <section className="bg-[#c47a6e]/5 border border-[#c47a6e]/40 rounded-xl p-4 sm:p-5 flex flex-col gap-4">
                <h2 className="text-xs uppercase tracking-widest text-[#c47a6e]">Danger zone</h2>

                {!deleteOpen ? (
                  <div className="flex items-center justify-between gap-4">
                    <p className="text-[11px] text-[#5a6a72]">
                      Permanently delete your account, profile, clips, and snapshots. This can't be undone.
                    </p>
                    <button
                      type="button"
                      onClick={() => setDeleteOpen(true)}
                      className="shrink-0 bg-[#c47a6e]/10 border border-[#c47a6e]/60 rounded-lg px-4 py-2 text-xs uppercase tracking-widest text-[#d99a8f] hover:bg-[#c47a6e]/20 transition"
                    >
                      Delete account
                    </button>
                  </div>
                ) : (
                  <div className="flex flex-col gap-3">
                    <p className="text-[11px] text-[#d99a8f]">
                      This permanently deletes your account, profile, clips, and snapshots. There is no way to undo this.
                    </p>
                    {hasPassword && (
                      <Field label="Current password">
                        <input
                          type="password"
                          value={deletePassword}
                          onChange={(e) => setDeletePassword(e.target.value)}
                          className={inputClass}
                        />
                      </Field>
                    )}
                    {twoFactorEnabled && (
                      <Field label="2FA code (or backup code)">
                        <input
                          type="text"
                          value={deleteTotp}
                          onChange={(e) => setDeleteTotp(e.target.value)}
                          className={inputClass}
                        />
                      </Field>
                    )}
                    <Field label={'Type "DELETE" to confirm'}>
                      <input
                        type="text"
                        value={deleteConfirmText}
                        onChange={(e) => setDeleteConfirmText(e.target.value)}
                        placeholder="DELETE"
                        className={inputClass}
                      />
                    </Field>
                    <div className="flex items-center gap-3">
                      <button
                        type="button"
                        onClick={handleDeleteAccount}
                        disabled={
                          deleting ||
                          deleteConfirmText !== "DELETE" ||
                          (hasPassword && !deletePassword) ||
                          (twoFactorEnabled && !deleteTotp)
                        }
                        className="bg-[#c47a6e] border border-[#c47a6e] rounded-lg px-4 py-1.5 text-xs uppercase tracking-widest text-[#171d20] font-bold hover:bg-[#d99a8f] disabled:opacity-40"
                      >
                        {deleting ? "Deleting…" : "Permanently delete my account"}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setDeleteOpen(false);
                          setDeletePassword("");
                          setDeleteTotp("");
                          setDeleteConfirmText("");
                          setDeleteMessage(null);
                        }}
                        className="text-xs uppercase tracking-widest text-[#5a6a72] hover:text-[#b7c4cc]"
                      >
                        Cancel
                      </button>
                    </div>
                    {deleteMessage?.type === "error" && (
                      <p className="text-xs text-[#c47a6e]">{deleteMessage.text}</p>
                    )}
                  </div>
                )}
              </section>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default function ProfilePage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-[#171d20] text-[#d3dbe0] flex items-center justify-center font-mono text-sm">
          Loading profile…
        </div>
      }
    >
      <ProfileContent />
    </Suspense>
  );
}