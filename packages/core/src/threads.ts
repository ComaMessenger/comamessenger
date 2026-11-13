import type { Message } from "./types";

export type ThreadPreview = {
  /** Distinct reply authors, most recent first (at most `limit`). */
  participantIDs: string[];
  /** ISO timestamp of the latest reply, if any reply is known. */
  lastReplyAt: string | null;
  /** The latest reply itself (for list previews). */
  lastReply: Message | null;
};

/**
 * Who replied in a thread and when, from whatever replies the client knows:
 * a loaded thread page and realtime messages kept in the store. The API
 * exposes only `thread_reply_count` on the root, so clients derive the rest.
 */
export function threadPreview(
  rootID: string,
  sources: ReadonlyArray<readonly Message[] | undefined>,
  limit = 3,
): ThreadPreview {
  const replies = new Map<string, Message>();
  for (const source of sources)
    for (const message of source ?? [])
      if (message.thread_root_id === rootID && !message.deleted_at)
        replies.set(message.id, message);
  const ordered = [...replies.values()].sort(
    (left, right) => right.created_seq - left.created_seq,
  );
  const participantIDs: string[] = [];
  for (const reply of ordered) {
    if (!participantIDs.includes(reply.actor_id))
      participantIDs.push(reply.actor_id);
    if (participantIDs.length === limit) break;
  }
  return {
    participantIDs,
    lastReplyAt: ordered[0]?.created_at ?? null,
    lastReply: ordered[0] ?? null,
  };
}
