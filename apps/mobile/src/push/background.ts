import { Platform } from "react-native";
import * as Notifications from "expo-notifications";
import * as TaskManager from "expo-task-manager";
import { openNotification } from "./keys";

const task = "coma-push";

type TaskData = { data?: { dataString?: string; [key: string]: unknown } };

function field(data: TaskData["data"], name: string): string | undefined {
  if (!data) return undefined;
  if (typeof data[name] === "string") return data[name] as string;
  if (!data.dataString) return undefined;
  try {
    const parsed = JSON.parse(data.dataString) as Record<string, unknown>;
    return typeof parsed[name] === "string"
      ? (parsed[name] as string)
      : undefined;
  } catch {
    return undefined;
  }
}

// Android receives data-only FCM messages (the relay never sends a visible
// notification there), decrypts them and shows the notification itself. iOS
// decrypts in the Notification Service Extension instead.
if (Platform.OS === "android")
  TaskManager.defineTask<TaskData>(task, async ({ data, error }) => {
    if (error || !data?.data) return;
    const sealed = field(data.data, "c");
    const content = sealed ? await openNotification(sealed) : null;
    if (content?.badge !== undefined)
      await Notifications.setBadgeCountAsync(content.badge).catch(
        () => undefined,
      );
    await Notifications.scheduleNotificationAsync({
      content: {
        title: content?.title ?? field(data.data, "title") ?? "Coma",
        body: content?.body ?? field(data.data, "body") ?? "",
        data: content?.url ? { url: content.url } : {},
      },
      trigger: { channelId: "messages" },
    });
  });

export function registerBackgroundNotifications(): Promise<unknown> {
  return Platform.OS === "android"
    ? Notifications.registerTaskAsync(task)
    : Promise.resolve(null);
}
