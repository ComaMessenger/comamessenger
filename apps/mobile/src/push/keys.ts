import { Platform } from "react-native";
import Constants from "expo-constants";
import * as SecureStore from "expo-secure-store";
import {
  AESEncryptionKey,
  AESKeySize,
  AESSealedData,
  aesDecryptAsync,
} from "expo-crypto";
import {
  base64ToBytes,
  parseNotification,
  utf8Decode,
  type NotificationContent,
} from "./codec";

const extra = (Constants.expoConfig?.extra ?? {}) as {
  appGroup?: string;
  pushRelayURL?: string;
};

/** Relay this build registers with; the instance must send through the same one. */
export const pushRelayURL = (extra.pushRelayURL ?? "").replace(/\/+$/, "");

// On iOS the Notification Service Extension reads the key through the shared
// App Group keychain; its Swift code uses the same service and account names.
const keyOptions: SecureStore.SecureStoreOptions = {
  keychainService: "coma.push",
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
  ...(Platform.OS === "ios" && extra.appGroup
    ? { accessGroup: extra.appGroup }
    : {}),
};
const stateOptions: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
};

export type PushState = {
  handle: string;
  platformToken: string;
  deviceID: string;
  server: string;
};

export async function notificationKey(): Promise<string> {
  const existing = await SecureStore.getItemAsync(
    "notification_key",
    keyOptions,
  );
  if (existing) return existing;
  const key = await AESEncryptionKey.generate(AESKeySize.AES256);
  const encoded = await key.encoded("base64");
  await SecureStore.setItemAsync("notification_key", encoded, keyOptions);
  return encoded;
}

export async function loadPushState(): Promise<PushState | null> {
  const raw = await SecureStore.getItemAsync("coma.push_state", stateOptions);
  return raw ? (JSON.parse(raw) as PushState) : null;
}

export async function savePushState(state: PushState | null): Promise<void> {
  if (state)
    await SecureStore.setItemAsync(
      "coma.push_state",
      JSON.stringify(state),
      stateOptions,
    );
  else await SecureStore.deleteItemAsync("coma.push_state", stateOptions);
}

/** Opens base64(nonce ‖ ciphertext ‖ tag) sealed by the instance with AES-256-GCM. */
export async function openNotification(
  sealed: string,
): Promise<NotificationContent | null> {
  try {
    const keyValue = await SecureStore.getItemAsync(
      "notification_key",
      keyOptions,
    );
    if (!keyValue) return null;
    const key = await AESEncryptionKey.import(base64ToBytes(keyValue));
    const data = AESSealedData.fromCombined(base64ToBytes(sealed), {
      ivLength: 12,
      tagLength: 16,
    });
    const plaintext = await aesDecryptAsync(data, key, { output: "bytes" });
    return parseNotification(utf8Decode(plaintext));
  } catch {
    return null;
  }
}
