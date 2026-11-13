import { Platform } from "react-native";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import Constants from "expo-constants";
import type { MessengerAPI } from "@comamessenger/core";
import i18n from "@/i18n";
import {
  loadPushState,
  notificationKey,
  pushRelayURL,
  savePushState,
} from "./keys";
import { ensureMessageChannels } from "./channels";

export type PushAvailability = "ready" | "denied" | "unsupported";

async function relay(path: string, method: string, body?: unknown) {
  return fetch(`${pushRelayURL}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** Gets a relay handle for the current platform token, reusing the old one. */
async function relayHandle(
  platform: "ios" | "android",
  token: string,
): Promise<string> {
  const state = await loadPushState();
  if (state?.handle) {
    if (state.platformToken === token) return state.handle;
    const updated = await relay(`/v1/devices/${state.handle}`, "PUT", {
      token,
    });
    if (updated.ok) return state.handle;
    if (updated.status !== 410) throw new Error(`relay ${updated.status}`);
  }
  const created = await relay("/v1/devices", "POST", { platform, token });
  if (!created.ok) throw new Error(`relay ${created.status}`);
  return ((await created.json()) as { handle: string }).handle;
}

/**
 * Registers this phone for push with the relay and the instance. Runs only
 * when the instance sends through the same relay this build was made for.
 */
export function registerForPush(
  api: MessengerAPI,
  options: { prompt: boolean },
): Promise<PushAvailability> {
  // One registration at a time. Reading the platform token can itself fire the
  // token listener, and overlapping runs each asked the relay for a new handle
  // before the first one was saved: one phone ended up as many devices.
  const running = inFlight.get(api);
  if (running) return running;
  const started = register(api, options).finally(() => inFlight.delete(api));
  inFlight.set(api, started);
  return started;
}

const inFlight = new Map<MessengerAPI, Promise<PushAvailability>>();
/** Platform token each signed-in session has already registered. */
const registered = new WeakMap<MessengerAPI, string>();

async function register(
  api: MessengerAPI,
  options: { prompt: boolean },
): Promise<PushAvailability> {
  if (!Device.isDevice || !pushRelayURL) return "unsupported";
  const config = await api.pushConfig();
  if ((config.mobile_relay_url ?? "").replace(/\/+$/, "") !== pushRelayURL)
    return "unsupported";
  let permission = await Notifications.getPermissionsAsync();
  if (!permission.granted && options.prompt && permission.canAskAgain)
    permission = await Notifications.requestPermissionsAsync();
  if (!permission.granted) return "denied";

  if (Platform.OS === "android") await ensureMessageChannels();
  const platform = Platform.OS === "ios" ? "ios" : "android";
  const token = (await Notifications.getDevicePushTokenAsync()).data as string;
  // The same token for the same session is already registered; only a rotated
  // token needs another round trip.
  if (registered.get(api) === token) return "ready";
  const handle = await relayHandle(platform, token);
  const device = await api.putMobilePushDevice({
    platform,
    relay_handle: handle,
    notification_key: await notificationKey(),
    app_version: Constants.expoConfig?.version ?? "",
    locale: i18n.language,
  });
  await savePushState({
    handle,
    platformToken: token,
    deviceID: device.id,
    server: api.apiURL,
  });
  registered.set(api, token);
  return "ready";
}

/** Stops pushes for this account before signing out; the relay handle stays for reuse. */
export async function unregisterFromPush(api: MessengerAPI): Promise<void> {
  registered.delete(api);
  const state = await loadPushState();
  if (!state?.deviceID || state.server !== api.apiURL) return;
  await api.deleteMobilePushDevice(state.deviceID).catch(() => undefined);
  await savePushState({ ...state, deviceID: "" });
}
