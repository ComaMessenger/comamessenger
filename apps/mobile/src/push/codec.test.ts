import { describe, expect, it } from "vitest";
import {
  base64ToBytes,
  notificationRoute,
  parseNotification,
  utf8Decode,
} from "./codec";

const chat = "0192f0c4-1111-7000-8000-000000000001";
const thread = "0192f0c4-2222-7000-8000-000000000002";

describe("notification codec", () => {
  it("decodes base64 and UTF-8 like the server encodes them", () => {
    const text = "Привет, 👋 Coma";
    const encoded = Buffer.from(text, "utf8").toString("base64");
    expect(utf8Decode(base64ToBytes(encoded))).toBe(text);
    expect(() => base64ToBytes("не base64")).toThrow();
  });

  it("accepts only version 1 payloads and in-app routes", () => {
    const payload = {
      v: 1,
      title: "Anna · Design",
      body: "Hi",
      url: `/chat/${chat}/thread/${thread}`,
      chat_id: chat,
      event_seq: 42,
    };
    expect(parseNotification(JSON.stringify(payload))).toEqual({
      title: "Anna · Design",
      body: "Hi",
      url: `/chat/${chat}/thread/${thread}`,
      chatID: chat,
      eventSeq: 42,
    });
    expect(
      parseNotification(
        JSON.stringify({ ...payload, url: "https://evil.test" }),
      )?.url,
    ).toBeUndefined();
    expect(parseNotification(JSON.stringify({ ...payload, v: 2 }))).toBeNull();
    expect(parseNotification("{")).toBeNull();
    expect(notificationRoute({ url: `/chat/${chat}` })).toBe(`/chat/${chat}`);
    expect(notificationRoute({ url: "/settings" })).toBeNull();
  });
});
