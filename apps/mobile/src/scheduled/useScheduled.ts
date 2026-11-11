import { useCallback, useMemo, useRef, useState } from "react";
import { Alert } from "react-native";
import * as Clipboard from "expo-clipboard";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  messagePlainText,
  mentionedActorIDs,
  scheduledMobile,
  type CreateScheduledMessageRequest,
  type ScheduledMessage,
} from "@comamessenger/core";
import { withCache } from "@/messenger/cache";
import { useSignedIn } from "@/session/SessionProvider";
import { refreshRecord, scheduledKey, setItems } from "./scheduledCache";

export { applyScheduledEvent, scheduledKey } from "./scheduledCache";

const noItems: ScheduledMessage[] = [];

/** The user's scheduled messages; the offline cache keeps them readable without network. */
export function useScheduledList() {
  const { api, user } = useSignedIn();
  return useQuery<ScheduledMessage[]>({
    queryKey: scheduledKey(user.id),
    queryFn: () =>
      withCache(`scheduled:${user.id}`, () => api.scheduledMessages()),
    staleTime: 30_000,
    select: (items) => (Array.isArray(items) ? items : noItems),
  });
}

/** Scheduled messages of one chat, soonest first. */
export function useChatScheduled(chatID: string | null) {
  const query = useScheduledList();
  const items = query.data ?? noItems;
  const visible = useMemo(
    () =>
      chatID === null ? items : items.filter((item) => item.chat_id === chatID),
    [chatID, items],
  );
  return { query, items: visible };
}

/** Human text of an error of a scheduled-message request. */
export function scheduledErrorKey(
  kind: scheduledMobile.ErrorKind,
  options: { composing?: boolean } = {},
): string {
  switch (kind) {
    case "conflict":
      return "scheduledErrorConflict";
    case "closed":
      return "scheduledErrorClosed";
    case "gone":
      return "scheduledErrorGone";
    case "limit":
      return "scheduledErrorLimit";
    case "tooLarge":
      return "scheduledErrorTooLarge";
    case "invalid":
      return "scheduledErrorInvalid";
    case "forbidden":
      return "scheduledErrorForbidden";
    case "rateLimited":
      return "scheduledErrorRateLimited";
    case "network":
      return options.composing
        ? "scheduledErrorNetwork"
        : "scheduledErrorNetworkList";
    default:
      return "scheduledErrorOther";
  }
}

export function failureText(
  t: (key: string) => string,
  reason: unknown,
): string {
  return t(`scheduledFailure_${scheduledMobile.failureReason(reason)}`);
}

export type ScheduledActions = ReturnType<typeof useScheduledActions>;

/**
 * Changes to scheduled messages. One request per record at a time (a second
 * press is ignored); a conflict, a closed or a deleted record reloads it so
 * the screen shows what is true now, and says why the action did not apply.
 */
export function useScheduledActions(notify: (text: string) => void) {
  const { t } = useTranslation();
  const { api, user } = useSignedIn();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const inFlight = useRef(new Set<string>());

  const run = useCallback(
    async <T>(id: string, request: () => Promise<T>): Promise<T | null> => {
      if (inFlight.current.has(id)) return null;
      inFlight.current.add(id);
      setBusy(new Set(inFlight.current));
      try {
        return await request();
      } finally {
        inFlight.current.delete(id);
        setBusy(new Set(inFlight.current));
      }
    },
    [],
  );

  const fail = useCallback(
    async (item: ScheduledMessage, cause: unknown, retrying = false) => {
      const kind = scheduledMobile.errorKind(cause);
      if (kind === "gone")
        setItems(queryClient, user.id, (items) =>
          scheduledMobile.remove(items, item.id),
        );
      else if (kind === "conflict" || kind === "closed")
        await refreshRecord(queryClient, api, user.id, item.id);
      // Retrying an unsent message needs the server of package H; until it
      // is there the record is closed and the text can still be taken.
      if (kind === "closed" && retrying) {
        Alert.alert(t("scheduledFailedLabel"), t("scheduledErrorRetryClosed"), [
          { text: t("cancel"), style: "cancel" },
          {
            text: t("scheduledCopyText"),
            onPress: () =>
              void Clipboard.setStringAsync(messagePlainText(item.body)),
          },
        ]);
        return;
      }
      Alert.alert(t(scheduledErrorKey(kind)));
    },
    [api, queryClient, t, user.id],
  );

  const create = useCallback(
    async (chatID: string, request: CreateScheduledMessageRequest) => {
      const record = await api.createScheduledMessage(chatID, request);
      setItems(queryClient, user.id, (items) =>
        scheduledMobile.merge(items, record),
      );
      return record;
    },
    [api, queryClient, user.id],
  );

  const update = useCallback(
    (
      item: ScheduledMessage,
      change: { send_at?: string; body?: string },
      done: string,
    ) =>
      run(item.id, async () => {
        try {
          const record = await api.updateScheduledMessage(item.id, {
            expected_version: item.version,
            ...(change.send_at ? { send_at: change.send_at } : {}),
            ...(change.body !== undefined
              ? {
                  body: change.body,
                  body_format: "markdown" as const,
                  mentioned_actor_ids: mentionedActorIDs(change.body),
                }
              : {}),
          });
          setItems(queryClient, user.id, (items) =>
            scheduledMobile.merge(items, record),
          );
          notify(done);
          return record;
        } catch (cause) {
          await fail(item, cause, item.status === "failed");
          return null;
        }
      }),
    [api, fail, notify, queryClient, run, user.id],
  );

  const remove = useCallback(
    (item: ScheduledMessage) =>
      run(item.id, async () => {
        try {
          await api.deleteScheduledMessage(item.id);
        } catch (cause) {
          // Deleted on another device: the wish is fulfilled all the same.
          if (scheduledMobile.errorKind(cause) !== "gone") {
            await fail(item, cause);
            return;
          }
        }
        setItems(queryClient, user.id, (items) =>
          scheduledMobile.remove(items, item.id),
        );
        notify(t("scheduledDeleted"));
      }),
    [api, fail, notify, queryClient, run, t, user.id],
  );

  const sendNow = useCallback(
    (item: ScheduledMessage) =>
      run(item.id, async () => {
        try {
          const record = await api.sendScheduledMessageNow(item.id);
          setItems(queryClient, user.id, (items) =>
            scheduledMobile.merge(items, record),
          );
          if (record.status === "failed")
            Alert.alert(
              t("scheduledFailedLabel"),
              failureText(t, record.failure_reason),
            );
          else notify(t("scheduledSentNow"));
        } catch (cause) {
          await fail(item, cause, item.status === "failed");
        }
      }),
    [api, fail, notify, queryClient, run, t, user.id],
  );

  /** The record as the list holds it now, e.g. after a conflict reloaded it. */
  const latest = useCallback(
    (id: string) =>
      queryClient
        .getQueryData<ScheduledMessage[]>(scheduledKey(user.id))
        ?.find((item) => item.id === id) ?? null,
    [queryClient, user.id],
  );

  return { busy, create, update, remove, sendNow, latest };
}
