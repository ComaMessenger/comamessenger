import * as Notifications from "expo-notifications";
import i18n from "@/i18n";

/** Android channel of ordinary message notifications: sound and vibration. */
export const messagesChannel = "messages";
/**
 * Android channel of quiet messages («Send without sound»): shown like any
 * other message, but Android ties sound and vibration to the channel, so
 * they need one of their own.
 */
export const quietMessagesChannel = "messages-quiet";

/** Creates both channels; repeating it only updates their names. Android only. */
export async function ensureMessageChannels(): Promise<void> {
  await Notifications.setNotificationChannelAsync(messagesChannel, {
    name: i18n.t("notificationChannel"),
    importance: Notifications.AndroidImportance.HIGH,
  });
  await Notifications.setNotificationChannelAsync(quietMessagesChannel, {
    name: i18n.t("notificationChannelQuiet"),
    importance: Notifications.AndroidImportance.HIGH,
    sound: null,
    enableVibrate: false,
    vibrationPattern: null,
  });
}
