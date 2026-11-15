import type { QueryClient } from "@tanstack/react-query";
import {
  isPollEvent,
  parsePollEvent,
  pollKeys,
  taskKeys,
  type DurableEvent,
  type PollNotifiedEvent,
} from "@comamessenger/core";

/**
 * Keeps the poll lists in the query cache current after a realtime event.
 * The store already applied poll.* to the card (and reads the counts again
 * for cards on screen); here follow Waiting for you and the open Who
 * voted lists. Returns the reminder or the author's «closed by due
 * date» when the event is one, for the in-app notification.
 */
export function applyPollEvent(
  queryClient: QueryClient,
  userID: string,
  event: DurableEvent,
): PollNotifiedEvent | null {
  const isPollMessage =
    event.data.type === "poll" || Boolean(event.data.poll);
  if (
    (event.type === "message.created" && isPollMessage) ||
    (event.type === "message.deleted" && isPollMessage)
  )
    void queryClient.invalidateQueries({
      queryKey: [...taskKeys.all(userID), "waiting"],
    });
  if (!isPollEvent(event.type)) return null;
  const parsed = parsePollEvent(event);
  // A vote here or elsewhere, a closing, a reminder about a poll not yet
  // in the list: Waiting for you is short, reading it again is simpler.
  void queryClient.invalidateQueries({
    queryKey: [...taskKeys.all(userID), "waiting"],
  });
  if (!parsed) {
    void queryClient.invalidateQueries({ queryKey: pollKeys.all(userID) });
    return null;
  }
  if (parsed.type === "poll.updated")
    void queryClient.invalidateQueries({
      queryKey: ["polls", userID, "voters", parsed.data.message_id],
    });
  return parsed.type === "poll.notified" ? parsed.data : null;
}
