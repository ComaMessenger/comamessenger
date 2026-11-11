import { useQuery, type QueryClient } from "@tanstack/react-query";
import {
  APIError,
  reduceScheduled,
  removeScheduled,
  upsertScheduled,
  type MessengerAPI,
  type ScheduledMessage,
  type ScheduledMessageEvent,
} from "@comamessenger/core";

/**
 * The author's scheduled messages, one list for the whole app: the strip
 * under the chat header, the Scheduled page and the security warnings read
 * it. The server returns all of them at once (up to 1000). The list is
 * keyed by its owner and dropped when that person signs out, so the next
 * person in the same tab never sees it.
 */
const scheduledRootKey = ["scheduled"] as const;

export const scheduledQueryKey = (userID: string) =>
  [...scheduledRootKey, userID] as const;

export function useScheduledMessages(
  api: MessengerAPI,
  userID: string,
  enabled = true,
) {
  return useQuery({
    queryKey: scheduledQueryKey(userID),
    queryFn: () => api.scheduledMessages(),
    staleTime: 60_000,
    enabled,
  });
}

/**
 * Keeps only the lists of `ownerID` (none when null): called when a person
 * signs in and when they sign out.
 */
export function releaseScheduledCache(
  queryClient: QueryClient,
  ownerID: string | null,
) {
  queryClient.removeQueries({
    queryKey: scheduledRootKey,
    predicate: (query) => query.queryKey[1] !== ownerID,
  });
}

function update(
  queryClient: QueryClient,
  userID: string,
  change: (items: ScheduledMessage[]) => ScheduledMessage[],
) {
  queryClient.setQueryData<ScheduledMessage[]>(
    scheduledQueryKey(userID),
    (items) => (items ? change(items) : items),
  );
}

/** Puts a record the server just returned into the list. */
export function storeScheduled(
  queryClient: QueryClient,
  userID: string,
  record: ScheduledMessage,
) {
  update(queryClient, userID, (items) => upsertScheduled(items, record));
}

export function forgetScheduled(
  queryClient: QueryClient,
  userID: string,
  id: string,
) {
  update(queryClient, userID, (items) => removeScheduled(items, id));
}

/**
 * Applies a scheduled_message.* event. Events carry no text, so a changed
 * record is read again; one that is gone by then leaves the list.
 */
export function applyScheduledEvent(
  queryClient: QueryClient,
  api: MessengerAPI,
  userID: string,
  type: string,
  data: ScheduledMessageEvent,
) {
  const key = scheduledQueryKey(userID);
  const items = queryClient.getQueryData<ScheduledMessage[]>(key);
  if (!items) return;
  const result = reduceScheduled(items, type, data);
  if (result.changed) queryClient.setQueryData(key, result.items);
  if (!result.refetch) return;
  const id = result.refetch;
  void api
    .scheduledMessage(id)
    .then((record) => storeScheduled(queryClient, userID, record))
    .catch((cause) => {
      if (cause instanceof APIError && cause.status === 404)
        forgetScheduled(queryClient, userID, id);
    });
}
