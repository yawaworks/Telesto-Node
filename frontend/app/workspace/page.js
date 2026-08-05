"use client";

import { useEffect, useMemo, useState } from "react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";

import AppRail from "../../components/AppRail";
import Avatar from "../../components/Avatar";
import ChannelSidebar from "../../components/ChannelSidebar";
import ChatPanel from "../../components/ChatPanel";
import CreateChannelModal from "../../components/CreateChannelModal";
import MissionControl from "../../components/MissionControl";
import { createChannel, listChannels } from "../../lib/workspaceApi";
import { useHeartbeat, usePresence } from "../../lib/usePresence";

const TABS = [
  { id: "chat", label: "Chat" },
  { id: "mission", label: "Mission Control" },
  { id: "files", label: "Files" },
  { id: "reports", label: "Reports" },
];

const AVATAR_STACK_LIMIT = 4;

function MemberStack({ members, presence, onClick }) {
  const shown = members.slice(0, AVATAR_STACK_LIMIT);
  const overflow = members.length - shown.length;

  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center -space-x-2 pl-1 pr-2 py-1 rounded-full hover:bg-white/[0.06] transition"
      title="View members"
    >
      {shown.map((email) => (
        <Avatar key={email} email={email} size="sm" online={Boolean(presence[email]?.online)} ring />
      ))}
      {overflow > 0 && (
        <span className="w-6 h-6 rounded-full bg-[#3a444a] ring-2 ring-[#171d20] flex items-center justify-center text-[10px] font-bold text-[#d3dbe0]">
          +{overflow}
        </span>
      )}
    </button>
  );
}

