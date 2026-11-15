export type PlayerSnapshot = {
  current: {
    title: string;
    author: string;
    uri: string | null;
    duration: number;
    artworkUrl: string | null;
    requesterId: string;
  } | null;
  paused: boolean;
  volume: number;
  position: number;
  queueLength: number;
  connected: boolean;
  nodeName: string;
};

const PLAYER_COLOR = 0x2f6bff;
const IDLE_COLOR = 0x6b7280;

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0:00";
  const total = Math.floor(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

/**
 * Embed + five buttons for the player message. The labels stay plain text so
 * the controls render identically on mobile and in older clients.
 */
export function playerPayload(snapshot: PlayerSnapshot, note?: string): {
  embeds: unknown[];
  components: unknown[];
} {
  const { current } = snapshot;
  const lines: string[] = [];

  if (current) {
    lines.push(`**${truncate(current.title, 200)}**`);
    lines.push(
      `by ${truncate(current.author || "unknown artist", 100)} · requested by <@${current.requesterId}>`,
    );
  } else {
    lines.push("Use `/play` to add a track.");
  }
  if (note) lines.push(`\n${truncate(note, 400)}`);

  const embed: Record<string, unknown> = {
    author: {
      name: snapshot.paused ? "Paused" : snapshot.connected ? "Now playing" : "Player idle",
    },
    title: current ? truncate(current.title, 256) : "Nothing playing",
    description: lines.join("\n"),
    color: current ? PLAYER_COLOR : IDLE_COLOR,
    fields: [
      {
        name: "Progress",
        value: current
          ? `${formatDuration(snapshot.position)} / ${
              current.duration > 0 ? formatDuration(current.duration) : "live"
            }`
          : "—",
        inline: true,
      },
      { name: "Volume", value: `${snapshot.volume}%`, inline: true },
      { name: "Queue", value: String(snapshot.queueLength), inline: true },
    ],
    footer: { text: `Lavalink · ${snapshot.nodeName}` },
  };

  if (current?.uri && /^https?:\/\//i.test(current.uri)) embed.url = current.uri;
  if (current?.artworkUrl && /^https?:\/\//i.test(current.artworkUrl)) {
    embed.thumbnail = { url: current.artworkUrl };
  }

  const canPlay = Boolean(current) || snapshot.queueLength > 0;

  return {
    embeds: [embed],
    components: [
      {
        type: 1,
        components: [
          {
            type: 2,
            style: 3,
            label: "Play",
            custom_id: "music:play",
            disabled: !canPlay,
          },
          {
            type: 2,
            style: 2,
            label: "Pause",
            custom_id: "music:pause",
            disabled: !current || snapshot.paused,
          },
          {
            type: 2,
            style: 4,
            label: "Stop",
            custom_id: "music:stop",
            disabled: !snapshot.connected,
          },
          {
            type: 2,
            style: 2,
            label: "Volume −",
            custom_id: "music:voldown",
            disabled: !current,
          },
          {
            type: 2,
            style: 2,
            label: "Volume +",
            custom_id: "music:volup",
            disabled: !current,
          },
        ],
      },
    ],
  };
}
