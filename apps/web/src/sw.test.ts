import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

type Listener = (event: {
  data?: { json(): unknown };
  waitUntil(promise: unknown): void;
}) => void;

/** Runs public/sw.js against a fake worker scope and returns its push handler. */
function loadWorker() {
  const listeners: Record<string, Listener> = {};
  const shown: Array<{ title: string; options: Record<string, unknown> }> = [];
  const scope = {
    addEventListener(type: string, listener: Listener) {
      listeners[type] = listener;
    },
    registration: {
      showNotification(title: string, options: Record<string, unknown>) {
        shown.push({ title, options });
        return Promise.resolve();
      },
    },
  };
  const source = readFileSync(resolve(process.cwd(), "public/sw.js"), "utf8");
  new Function("self", "clients", source)(scope, {});
  const push = (payload: unknown) =>
    listeners.push!({
      data: { json: () => payload },
      waitUntil: () => undefined,
    });
  return { push, shown };
}

describe("service worker notifications", () => {
  it("passes the quiet flag and the server's tag", () => {
    const worker = loadWorker();
    worker.push({ title: "Anna", body: "psst", chat_id: "c1", silent: true });
    worker.push({ title: "Anna", body: "hi", chat_id: "c1" });
    worker.push({
      title: "Сообщение не отправлено",
      body: "Вложение удалено",
      url: "/scheduled",
      tag: "scheduled-failed",
    });
    expect(worker.shown.map((item) => item.options.silent)).toEqual([
      true,
      false,
      false,
    ]);
    expect(worker.shown.map((item) => item.options.tag)).toEqual([
      "chat:c1",
      "chat:c1",
      "scheduled-failed",
    ]);
    expect(worker.shown[2]!.options.data).toEqual({ url: "/scheduled" });
  });
});

describe("service worker addresses", () => {
  it("opens requests, reminders and «Важные» and nothing foreign", () => {
    const worker = loadWorker();
    const chat = "0198a7c2-1c55-7c3e-9c1e-2b1d0d6a1c01";
    const message = "0198a7c2-1c55-7c3e-9c1e-2b1d0d6a1c02";
    const reminder = "0198a7c2-1c55-7c3e-9c1e-2b1d0d6a1c03";
    worker.push({ title: "Запрос · Анна", chat_id: chat, url: `/chat/${chat}?message=${message}` });
    worker.push({
      title: "Напоминание",
      chat_id: chat,
      kind: "reminder",
      url: `/chat/${chat}?message=${message}&reminder=${reminder}`,
    });
    worker.push({ title: "Напоминание", kind: "reminder", url: "/important?tab=reminders" });
    worker.push({ title: "Напоминание", kind: "reminder" });
    worker.push({ title: "Coma", url: "https://evil.example/" });
    worker.push({ title: "Coma", chat_id: chat, url: "//evil.example/chat" });
    worker.push({ title: "Coma", url: "/settings/notifications" });
    expect(worker.shown.map((item) => item.options.data)).toEqual([
      { url: `/chat/${chat}?message=${message}` },
      { url: `/chat/${chat}?message=${message}&reminder=${reminder}` },
      { url: "/important?tab=reminders" },
      { url: "/important?tab=reminders" },
      { url: "/chats" },
      { url: `/chat/${chat}` },
      { url: "/settings/notifications" },
    ]);
  });
});