function MemberPanel({ members, presence, onClose }) {
  return (
    <div className="absolute right-4 sm:right-6 top-14 z-30 w-64 bg-[#1c2226] border border-[#3a444a] rounded-xl shadow-lg overflow-hidden">
      <div className="px-4 py-3 border-b border-[#3a444a] flex items-center justify-between">
        <h3 className="text-[10px] uppercase tracking-widest text-[#8fa3ad]">
          {members.length} member{members.length === 1 ? "" : "s"}
        </h3>
        <button
          type="button"
          onClick={onClose}
          className="text-[#5a6a72] hover:text-[#d3dbe0] text-sm leading-none"
          aria-label="Close member list"
        >
          ✕
        </button>
      </div>
      <div className="max-h-64 overflow-y-auto py-1">
        {members.map((email) => {
          const online = Boolean(presence[email]?.online);
          return (
            <div key={email} className="flex items-center gap-2.5 px-4 py-2">
              <Avatar email={email} size="sm" online={online} />
              <div className="min-w-0">
                <p className="text-xs text-[#d3dbe0] truncate">{email}</p>
                <p className="text-[10px] text-[#5a6a72]">{online ? "Online" : "Offline"}</p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function WorkspacePage() {
  const { data: session, status: sessionStatus } = useSession();
  const router = useRouter();
  const email = session?.user?.email || "";

  useEffect(() => {
    if (sessionStatus === "unauthenticated") router.push("/login");
  }, [sessionStatus, router]);

  const [channels, setChannels] = useState([]);
  const [channelsLoading, setChannelsLoading] = useState(true);
  const [activeChannelId, setActiveChannelId] = useState(null);
  const [activeTab, setActiveTab] = useState("chat");
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showMemberPanel, setShowMemberPanel] = useState(false);
  const [loadError, setLoadError] = useState(null);

  useHeartbeat(email);

  useEffect(() => {
    if (!email) return;
    let cancelled = false;

    async function load() {
      setChannelsLoading(true);
      try {
        const result = await listChannels(email);
        if (cancelled) return;
        setChannels(result);
        setActiveChannelId((current) => current || result[0]?.id || null);
        setLoadError(null);
      } catch (err) {
        console.error("Failed to load channels:", err);
        if (!cancelled) setLoadError("Couldn't load your channels — try refreshing.");
      } finally {
        if (!cancelled) setChannelsLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [email]);

  const activeChannel = channels.find((c) => c.id === activeChannelId) || null;

  // Memoized so usePresence's polling effect doesn't restart every render
  // — only when the actual member list changes.
  const activeMembers = useMemo(
    () => activeChannel?.members || [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeChannel?.id, (activeChannel?.members || []).join(",")]
  );
  const presence = usePresence(activeMembers);

  function handleChannelCreated(channel) {
    setChannels((prev) => [...prev, channel]);
    setActiveChannelId(channel.id);
    setShowCreateModal(false);
  }

  function selectChannel(id) {
    setActiveChannelId(id);
    setActiveTab("chat");
    setShowMemberPanel(false);
  }

  if (sessionStatus !== "authenticated") {
    return (
      <div className="min-h-screen bg-[#0f1214] flex items-center justify-center">
        <p className="text-sm text-[#5a6a72]">Loading…</p>
      </div>
    );
  }

  return (
    <div className="h-screen bg-[#0f1214] flex overflow-hidden">
      <AppRail email={email} />

      <ChannelSidebar
        channels={channels}
        activeChannelId={activeChannelId}
        onSelectChannel={selectChannel}
        onNewChannel={() => setShowCreateModal(true)}
        presence={presence}
        loading={channelsLoading}
      />

      <div className="flex-1 flex flex-col min-w-0 relative">
        {activeChannel ? (
          <>
            <div className="border-b border-[#3a444a] px-4 sm:px-6 pt-3 flex items-center justify-between gap-4">
              <div className="min-w-0 pb-3">
                <h2 className="text-sm font-bold text-[#d3dbe0] truncate"># {activeChannel.name}</h2>
                <p className="text-[11px] text-[#5a6a72]">
                  {activeMembers.length} member{activeMembers.length === 1 ? "" : "s"} ·{" "}
                  {activeMembers.filter((m) => presence[m]?.online).length} online
                </p>
              </div>
              <div className="flex items-center gap-3 shrink-0 pb-3">
                <MemberStack
                  members={activeMembers}
                  presence={presence}
                  onClick={() => setShowMemberPanel((v) => !v)}
                />
              </div>
            </div>

            <div className="flex items-center gap-5 px-4 sm:px-6 border-b border-[#3a444a]">
              {TABS.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setActiveTab(tab.id)}
                  className={`relative py-2.5 text-[11px] uppercase tracking-widest transition ${
                    activeTab === tab.id ? "text-[#d3dbe0]" : "text-[#5a6a72] hover:text-[#b7c4cc]"
                  }`}
                >
                  {tab.label}
                  {activeTab === tab.id && (
                    <span className="absolute left-0 right-0 -bottom-px h-0.5 bg-[#8fa3ad] rounded-full" />
                  )}
                </button>
              ))}
            </div>

            {showMemberPanel && (
              <MemberPanel
                members={activeMembers}
                presence={presence}
                onClose={() => setShowMemberPanel(false)}
              />
            )}

            <div className="flex-1 min-h-0">
              {activeTab === "chat" && (
                <ChatPanel channelId={activeChannel.id} currentEmail={email} />
              )}

              {activeTab === "mission" && <MissionControl embedded />}

              {activeTab === "files" && (
                <div className="h-full flex items-center justify-center px-6 text-center">
                  <p className="text-sm text-[#5a6a72] max-w-md">
                    Channel-scoped Clip &amp; Snapshot libraries land here once clip/snapshot
                    sharing migrates from the global "shared" flag to per-channel sharing.
                  </p>
                </div>
              )}

              {activeTab === "reports" && (
                <div className="h-full flex items-center justify-center px-6 text-center">
                  <p className="text-sm text-[#5a6a72] max-w-md">
                    Mission reports generated for this channel's sessions will surface here.
                  </p>
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center px-6 text-center">
            {loadError ? (
              <p className="text-sm text-[#c47a6e]">{loadError}</p>
            ) : channelsLoading ? (
              <p className="text-sm text-[#5a6a72]">Loading your workspace…</p>
            ) : (
              <div className="flex flex-col items-center gap-4">
                <p className="text-sm text-[#b7c4cc]">You're not in any channels yet.</p>
                <button
                  type="button"
                  onClick={() => setShowCreateModal(true)}
                  className="bg-[#8fa3ad]/10 border border-[#8fa3ad]/60 rounded-lg px-4 py-2 text-xs uppercase tracking-widest text-[#d3dbe0] hover:bg-[#8fa3ad]/20 transition"
                >
                  Create your first channel
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {showCreateModal && (
        <CreateChannelModal
          createdBy={email}
          createChannelFn={createChannel}
          onClose={() => setShowCreateModal(false)}
          onCreated={handleChannelCreated}
        />
      )}
    </div>
  );
}