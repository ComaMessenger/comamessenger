import type { QueryClient } from "@tanstack/react-query";
import {
  applyReminderEvent,
  isRequestEvent,
  isReminderEvent,
  parseReminderEvent,
  reminderKeys,
  requestKeys,
  type DurableEvent,
} from "@comamessenger/core";

/**
 * Keeps the reader's request and reminder caches current after a realtime
 * event. The store already applied request.* to the message and the viewer
 * map; here the lists that live in TanStack Query follow: Waiting for you, the
 * author's answers panel, the bells of the chat and Reminders. Returns
 * true when the event was one of these (reminder events never reach the
 * store, they are private to the owner's devices).
 */
export function applyWorkplaceEvent(
  queryClient: QueryClient,
  userID: string,
  event: DurableEvent,
): boolean {
  if (isReminderEvent(event.type)) {
    const parsed = parseReminderEvent(event);
    if (parsed) applyReminderEvent(queryClient, userID, parsed);
    else
      void queryClient.invalidateQueries({
        queryKey: reminderKeys.all(userID),
      });
    return true;
  }
  if (!isRequestEvent(event.type)) return false;
  const messageID =
    typeof event.data.message_id === "string" ? event.data.message_id : null;
  // Waiting for you: a new request for me, my answer from another device, a
  // closed request. The lists are short; reading them again is simpler and
  // safer than patching two paginated lists.
  if (
    event.type === "request.assigned" ||
    event.type === "request.answer.updated" ||
    event.type === "request.updated"
  )
    void queryClient.invalidateQueries({
      queryKey: [...requestKeys.all(userID), "inbox"],
    });
  // Who answered what is not in the events: the open panel reads it again.
  if (
    messageID &&
    (event.type === "request.updated" ||
      event.type === "request.tally.updated" ||
      event.type === "request.auto_reminded")
  )
    void queryClient.invalidateQueries({
      queryKey: [...requestKeys.all(userID), "answers", messageID],
    });
  return true;
}

/** After a resync nothing missed is replayed: read every list again. */
export function invalidateWorkplace(queryClient: QueryClient, userID: string) {
  void queryClient.invalidateQueries({ queryKey: requestKeys.all(userID) });
  void queryClient.invalidateQueries({ queryKey: reminderKeys.all(userID) });
}
