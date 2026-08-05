"use client";

function ChannelRow({ channel, active, presence, onSelect }) {
  const anyOnline = (channel.members || []).some((email) => presence[email]?.online);

  return (
    <button
      type="button"
      onClick={() => onSelect(channel.id)}
      className={`relative flex items-center gap-2 text-left pl-3.5 pr-2.5 py-2 rounded-lg text-sm transition ${
        active ? "bg-[#8fa3ad]/12 text-[#d3dbe0]" : "text-[#b7c4cc] hover:bg-white/[0.05]"
      }`}
    >
      {active && (
        <span className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-full bg-[#8fa3ad]" />
      )}
      <span className="text-[#5a6a72] font-bold">#</span>
      <span className="truncate flex-1">{channel.name}</span>
      <span
        className={`w-1.5 h-1.5 rounded-full shrink-0 ${anyOnline ? "bg-[#7fb37f]" : "bg-[#3a444a]"}`}
        title={anyOnline ? "A teammate is online" : "No one online right now"}
      />
    </button>
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
    <aside className="w-60 shrink-0 border-r border-[#3a444a] bg-[#171c1f] flex flex-col h-full">
      <div className="px-4 pt-4 pb-3 border-b border-[#3a444a]">
        <p className="text-sm font-bold text-[#d3dbe0] leading-tight">Telesto Node</p>
        <p className="text-[10px] uppercase tracking-widest text-[#5a6a72]">Research team</p>
      </div>

      <div className="px-4 py-3 flex items-center justify-between">
        <h2 className="text-[10px] uppercase tracking-widest text-[#8fa3ad]">Channels</h2>
        <button
          type="button"
          onClick={onNewChannel}
          className="text-[#8fa3ad] hover:text-[#d3dbe0] text-base leading-none px-1"
          aria-label="New channel"
          title="New channel"
        >
          +
        </button>
      </div>

      <nav className="flex-1 overflow-y-auto px-2 flex flex-col gap-0.5">
        {loading && <p className="px-2 py-2 text-xs text-[#5a6a72]">Loading channels…</p>}
        {!loading && channels.length === 0 && (
          <p className="px-2 py-2 text-xs text-[#5a6a72]">
            No channels yet — create one to get started.
          </p>
        )}
        {channels.map((channel) => (
          <ChannelRow
            key={channel.id}
            channel={channel}
            active={channel.id === activeChannelId}
            presence={presence}
            onSelect={onSelectChannel}
          />
        ))}
      </nav>
    </aside>
  );
}