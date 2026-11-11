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
 * it. The server returns all of them at once (up to 1000).
 */
export const scheduledQueryKey = ["scheduled"] as const;

export function useScheduledMessages(api: MessengerAPI, enabled = true) {
  return useQuery({
    queryKey: scheduledQueryKey,
    queryFn: () => api.scheduledMessages(),
    staleTime: 60_000,
    enabled,
  });
}

function update(
  queryClient: QueryClient,
  change: (items: ScheduledMessage[]) => ScheduledMessage[],
) {
  queryClient.setQueryData<ScheduledMessage[]>(scheduledQueryKey, (items) =>
    items ? change(items) : items,
  );
}

/** Puts a record the server just returned into the list. */
export function storeScheduled(
  queryClient: QueryClient,
  record: ScheduledMessage,
) {
  update(queryClient, (items) => upsertScheduled(items, record));
}

export function forgetScheduled(queryClient: QueryClient, id: string) {
  update(queryClient, (items) => removeScheduled(items, id));
}

/**
 * Applies a scheduled_message.* event. Events carry no text, so a changed
 * record is read again; one that is gone by then leaves the list.
 */
export function applyScheduledEvent(
  queryClient: QueryClient,
  api: MessengerAPI,
  type: string,
  data: ScheduledMessageEvent,
) {
  const items = queryClient.getQueryData<ScheduledMessage[]>(scheduledQueryKey);
  if (!items) return;
  const result = reduceScheduled(items, type, data);
  if (result.changed) queryClient.setQueryData(scheduledQueryKey, result.items);
  if (!result.refetch) return;
  const id = result.refetch;
  void api
    .scheduledMessage(id)
    .then((record) => storeScheduled(queryClient, record))
    .catch((cause) => {
      if (cause instanceof APIError && cause.status === 404)
        forgetScheduled(queryClient, id);
    });
}
