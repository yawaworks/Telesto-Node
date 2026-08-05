"use client";

import { useEffect, useMemo, useState } from "react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";

import AppRail from "../../components/AppRail";
import Avatar from "../../components/Avatar";
import CallsTab from "../../components/CallsTab";
import ChannelSidebar from "../../components/ChannelSidebar";
import ChatPanel from "../../components/ChatPanel";
import CreateChannelModal from "../../components/CreateChannelModal";
import MemberAdminPanel from "../../components/MemberAdminPanel";
import MissionControl from "../../components/MissionControl";
import PinnedMessagesPanel from "../../components/PinnedMessagesPanel";
import {
  createChannel,
  demoteChannelAdmin,
  listChannels,
  promoteChannelAdmin,
  removeChannelMember,
  unpinMessage,
} from "../../lib/workspaceApi";
import { useHeartbeat, usePresence } from "../../lib/usePresence";

const TABS = [
  { id: "chat", label: "Chat" },
  { id: "calls", label: "Calls" },
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
        <Avatar key={email} email={email} size="sm" status={presence[email]?.status || "offline"} ring />
      ))}
      {overflow > 0 && (
        <span className="w-6 h-6 rounded-full bg-[#3a444a] ring-2 ring-[#171d20] flex items-center justify-center text-[10px] font-bold text-[#d3dbe0]">
          +{overflow}
        </span>
      )}
    </button>
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
  const [showPinnedPanel, setShowPinnedPanel] = useState(false);
  const [loadError, setLoadError] = useState(null);

  const { myStatus, setStatus } = useHeartbeat(email);

  useEffect(() => {
    if (!email) return;
    let cancelled = false;

    async function load() {
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

    setChannelsLoading(true);
    load();
    // Re-poll periodically — this is also what keeps unread counts fresh
    // (new messages elsewhere, and the active channel dropping to 0 a few
    // seconds after it's marked read) without a second bespoke endpoint.
    const intervalId = setInterval(load, 15000);

    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [email]);

  const activeChannel = channels.find((c) => c.id === activeChannelId) || null;
  const isAdmin = Boolean(
    activeChannel && (activeChannel.created_by === email || activeChannel.admins.includes(email))
  );

  // Memoized so usePresence's polling effect doesn't restart every render
  // — only when the actual member list changes.
  const activeMembers = useMemo(
    () => activeChannel?.members || [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeChannel?.id, (activeChannel?.members || []).join(",")]
  );
  const presence = usePresence(activeMembers);

  function updateChannelInPlace(updated) {
    // Admin-action endpoints (promote/demote/remove) don't compute
    // unread_count — they return the ChannelResponse default of 0. Keep
    // whatever the periodic channel-list poll last reported instead of
    // letting that default clobber a real badge count.
    setChannels((prev) =>
      prev.map((c) => (c.id === updated.id ? { ...c, ...updated, unread_count: c.unread_count } : c))
    );
  }

  function handleChannelCreated(channel) {
    setChannels((prev) => [...prev, channel]);
    setActiveChannelId(channel.id);
    setShowCreateModal(false);
  }

  function selectChannel(id) {
    setActiveChannelId(id);
    setActiveTab("chat");
    setShowMemberPanel(false);
    setShowPinnedPanel(false);
  }

  async function handlePromote(memberEmail) {
    const updated = await promoteChannelAdmin(activeChannel.id, { email: memberEmail, requestedBy: email });
    updateChannelInPlace(updated);
  }

  async function handleDemote(memberEmail) {
    const updated = await demoteChannelAdmin(activeChannel.id, { email: memberEmail, requestedBy: email });
    updateChannelInPlace(updated);
  }

  async function handleRemove(memberEmail) {
    const updated = await removeChannelMember(activeChannel.id, { email: memberEmail, requestedBy: email });
    updateChannelInPlace(updated);
  }

  async function handleUnpinFromPanel(message) {
    await unpinMessage(message.id, email);
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
      <AppRail email={email} myStatus={myStatus} onChangeStatus={setStatus} />

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
            <div className="border-b border-[#3a444a] px-4 sm:px-6 pt-3 flex items-center justify-between gap-4 relative">
              <div className="min-w-0 pb-3">
                <h2 className="text-sm font-bold text-[#d3dbe0] truncate"># {activeChannel.name}</h2>
                <p className="text-[11px] text-[#5a6a72]">
                  {activeMembers.length} member{activeMembers.length === 1 ? "" : "s"} ·{" "}
                  {activeMembers.filter((m) => presence[m]?.status === "active").length} active
                </p>
              </div>
              <div className="flex items-center gap-3 shrink-0 pb-3">
                <button
                  type="button"
                  onClick={() => setShowPinnedPanel((v) => !v)}
                  title="Pinned messages"
                  className="text-[#5a6a72] hover:text-[#8fa3ad] text-sm"
                >
                  📌
                </button>
                <MemberStack
                  members={activeMembers}
                  presence={presence}
                  onClick={() => setShowMemberPanel((v) => !v)}
                />
              </div>

              {showPinnedPanel && (
                <PinnedMessagesPanel
                  channelId={activeChannel.id}
                  requesterEmail={email}
                  onClose={() => setShowPinnedPanel(false)}
                  onUnpin={handleUnpinFromPanel}
                />
              )}
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
              <MemberAdminPanel
                channel={activeChannel}
                presence={presence}
                currentEmail={email}
                isAdmin={isAdmin}
                onClose={() => setShowMemberPanel(false)}
                onPromote={handlePromote}
                onDemote={handleDemote}
                onRemove={handleRemove}
              />
            )}

            <div className="flex-1 min-h-0">
              {activeTab === "chat" && (
                <ChatPanel
                  channelId={activeChannel.id}
                  currentEmail={email}
                  channels={channels}
                  isAdmin={isAdmin}
                />
              )}

              {activeTab === "calls" && (
                <CallsTab channelId={activeChannel.id} currentEmail={email} isAdmin={isAdmin} />
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