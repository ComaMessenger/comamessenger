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
      badge: 3,
    };
    expect(parseNotification(JSON.stringify(payload))).toEqual({
      title: "Anna · Design",
      body: "Hi",
      url: `/chat/${chat}/thread/${thread}`,
      chatID: chat,
      eventSeq: 42,
      badge: 3,
      silent: false,
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
    // «Message not sent» opens the list of scheduled messages.
    expect(notificationRoute({ url: "/scheduled" })).toBe("/scheduled");
    expect(
      parseNotification(JSON.stringify({ ...payload, url: "/scheduled" }))?.url,
    ).toBe("/scheduled");
    expect(notificationRoute({ url: "/scheduledx" })).toBeNull();
  });

  it("reads the quiet flag of «Send without sound» only when it is true", () => {
    const base = { v: 1, title: "Anna", body: "Hi", event_seq: 1 };
    expect(
      parseNotification(JSON.stringify({ ...base, silent: true }))?.silent,
    ).toBe(true);
    expect(parseNotification(JSON.stringify(base))?.silent).toBe(false);
    expect(
      parseNotification(JSON.stringify({ ...base, silent: "true" }))?.silent,
    ).toBe(false);
  });

  it("opens a message, a reminder and «Важные» tabs (phase 6.4)", () => {
    const message = "0192f0c4-3333-7000-8000-000000000003";
    const reminder = "0192f0c4-4444-7000-8000-000000000004";
    const request = `/chat/${chat}?message=${message}`;
    const remind = `${request}&reminder=${reminder}`;
    expect(notificationRoute({ url: request })).toBe(request);
    expect(notificationRoute({ url: remind })).toBe(remind);
    expect(notificationRoute({ url: "/important?tab=reminders" })).toBe(
      "/important?tab=reminders",
    );
    expect(notificationRoute({ url: "/important" })).toBe("/important");
    expect(notificationRoute({ url: "/important?tab=evil" })).toBeNull();
    expect(
      notificationRoute({ url: `${request}&next=https://evil.test` }),
    ).toBeNull();
    expect(notificationRoute({ url: `/chat/${chat}?message=x` })).toBeNull();
  });

  it("reads the kind and ids of a reminder push", () => {
    const message = "0192f0c4-3333-7000-8000-000000000003";
    const reminder = "0192f0c4-4444-7000-8000-000000000004";
    const base = { v: 1, title: "Напоминание", body: "Hi", event_seq: 1 };
    expect(
      parseNotification(
        JSON.stringify({
          ...base,
          kind: "reminder",
          message_id: message,
          reminder_id: reminder,
        }),
      ),
    ).toMatchObject({
      kind: "reminder",
      messageID: message,
      reminderID: reminder,
    });
    const plain = parseNotification(
      JSON.stringify({ ...base, kind: "other", message_id: "nope" }),
    );
    expect(plain?.kind).toBeUndefined();
    expect(plain?.messageID).toBeUndefined();
  });
  it("reads a task push and opens its card in the chat", () => {
    const message = "0192f0c4-5555-7000-8000-000000000005";
    const url = `/chat/${chat}?message=${message}`;
    const content = parseNotification(
      JSON.stringify({
        v: 1,
        title: "Задача · Марина",
        body: "Инструкторы: Повесить расписание · до 12:00",
        url,
        chat_id: chat,
        event_seq: 7,
        kind: "task",
        message_id: message,
      }),
    );
    expect(content).toMatchObject({ kind: "task", url, messageID: message });
    expect(notificationRoute({ url })).toBe(url);
  });

  it("opens the card of a person: «Вы замещаете …» (phase 6.7)", () => {
    const person = "0192f0c4-5555-7000-8000-000000000005";
    const payload = {
      v: 1,
      title: "Вы замещаете: Анна Иванова",
      body: "с 20 по 30 ноября",
      url: `/people/${person}`,
      event_seq: 7,
    };
    expect(parseNotification(JSON.stringify(payload))?.url).toBe(
      `/people/${person}`,
    );
    expect(notificationRoute({ url: `/people/${person}` })).toBe(
      `/people/${person}`,
    );
    expect(notificationRoute({ url: "/people/anna" })).toBeNull();
    expect(notificationRoute({ url: `/people/${person}/edit` })).toBeNull();
    expect(notificationRoute({ url: "/people" })).toBeNull();
  });

  it("opens a poll message from its push (phase 6.7)", () => {
    const message = "0192f0c4-6666-7000-8000-000000000006";
    const payload = {
      v: 1,
      title: "Напоминание: опрос",
      body: "Марина Соколова · Инструкторы · до пт, 18:00",
      url: `/chat/${chat}?message=${message}`,
      chat_id: chat,
      kind: "poll",
      event_seq: 8,
    };
    const parsed = parseNotification(JSON.stringify(payload));
    expect(parsed?.url).toBe(`/chat/${chat}?message=${message}`);
    // No buttons for a poll: only reminders and requests have a kind.
    expect(parsed?.kind).toBeUndefined();
  });
});
