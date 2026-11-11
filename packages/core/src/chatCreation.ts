import type { Chat, CreateChatRequest, DurableEvent } from "./types";

/**
 * Creating chats from a client: a group or a channel with people, or a
 * direct chat with one person or agent. Limits follow the server
 * (core/internal/chat/chat.go): it measures the name and the description in
 * bytes of UTF-8, so a Cyrillic name fits in half as many letters.
 */
export const chatNameMaxBytes = 120;
export const chatTopicMaxBytes = 500;

export type NewChatKind = "group" | "channel";

export type NewChatDraft = {
  kind: NewChatKind;
  name: string;
  topic: string;
  /** Anyone in the workspace can find and join it. */
  open: boolean;
  memberIDs: readonly string[];
};

export type NewChatProblem = "nameRequired" | "nameTooLong" | "topicTooLong";

export function utf8Length(value: string) {
  let bytes = 0;
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

export function newChatProblem(
  draft: Pick<NewChatDraft, "name" | "topic">,
): NewChatProblem | null {
  const name = draft.name.trim();
  if (!name) return "nameRequired";
  if (utf8Length(name) > chatNameMaxBytes) return "nameTooLong";
  if (utf8Length(draft.topic.trim()) > chatTopicMaxBytes) return "topicTooLong";
  return null;
}

/** The body of `POST /api/v1/chats` for a group or a channel. */
export function createChatRequest(
  draft: NewChatDraft,
  ownID: string,
): CreateChatRequest {
  return {
    kind: draft.kind,
    visibility: draft.open ? "public" : "private",
    name: draft.name.trim(),
    topic: draft.topic.trim(),
    member_ids: [...new Set(draft.memberIDs)].filter((id) => id !== ownID),
  };
}

/** The body of `POST /api/v1/chats` for a direct chat; the server returns the existing one. */
export function directChatRequest(actorID: string): CreateChatRequest {
  return {
    kind: "direct",
    visibility: "private",
    name: "",
    topic: "",
    member_ids: [actorID],
  };
}

/** The direct chat the reader already has with this actor, if any. */
export function findDirectChat(
  chats: Iterable<Chat>,
  actorID: string,
): Chat | undefined {
  for (const chat of chats)
    if (chat.kind === "direct" && chat.direct_peer?.actor_id === actorID)
      return chat;
  return undefined;
}

/**
 * Which cached details of a chat a realtime event changes: its members, its
 * pinned messages, or the chat itself (name, description, archive).
 */
export type ChatEventEffect = {
  chatID: string;
  members: boolean;
  pins: boolean;
  chat: boolean;
};

export function chatEventEffect(event: DurableEvent): ChatEventEffect | null {
  const chatID =
    event.chat_id ||
    (typeof event.data.chat_id === "string" ? event.data.chat_id : null);
  if (!chatID) return null;
  const members = event.type.startsWith("member.");
  const pins =
    event.type === "message.pinned" ||
    event.type === "message.unpinned" ||
    event.type === "message.deleted";
  const chat = event.type.startsWith("chat.");
  if (!members && !pins && !chat) return null;
  return { chatID, members, pins, chat };
}
