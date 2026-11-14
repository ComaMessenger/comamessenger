import type { ClientMessage, FileMetadata } from "@comamessenger/core";

export type MediaKind = "photo" | "video";

/** One photo or video of a chat, as the full-screen viewer pages through them. */
export type MediaItem = {
  /** The file id: stable while the list grows with older messages. */
  key: string;
  kind: MediaKind;
  file: FileMetadata;
  messageID: string;
  actorID: string;
  createdAt: string;
};

export function mediaKind(file: Pick<FileMetadata, "mime">): MediaKind | null {
  if (file.mime.startsWith("image/")) return "photo";
  if (file.mime.startsWith("video/")) return "video";
  return null;
}

/** A photo or video that can be shown: uploaded and not a voice message. */
export function isVisualMedia(file: FileMetadata): boolean {
  return file.status === "ready" && !file.voice && mediaKind(file) !== null;
}

/**
 * Every photo and video of the loaded messages, in feed order (oldest
 * first, then the order inside a message). Deleted messages and messages
 * the server has not confirmed yet are left out.
 */
export function chatMedia(messages: readonly ClientMessage[]): MediaItem[] {
  const items: MediaItem[] = [];
  const seen = new Set<string>();
  const ordered = [...messages].sort((a, b) => a.created_seq - b.created_seq);
  for (const message of ordered) {
    if (message.deleted_at) continue;
    if (message.delivery && message.delivery !== "sent") continue;
    for (const file of message.files ?? []) {
      if (!isVisualMedia(file) || seen.has(file.id)) continue;
      seen.add(file.id);
      items.push({
        key: file.id,
        kind: mediaKind(file)!,
        file,
        messageID: message.id,
        actorID: message.actor_id,
        createdAt: message.created_at,
      });
    }
  }
  return items;
}

/** Where the item with `key` is now; the list may have grown at the start. */
export function indexOfMedia(items: readonly MediaItem[], key: string | null) {
  if (!key) return -1;
  return items.findIndex((item) => item.key === key);
}

/** «0:07», «12:30», «1:02:03». */
export function formatMediaDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
    : `${minutes}:${seconds}`;
}

/**
 * Pan limits of a zoomed item: how far it may move each way so its edges
 * never come inside the screen. `content` is the item fitted (contain)
 * into `screen` at scale 1.
 */
export function panBounds(
  content: { width: number; height: number },
  screen: { width: number; height: number },
  scale: number,
) {
  "worklet";
  return {
    x: Math.max(0, (content.width * scale - screen.width) / 2),
    y: Math.max(0, (content.height * scale - screen.height) / 2),
  };
}

/** An item of `aspect` fitted inside `box` without cropping. */
export function containSize(
  aspect: number,
  box: { width: number; height: number },
) {
  if (!aspect || !Number.isFinite(aspect))
    return { width: box.width, height: box.height };
  return box.width / box.height > aspect
    ? { width: box.height * aspect, height: box.height }
    : { width: box.width, height: box.width / aspect };
}

/** «12 ноября, 14:05» in the viewer's title; the year only if not this one. */
export function formatMediaDate(
  iso: string,
  language: string,
  now = new Date(),
) {
  const date = new Date(iso);
  return new Intl.DateTimeFormat(language, {
    day: "numeric",
    month: "long",
    ...(date.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

/**
 * «3 of 12» in the viewer. `loaded` items are the newest of the chat when
 * `total` is known (the archive), so the first loaded one is not number 1.
 */
export function mediaPosition(index: number, loaded: number, total?: number) {
  if (total === undefined || total < loaded)
    return { current: index + 1, total: loaded };
  return { current: total - loaded + index + 1, total };
}
