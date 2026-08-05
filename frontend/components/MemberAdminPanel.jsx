"use client";

import { useEffect, useState } from "react";
import Avatar from "./Avatar";
import { listChannelReports, resolveReport } from "../lib/workspaceApi";

function MembersTab({ channel, presence, currentEmail, isAdmin, onPromote, onDemote, onRemove }) {
  const [busyEmail, setBusyEmail] = useState(null);

  async function run(email, fn) {
    setBusyEmail(email);
    try {
      await fn(email);
    } finally {
      setBusyEmail(null);
    }
  }

  return (
    <div className="max-h-72 overflow-y-auto py-1">
      {channel.members.map((email) => {
        const status = presence[email]?.status || "offline";
        const memberIsAdmin = channel.admins.includes(email);
        const isCreator = email === channel.created_by;
        const busy = busyEmail === email;

        return (
          <div key={email} className="flex items-center gap-2.5 px-4 py-2">
            <Avatar email={email} size="sm" status={status} />
            <div className="min-w-0 flex-1">
              <p className="text-xs text-[#d3dbe0] truncate">
                {email} {isCreator && <span className="text-[#8fa3ad]">· Creator</span>}
                {!isCreator && memberIsAdmin && <span className="text-[#8fa3ad]">· Admin</span>}
              </p>
              <p className="text-[10px] text-[#5a6a72] capitalize">{status}</p>
            </div>
            {isAdmin && !isCreator && email !== currentEmail && (
              <div className="flex items-center gap-1 shrink-0">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => run(email, memberIsAdmin ? onDemote : onPromote)}
                  className="text-[10px] uppercase tracking-widest text-[#5a6a72] hover:text-[#8fa3ad] disabled:opacity-40"
                >
                  {memberIsAdmin ? "Demote" : "Promote"}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => run(email, onRemove)}
                  className="text-[10px] uppercase tracking-widest text-[#5a6a72] hover:text-[#c47a6e] disabled:opacity-40"
                >
                  Remove
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ReportsTab({ channelId, currentEmail }) {
  const [reports, setReports] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);

  function reload() {
    setLoading(true);
    listChannelReports(channelId, currentEmail)
      .then(setReports)
      .catch((err) => console.error("Failed to load reports:", err))
      .finally(() => setLoading(false));
  }

  useEffect(reload, [channelId, currentEmail]);

  async function handleResolve(reportId, action) {
    setBusyId(reportId);
    try {
      await resolveReport(reportId, { requestedBy: currentEmail, action });
      reload();
    } catch (err) {
      console.error("Resolve report failed:", err);
    } finally {
      setBusyId(null);
    }
  }

  const open = reports.filter((r) => !r.resolved);

  return (
    <div className="max-h-72 overflow-y-auto py-1">
      {loading && <p className="px-4 py-3 text-xs text-[#5a6a72]">Loading reports…</p>}
      {!loading && open.length === 0 && (
        <p className="px-4 py-3 text-xs text-[#5a6a72]">No open reports for this channel.</p>
      )}
      {open.map((r) => (
        <div key={r.id} className="px-4 py-2.5 border-b border-[#3a444a]/50">
          <p className="text-xs text-[#d3dbe0]">Reported by {r.reported_by}</p>
          {r.reason && <p className="text-xs text-[#5a6a72] mt-0.5">"{r.reason}"</p>}
          <div className="flex items-center gap-3 mt-1.5">
            <button
              type="button"
              disabled={busyId === r.id}
              onClick={() => handleResolve(r.id, "dismiss")}
              className="text-[10px] uppercase tracking-widest text-[#5a6a72] hover:text-[#8fa3ad] disabled:opacity-40"
            >
              Dismiss
            </button>
            <button
              type="button"
              disabled={busyId === r.id}
              onClick={() => handleResolve(r.id, "delete_message")}
              className="text-[10px] uppercase tracking-widest text-[#5a6a72] hover:text-[#c47a6e] disabled:opacity-40"
            >
              Delete message
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

export default function MemberAdminPanel({
  channel,
  presence,
  currentEmail,
  isAdmin,
  onClose,
  onPromote,
  onDemote,
  onRemove,
}) {
  const [tab, setTab] = useState("members");

  return (
    <div className="absolute right-4 sm:right-6 top-14 z-30 w-72 bg-[#1c2226] border border-[#3a444a] rounded-xl shadow-lg overflow-hidden">
      <div className="px-4 py-3 border-b border-[#3a444a] flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setTab("members")}
            className={`text-[10px] uppercase tracking-widest ${
              tab === "members" ? "text-[#d3dbe0]" : "text-[#5a6a72] hover:text-[#b7c4cc]"
            }`}
          >
            {channel.members.length} member{channel.members.length === 1 ? "" : "s"}
          </button>
          {isAdmin && (
            <button
              type="button"
              onClick={() => setTab("reports")}
              className={`text-[10px] uppercase tracking-widest ${
                tab === "reports" ? "text-[#d3dbe0]" : "text-[#5a6a72] hover:text-[#b7c4cc]"
              }`}
            >
              Reports
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-[#5a6a72] hover:text-[#d3dbe0] text-sm leading-none"
          aria-label="Close panel"
        >
          ✕
        </button>
      </div>

      {tab === "members" ? (
        <MembersTab
          channel={channel}
          presence={presence}
          currentEmail={currentEmail}
          isAdmin={isAdmin}
          onPromote={onPromote}
          onDemote={onDemote}
          onRemove={onRemove}
        />
      ) : (
        <ReportsTab channelId={channel.id} currentEmail={currentEmail} />
      )}
    </div>
  );
}