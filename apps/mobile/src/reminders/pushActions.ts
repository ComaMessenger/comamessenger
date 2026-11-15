import * as Notifications from "expo-notifications";
import type { QueryClient } from "@tanstack/react-query";
import { reminderKeys } from "@comamessenger/core";
import i18n from "@/i18n";
import { accountValues } from "@/lib/database";
import {
  drainReminderActions,
  queueReminderAction,
  reminderAction,
  reminderActionIDs,
  reminderCategory,
  type ReminderAction,
} from "./actionQueue";

const key = "reminder_actions";

type API = Parameters<typeof drainReminderActions>[0];

/**
 * The API of the running app. A push button pressed while the app is only
 * in memory uses it; a fresh client here would refresh the session on its
 * own and could sign the app out. With the app closed (Android starts the
 * JavaScript without it) the action waits for the next start.
 */
let liveAPI: API | null = null;
export function setLiveReminderAPI(api: API | null) {
  liveAPI = api;
}

/** The three buttons of a «Напомнить мне» push, in the device language. */
export function registerReminderCategory(): Promise<unknown> {
  const background = { opensAppToForeground: false };
  return Notifications.setNotificationCategoryAsync(reminderCategory, [
    {
      identifier: reminderActionIDs.inHour,
      buttonTitle: i18n.t("reminderPushInHour"),
      options: background,
    },
    {
      identifier: reminderActionIDs.tomorrow,
      buttonTitle: i18n.t("reminderPushTomorrow"),
      options: background,
    },
    {
      identifier: reminderActionIDs.done,
      buttonTitle: i18n.t("reminderPushDone"),
      options: background,
    },
  ]);
}

const loadQueue = async () =>
  (await accountValues.get<ReminderAction[]>(key)) ?? [];
const saveQueue = (queue: ReminderAction[]) =>
  accountValues.set(key, queue.length ? queue : null);

let chain: Promise<unknown> = Promise.resolve();
function serial<T>(work: () => Promise<T>): Promise<T> {
  const next = chain.then(work, work);
  chain = next.catch(() => undefined);
  return next;
}

/**
 * Handles a pressed button of a reminder push. True when the response was
 * one of them (the caller then does not open the chat).
 */
export function handleReminderResponse(
  response: Pick<Notifications.NotificationResponse, "actionIdentifier"> & {
    notification: {
      request: { identifier: string; content: { data?: unknown } };
    };
  },
): boolean {
  const action = reminderAction(
    response.actionIdentifier,
    response.notification.request.content.data,
    new Date(),
  );
  if (!action) return false;
  void Notifications.dismissNotificationAsync(
    response.notification.request.identifier,
  ).catch(() => undefined);
  void serial(async () => {
    const queue = queueReminderAction(await loadQueue(), action);
    await saveQueue(queue);
    if (!liveAPI) return;
    const { left } = await drainReminderActions(liveAPI, queue, new Date());
    await saveQueue(left);
  }).catch(() => undefined);
  return true;
}

/** Sends the actions that waited; the reminder lists read again after. */
export function flushReminderActions(
  api: API,
  queryClient: QueryClient,
  userID: string,
): Promise<void> {
  return serial(async () => {
    const queue = await loadQueue();
    if (!queue.length) return;
    const { left, sent } = await drainReminderActions(api, queue, new Date());
    await saveQueue(left);
    if (sent)
      void queryClient.invalidateQueries({
        queryKey: reminderKeys.all(userID),
      });
  });
}
