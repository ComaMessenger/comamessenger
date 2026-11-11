import type { QueryClient } from "@tanstack/react-query";
import {
  scheduledMobile,
  type DurableEvent,
  type MessengerAPI,
  type ScheduledMessage,
} from "@comamessenger/core";

// The cached list of scheduled messages and its realtime updates. Free of
// native modules, so it is unit-tested with a real QueryClient.

/** Every scheduled message of the user, in one list: the server keeps at most 100. */
export const scheduledKey = (userID: string) => ["scheduled", userID] as const;

export function setItems(
  queryClient: QueryClient,
  userID: string,
  update: (items: ScheduledMessage[]) => ScheduledMessage[],
) {
  queryClient.setQueryData<ScheduledMessage[]>(scheduledKey(userID), (items) =>
    items ? update(items) : items,
  );
}

/** Reads one record again and puts it into the list, or drops it when it is gone. */
export async function refreshRecord(
  queryClient: QueryClient,
  api: MessengerAPI,
  userID: string,
  id: string,
) {
  try {
    const record = await api.scheduledMessage(id);
    setItems(queryClient, userID, (items) =>
      scheduledMobile.merge(items, record),
    );
  } catch (cause) {
    if (scheduledMobile.errorKind(cause) === "gone")
      setItems(queryClient, userID, (items) =>
        scheduledMobile.remove(items, id),
      );
  }
}

/**
 * Applies a scheduled_message.* realtime event to the cached list. The event
 * holds no text, so a new or edited record is read again. Returns whether
 * the event was one of these.
 */
export function applyScheduledEvent(
  queryClient: QueryClient,
  api: MessengerAPI,
  userID: string,
  event: DurableEvent,
): boolean {
  if (!event.type.startsWith("scheduled_message.")) return false;
  const parsed = scheduledMobile.parseEvent(event.data);
  if (!parsed) return true;
  const items = queryClient.getQueryData<ScheduledMessage[]>(
    scheduledKey(userID),
  );
  // Nothing loaded yet: the first screen that needs the list reads it fresh.
  if (!items) return true;
  const change = scheduledMobile.applyEvent(items, parsed);
  if (change.changed)
    queryClient.setQueryData(scheduledKey(userID), change.items);
  for (const id of change.fetch)
    void refreshRecord(queryClient, api, userID, id);
  return true;
}
