"use client";

import { useEffect, useState } from "react";
import CallPanel from "./CallPanel";
import {
  cancelMeeting,
  createMeeting,
  getCallRoom,
  listMeetings,
  meetingIcsUrl,
  postMessage,
} from "../lib/workspaceApi";

function ScheduleMeetingForm({ channelId, currentEmail, onScheduled }) {
  const [title, setTitle] = useState("");
  const [when, setWhen] = useState("");
  const [duration, setDuration] = useState(30);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  async function handleSubmit() {
    if (!title.trim() || !when) {
      setError("Give it a title and a time");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const meeting = await createMeeting(channelId, {
        title: title.trim(),
        scheduledAt: new Date(when).toISOString(),
        durationMinutes: Number(duration) || 30,
        createdBy: currentEmail,
      });
      onScheduled(meeting);
      setTitle("");
      setWhen("");
    } catch (err) {
      setError(err.message || "Couldn't schedule that meeting");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="bg-[#1c2226] border border-[#3a444a] rounded-xl p-4 flex flex-col gap-3">
      <h3 className="text-[10px] uppercase tracking-widest text-[#8fa3ad]">Schedule a meeting</h3>
      <input
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="e.g. Weekly dive planning"
        className="bg-black/20 border border-[#3a444a] rounded-lg px-3 py-2 text-sm text-[#d3dbe0] placeholder-[#5a6a72] outline-none focus:border-[#8fa3ad]"
      />
      <div className="flex gap-3">
        <input
          type="datetime-local"
          value={when}
          onChange={(e) => setWhen(e.target.value)}
          className="flex-1 bg-black/20 border border-[#3a444a] rounded-lg px-3 py-2 text-sm text-[#d3dbe0] outline-none focus:border-[#8fa3ad]"
        />
        <select
          value={duration}
          onChange={(e) => setDuration(e.target.value)}
          className="bg-black/20 border border-[#3a444a] rounded-lg px-2 py-2 text-sm text-[#d3dbe0] outline-none focus:border-[#8fa3ad]"
        >
          <option value={15}>15 min</option>
          <option value={30}>30 min</option>
          <option value={60}>1 hr</option>
          <option value={90}>1.5 hr</option>
        </select>
      </div>
      {error && <p className="text-xs text-[#c47a6e]">{error}</p>}
      <button
        type="button"
        onClick={handleSubmit}
        disabled={saving}
        className="self-start bg-[#8fa3ad]/10 border border-[#8fa3ad]/60 rounded-lg px-4 py-2 text-xs uppercase tracking-widest text-[#d3dbe0] hover:bg-[#8fa3ad]/20 transition disabled:opacity-50"
      >
        {saving ? "Scheduling…" : "Schedule"}
      </button>
    </div>
  );
}

function MeetingRow({ meeting, currentEmail, isAdmin, onJoin, onCancelled }) {
  const [cancelling, setCancelling] = useState(false);
  const canCancel = meeting.created_by === currentEmail || isAdmin;

  async function handleCancel() {
    if (!window.confirm(`Cancel "${meeting.title}"?`)) return;
    setCancelling(true);
    try {
      await cancelMeeting(meeting.id, currentEmail);
      onCancelled(meeting.id);
    } catch (err) {
      console.error("Cancel meeting failed:", err);
    } finally {
      setCancelling(false);
    }
  }

  const when = new Date(meeting.scheduled_at);

  return (
    <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-[#3a444a]/50">
      <div className="min-w-0">
        <p className="text-sm text-[#d3dbe0] truncate">{meeting.title}</p>
        <p className="text-[11px] text-[#5a6a72]">
          {when.toLocaleDateString([], { month: "short", day: "numeric" })} ·{" "}
          {when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · {meeting.duration_minutes} min
        </p>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <a
          href={meetingIcsUrl(meeting.id, currentEmail)}
          className="text-[10px] uppercase tracking-widest text-[#5a6a72] hover:text-[#8fa3ad]"
          title="Add to your calendar app"
        >
          Add to calendar
        </a>
        <button
          type="button"
          onClick={() => onJoin(meeting.jitsi_room)}
          className="text-[10px] uppercase tracking-widest text-[#8fa3ad] hover:text-[#d3dbe0]"
        >
          Join
        </button>
        {canCancel && (
          <button
            type="button"
            disabled={cancelling}
            onClick={handleCancel}
            className="text-[10px] uppercase tracking-widest text-[#5a6a72] hover:text-[#c47a6e] disabled:opacity-40"
          >
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}

export default function CallsTab({ channelId, currentEmail, isAdmin }) {
  const [callRoom, setCallRoom] = useState(null);
  const [activeRoom, setActiveRoom] = useState(null); // room currently shown in CallPanel, if any
  const [meetings, setMeetings] = useState([]);
  const [loading, setLoading] = useState(true);

  function reloadMeetings() {
    listMeetings(channelId, currentEmail)
      .then((result) => setMeetings(result.filter((m) => new Date(m.scheduled_at) > new Date())))
      .catch((err) => console.error("Failed to load meetings:", err));
  }

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getCallRoom(channelId, currentEmail)
      .then((result) => {
        if (!cancelled) setCallRoom(result.room);
      })
      .catch((err) => console.error("Failed to get call room:", err))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    reloadMeetings();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId, currentEmail]);

  function startOrJoinPersistentCall() {
    if (!callRoom) return;
    setActiveRoom(callRoom);
    postMessage(channelId, {
      senderEmail: currentEmail,
      text: "Call started — join from the Calls tab.",
    }).catch((err) => console.error("Call announcement failed:", err));
  }

  if (activeRoom) {
    return (
      <div className="h-full flex flex-col">
        <div className="px-4 sm:px-6 py-2 border-b border-[#3a444a] flex items-center justify-between">
          <p className="text-xs text-[#5a6a72]">In call — meet.jit.si (free, no account required)</p>
          <button
            type="button"
            onClick={() => setActiveRoom(null)}
            className="text-[10px] uppercase tracking-widest text-[#c47a6e] hover:text-[#d3dbe0]"
          >
            Leave
          </button>
        </div>
        <div className="flex-1 min-h-0">
          <CallPanel room={activeRoom} displayName={currentEmail} onLeave={() => setActiveRoom(null)} />
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto px-4 sm:px-6 py-5 flex flex-col gap-5 max-w-xl">
      <div className="bg-[#1c2226] border border-[#3a444a] rounded-xl p-4 flex items-center justify-between gap-4">
        <div>
          <h3 className="text-sm font-bold text-[#d3dbe0]">This channel's call room</h3>
          <p className="text-[11px] text-[#5a6a72]">
            Always the same room for everyone here — free, via meet.jit.si.
          </p>
        </div>
        <button
          type="button"
          onClick={startOrJoinPersistentCall}
          disabled={loading || !callRoom}
          className="shrink-0 bg-[#8fa3ad]/10 border border-[#8fa3ad]/60 rounded-lg px-4 py-2 text-xs uppercase tracking-widest text-[#d3dbe0] hover:bg-[#8fa3ad]/20 transition disabled:opacity-50"
        >
          {loading ? "Loading…" : "Start / Join call"}
        </button>
      </div>

      <ScheduleMeetingForm
        channelId={channelId}
        currentEmail={currentEmail}
        onScheduled={(meeting) => setMeetings((prev) => [...prev, meeting])}
      />

      <div className="bg-[#1c2226] border border-[#3a444a] rounded-xl overflow-hidden">
        <h3 className="text-[10px] uppercase tracking-widest text-[#8fa3ad] px-4 pt-3 pb-2">
          Upcoming meetings
        </h3>
        {meetings.length === 0 ? (
          <p className="px-4 pb-4 text-xs text-[#5a6a72]">Nothing scheduled yet.</p>
        ) : (
          meetings
            .sort((a, b) => new Date(a.scheduled_at) - new Date(b.scheduled_at))
            .map((m) => (
              <MeetingRow
                key={m.id}
                meeting={m}
                currentEmail={currentEmail}
                isAdmin={isAdmin}
                onJoin={setActiveRoom}
                onCancelled={(id) => setMeetings((prev) => prev.filter((x) => x.id !== id))}
              />
            ))
        )}
      </div>
    </div>
  );
}