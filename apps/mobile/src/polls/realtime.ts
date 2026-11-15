import type { QueryClient } from "@tanstack/react-query";
import {
  isPollEvent,
  parsePollEvent,
  pollKeys,
  type DurableEvent,
} from "@comamessenger/core";
import { invalidatePollLists } from "./lists";

/**
 * Keeps the poll lists in the query cache current after a realtime event.
 * The store already applied poll.* to the card (and reads the counts again
 * for cards on screen); here follow «Ждут вас» and an open «Кто
 * голосовал». A reminder or the author's «закрыт по сроку» reaches the
 * person as a push; in the app the poll shows in «Ждут вас».
 */
export function applyPollEvent(
  queryClient: QueryClient,
  userID: string,
  event: DurableEvent,
): void {
  const data = event.data as { type?: unknown; poll?: unknown } | null;
  const pollMessage = data?.type === "poll" || Boolean(data?.poll);
  if (
    (event.type === "message.created" || event.type === "message.deleted") &&
    pollMessage
  ) {
    invalidatePollLists(queryClient, userID);
    return;
  }
  if (!isPollEvent(event.type)) return;
  // A vote here or elsewhere, a closing, a reminder about a poll not yet in
  // the list: «Ждут вас» is short, reading it again is simpler.
  invalidatePollLists(queryClient, userID);
  const parsed = parsePollEvent(event);
  if (parsed?.type === "poll.updated")
    void queryClient.invalidateQueries({
      queryKey: [...pollKeys.all(userID), "voters", parsed.data.message_id],
    });
}
