"use client";

function ChannelPresenceDot({ channel, presence }) {
  const anyOnline = (channel.members || []).some(
    (email) => presence[email]?.online
  );
  return (
    <span
      className={`w-1.5 h-1.5 rounded-full shrink-0 ${
        anyOnline ? "bg-[#7fb37f]" : "bg-[#3a444a]"
      }`}
      title={anyOnline ? "A teammate is online" : "No one online right now"}
    />
  );
}

export default function ChannelSidebar({
  channels,
  activeChannelId,
  onSelectChannel,
  onNewChannel,
  presence,
  loading,
}) {
  return (
    <aside className="w-56 shrink-0 border-r border-[#3a444a] bg-[#171c1f] flex flex-col h-full">
      <div className="px-4 py-4 flex items-center justify-between">
        <h1 className="text-xs uppercase tracking-widest text-[#8fa3ad]">Channels</h1>
        <button
          type="button"
          onClick={onNewChannel}
          className="text-[#8fa3ad] hover:text-[#d3dbe0] text-lg leading-none px-1"
          aria-label="New channel"
          title="New channel"
        >
          +
        </button>
      </div>

      <nav className="flex-1 overflow-y-auto px-2 flex flex-col gap-0.5">
        {loading && (
          <p className="px-2 py-2 text-xs text-[#5a6a72]">Loading channels…</p>
        )}
        {!loading && channels.length === 0 && (
          <p className="px-2 py-2 text-xs text-[#5a6a72]">
            No channels yet — create one to get started.
          </p>
        )}
        {channels.map((channel) => {
          const active = channel.id === activeChannelId;
          return (
            <button
              key={channel.id}
              type="button"
              onClick={() => onSelectChannel(channel.id)}
              className={`flex items-center gap-2 text-left px-2.5 py-2 rounded-lg text-sm transition ${
                active
                  ? "bg-[#8fa3ad]/15 text-[#d3dbe0]"
                  : "text-[#b7c4cc] hover:bg-white/[0.05]"
              }`}
            >
              <ChannelPresenceDot channel={channel} presence={presence} />
              <span className="truncate">{channel.name}</span>
            </button>
          );
        })}
      </nav>
    </aside>
  );
}