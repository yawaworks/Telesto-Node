"use client";

import { useState } from "react";

const inputClass =
  "w-full bg-black/20 border border-[#3a444a] rounded-lg px-3 py-2 text-sm text-[#d3dbe0] placeholder-[#5a6a72] outline-none focus:border-[#8fa3ad]";

export default function CreateChannelModal({ createdBy, onClose, onCreated, createChannelFn }) {
  const [name, setName] = useState("");
  const [memberDraft, setMemberDraft] = useState("");
  const [members, setMembers] = useState([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  function commitMemberDraft() {
    const v = memberDraft.trim();
    if (v && !members.includes(v)) setMembers([...members, v]);
    setMemberDraft("");
  }

  function handleMemberKeyDown(e) {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      commitMemberDraft();
    } else if (e.key === "Backspace" && !memberDraft && members.length > 0) {
      setMembers(members.slice(0, -1));
    }
  }

  async function handleCreate() {
    if (!name.trim()) {
      setError("Give the channel a name first");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const channel = await createChannelFn({
        name: name.trim(),
        type: "project",
        memberEmails: members,
        createdBy,
      });
      onCreated(channel);
    } catch (err) {
      setError(err.message || "Couldn't create the channel");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 px-4">
      <div className="w-full max-w-md bg-[#1c2226] border border-[#3a444a] rounded-xl p-5 sm:p-6 flex flex-col gap-4">
        <h2 className="text-sm uppercase tracking-widest text-[#d3dbe0]">New channel</h2>

        <div>
          <p className="text-[10px] uppercase tracking-widest text-[#8fa3ad] mb-1.5">Channel name</p>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Coral Triangle Expedition"
            className={inputClass}
            autoFocus
          />
        </div>

        <div>
          <p className="text-[10px] uppercase tracking-widest text-[#8fa3ad] mb-1.5">
            Invite teammates
          </p>
          <p className="text-[11px] text-[#5a6a72] mb-2">
            Press Enter or comma to add each email. You'll be added automatically.
          </p>
          <div className="flex flex-wrap gap-1.5 bg-black/20 border border-[#3a444a] rounded-lg px-2.5 py-2 focus-within:border-[#8fa3ad]">
            {members.map((m) => (
              <span
                key={m}
                className="flex items-center gap-1 bg-[#8fa3ad]/10 border border-[#8fa3ad]/40 rounded-md pl-2 pr-1 py-0.5 text-xs text-[#b7c4cc]"
              >
                {m}
                <button
                  type="button"
                  onClick={() => setMembers(members.filter((x) => x !== m))}
                  className="text-[#8fa3ad] hover:text-[#d3dbe0] px-1"
                  aria-label={`Remove ${m}`}
                >
                  ✕
                </button>
              </span>
            ))}
            <input
              type="email"
              value={memberDraft}
              onChange={(e) => setMemberDraft(e.target.value)}
              onKeyDown={handleMemberKeyDown}
              onBlur={commitMemberDraft}
              placeholder="teammate@institution.edu"
              className="flex-1 min-w-[140px] bg-transparent text-sm text-[#d3dbe0] placeholder-[#5a6a72] outline-none py-0.5"
            />
          </div>
        </div>

        {error && <p className="text-xs text-[#c47a6e]">{error}</p>}

        <div className="flex items-center gap-3 pt-1">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="flex-1 border border-[#3a444a] rounded-lg px-4 py-2 text-xs uppercase tracking-widest text-[#b7c4cc] hover:bg-white/[0.08] disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleCreate}
            disabled={saving}
            className="flex-1 bg-[#8fa3ad]/10 border border-[#8fa3ad]/60 rounded-lg px-4 py-2 text-xs uppercase tracking-widest text-[#d3dbe0] hover:bg-[#8fa3ad]/20 transition disabled:opacity-50"
          >
            {saving ? "Creating…" : "Create channel"}
          </button>
        </div>
      </div>
    </div>
  );
}