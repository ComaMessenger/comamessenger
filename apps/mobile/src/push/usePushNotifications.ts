import { useEffect } from "react";
import { AppState } from "react-native";
import { router } from "expo-router";
import * as Notifications from "expo-notifications";
import type { QueryClient } from "@tanstack/react-query";
import type { MessengerAPI, UnreadSnapshot } from "@comamessenger/core";
import type { MessengerStore } from "@/messenger/MessengerProvider";
import { reminderCategory } from "@/reminders/actionQueue";
import {
  flushReminderActions,
  handleReminderResponse,
  registerReminderCategory,
  setLiveReminderAPI,
} from "@/reminders/pushActions";
import { registerBackgroundNotifications } from "./background";
import { notificationRoute } from "./codec";
import { registerForPush } from "./registration";

// While the app is open realtime already shows new messages; the server also
// suppresses pushes for the open chat. A «Напомнить мне» reminder is an
// alarm the person set: it shows and sounds in the app too.
Notifications.setNotificationHandler({
  handleNotification: async (notification) => {
    const reminder =
      notification.request.content.categoryIdentifier === reminderCategory;
    return {
      shouldShowBanner: reminder,
      shouldShowList: true,
      shouldPlaySound: reminder,
      shouldSetBadge: true,
    };
  },
});

function unreadTotal(unread: UnreadSnapshot): number {
  return unread.chats.reduce((sum, item) => sum + item.unread_count, 0);
}

/**
 * Push for the signed-in session: silent registration when permission was
 * already granted, token rotation, opening chats from notifications and the
 * app icon badge.
 */
export function usePushNotifications(
  api: MessengerAPI,
  store: MessengerStore,
  queryClient: QueryClient,
  userID: string,
) {
  useEffect(() => {
    void registerBackgroundNotifications().catch(() => undefined);
    void registerReminderCategory().catch(() => undefined);
    void registerForPush(api, { prompt: false }).catch(() => undefined);
    const tokens = Notifications.addPushTokenListener(() => {
      void registerForPush(api, { prompt: false }).catch(() => undefined);
    });
    return () => tokens.remove();
  }, [api]);

  // Buttons of a reminder push run here while the app is in memory.
  useEffect(() => {
    setLiveReminderAPI(api);
    return () => setLiveReminderAPI(null);
  }, [api]);

  useEffect(() => {
    const open = (response: Notifications.NotificationResponse | null) => {
      if (!response) return;
      if (
        response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER &&
        handleReminderResponse(response)
      ) {
        void flushReminderActions(api, queryClient, userID).catch(
          () => undefined,
        );
        return;
      }
      const route = notificationRoute(
        response.notification.request.content.data,
      );
      if (route) router.push(route as never);
    };
    open(Notifications.getLastNotificationResponse());
    Notifications.clearLastNotificationResponse();
    const subscription =
      Notifications.addNotificationResponseReceivedListener(open);
    return () => subscription.remove();
  }, [api, queryClient, userID]);

  useEffect(() => {
    const sync = () =>
      void Notifications.setBadgeCountAsync(
        unreadTotal(store.getState().unread),
      ).catch(() => undefined);
    const unsubscribe = store.subscribe((state, previous) => {
      if (state.unread !== previous.unread) sync();
    });
    const appState = AppState.addEventListener("change", (state) => {
      if (state === "background") sync();
    });
    return () => {
      unsubscribe();
      appState.remove();
    };
  }, [store]);
}
