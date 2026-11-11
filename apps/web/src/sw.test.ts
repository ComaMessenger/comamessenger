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
