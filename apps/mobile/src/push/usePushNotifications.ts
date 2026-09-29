import { useEffect } from "react";
import { AppState } from "react-native";
import { router } from "expo-router";
import * as Notifications from "expo-notifications";
import type { MessengerAPI, UnreadSnapshot } from "@comamessenger/core";
import type { MessengerStore } from "@/messenger/MessengerProvider";
import { registerBackgroundNotifications } from "./background";
import { notificationRoute } from "./codec";
import { registerForPush } from "./registration";

// While the app is open realtime already shows new messages; the server also
// suppresses pushes for the open chat.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: false,
    shouldShowList: true,
    shouldPlaySound: false,
    shouldSetBadge: true,
  }),
});

function unreadTotal(unread: UnreadSnapshot): number {
  return unread.chats.reduce((sum, item) => sum + item.unread_count, 0);
}

/**
 * Push for the signed-in session: silent registration when permission was
 * already granted, token rotation, opening chats from notifications and the
 * app icon badge.
 */
export function usePushNotifications(api: MessengerAPI, store: MessengerStore) {
  useEffect(() => {
    void registerBackgroundNotifications().catch(() => undefined);
    void registerForPush(api, { prompt: false }).catch(() => undefined);
    const tokens = Notifications.addPushTokenListener(() => {
      void registerForPush(api, { prompt: false }).catch(() => undefined);
    });
    return () => tokens.remove();
  }, [api]);

  useEffect(() => {
    const open = (response: Notifications.NotificationResponse | null) => {
      const route = notificationRoute(
        response?.notification.request.content.data,
      );
      if (route) router.push(route as never);
    };
    open(Notifications.getLastNotificationResponse());
    Notifications.clearLastNotificationResponse();
    const subscription =
      Notifications.addNotificationResponseReceivedListener(open);
    return () => subscription.remove();
  }, []);

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
