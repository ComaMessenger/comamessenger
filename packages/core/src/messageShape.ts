import type { Message } from "./types";

/**
 * Fills the fields every `Message` has but a realtime frame may lack.
 *
 * `message.created` / `message.updated` frames carry the row of the message
 * (body, ids, sequence), not the hydrated API shape: no `files`, no
 * `thread_reply_count`, no `agent_provenance`. The realtime contract types
 * `data` as an open object, so the store must not take it for a `Message`.
 * A field the frame lacks keeps what the client already knew, or an empty
 * value. Messages cached by earlier versions (with `files` missing and a
 * `null` reply count left by `undefined + 1`) are repaired the same way.
 */
export function completeMessage<T extends Message>(
  value: T,
  known?: Message,
): T {
  const count = (candidate: unknown) =>
    typeof candidate === "number" && Number.isFinite(candidate)
      ? candidate
      : undefined;
  return {
    ...value,
    files: Array.isArray(value.files)
      ? value.files
      : Array.isArray(known?.files)
        ? known.files
        : [],
    mentioned_actor_ids: Array.isArray(value.mentioned_actor_ids)
      ? value.mentioned_actor_ids
      : Array.isArray(known?.mentioned_actor_ids)
        ? known.mentioned_actor_ids
        : [],
    thread_reply_count:
      count(value.thread_reply_count) ?? count(known?.thread_reply_count) ?? 0,
  };
}
