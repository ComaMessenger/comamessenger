// Pure helpers for encrypted notifications; kept free of native modules so
// they are unit-tested and shared by the app and the Android background task.

const alphabet =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function base64ToBytes(value: string): Uint8Array {
  const clean = value.replace(/[\s=]/g, "");
  const bytes = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let buffer = 0;
  let bits = 0;
  let index = 0;
  for (const char of clean) {
    const digit = alphabet.indexOf(char);
    if (digit < 0) throw new Error("invalid base64");
    buffer = (buffer << 6) | digit;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[index++] = (buffer >> bits) & 0xff;
    }
  }
  return bytes.subarray(0, index);
}

export function utf8Decode(bytes: Uint8Array): string {
  let result = "";
  for (let index = 0; index < bytes.length; ) {
    const byte = bytes[index++]!;
    let code = byte;
    if (byte >= 0xf0)
      code =
        ((byte & 0x07) << 18) |
        ((bytes[index++]! & 0x3f) << 12) |
        ((bytes[index++]! & 0x3f) << 6) |
        (bytes[index++]! & 0x3f);
    else if (byte >= 0xe0)
      code =
        ((byte & 0x0f) << 12) |
        ((bytes[index++]! & 0x3f) << 6) |
        (bytes[index++]! & 0x3f);
    else if (byte >= 0xc0)
      code = ((byte & 0x1f) << 6) | (bytes[index++]! & 0x3f);
    result += String.fromCodePoint(code);
  }
  return result;
}

/** Decrypted notification from the instance (core/internal/push/mobile.go). */
export type NotificationContent = {
  title: string;
  body: string;
  /** In-app route; only chat and thread routes are accepted. */
  url?: string;
  chatID?: string;
  eventSeq: number;
};

const routePattern = /^\/chat\/[0-9a-f-]{36}(\/thread\/[0-9a-f-]{36})?$/;

export function parseNotification(json: string): NotificationContent | null {
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (
    value.v !== 1 ||
    typeof value.title !== "string" ||
    typeof value.body !== "string"
  )
    return null;
  const url =
    typeof value.url === "string" && routePattern.test(value.url)
      ? value.url
      : undefined;
  return {
    title: value.title,
    body: value.body,
    url,
    chatID: typeof value.chat_id === "string" ? value.chat_id : undefined,
    eventSeq: typeof value.event_seq === "number" ? value.event_seq : 0,
  };
}

/** Route of a tapped notification, if it points inside the app. */
export function notificationRoute(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const url = (data as Record<string, unknown>).url;
  return typeof url === "string" && routePattern.test(url) ? url : null;
}
