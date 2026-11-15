import { describe, expect, it } from "vitest";
import {
  messageMenu,
  remindLabelKey,
  type MessageMenuFacts,
} from "./messageMenu";

const base: MessageMenuFacts = {
  own: false,
  canModerate: false,
  canPin: false,
  pinned: false,
  saved: false,
  inThread: false,
  hasText: true,
  persisted: true,
};

describe("messageMenu: remind", () => {
  it("stands right after «В важные», before pin and forward", () => {
    expect(messageMenu({ ...base, reminders: true, canPin: true })[1]).toEqual([
      "save",
      "remind",
      "pin",
      "forward",
      "details",
    ]);
    expect(messageMenu({ ...base, reminders: true, saved: true })[1]).toEqual([
      "unsave",
      "remind",
      "forward",
      "details",
    ]);
  });

  it("is absent without server support and for unsent messages", () => {
    expect(messageMenu(base).flat()).not.toContain("remind");
    expect(
      messageMenu({ ...base, reminders: true, persisted: false }).flat(),
    ).not.toContain("remind");
  });

  it("is there for any sent message, own or not", () => {
    expect(
      messageMenu({ ...base, reminders: true, own: true }).flat(),
    ).toContain("remind");
  });

  it("reads «Изменить напоминание» when one is set", () => {
    expect(remindLabelKey(false)).toBe("messageRemindMe");
    expect(remindLabelKey(true)).toBe("messageEditReminder");
  });
});

describe("messageMenu: «Сделать задачей» (wave 3)", () => {
  it("stands right after «Напомнить мне»", () => {
    expect(
      messageMenu({ ...base, reminders: true, tasks: true, canPin: true })[1],
    ).toEqual(["save", "remind", "makeTask", "pin", "forward", "details"]);
    expect(messageMenu({ ...base, tasks: true })[1]).toEqual([
      "save",
      "makeTask",
      "forward",
      "details",
    ]);
  });

  it("is only for saved text messages, with tasks on the server", () => {
    const has = (facts: Partial<MessageMenuFacts>) =>
      messageMenu({ ...base, tasks: true, ...facts })
        .flat()
        .includes("makeTask");
    expect(has({})).toBe(true);
    expect(has({ messageType: "text" })).toBe(true);
    expect(has({ inThread: true })).toBe(true);
    expect(has({ tasks: false })).toBe(false);
    expect(has({ tasks: undefined })).toBe(false);
    expect(has({ messageType: "task" })).toBe(false);
    expect(has({ messageType: "request" })).toBe(false);
    expect(has({ messageType: "poll" })).toBe(false);
    expect(has({ hasText: false })).toBe(false);
    expect(has({ persisted: false })).toBe(false);
  });

  it("does not edit a task as text", () => {
    expect(
      messageMenu({ ...base, own: true, messageType: "task" }).flat(),
    ).not.toContain("edit");
    expect(messageMenu({ ...base, own: true }).flat()).toContain("edit");
  });

  it("edits the question of one's own poll", () => {
    expect(
      messageMenu({ ...base, own: true, messageType: "poll" }).flat(),
    ).toContain("edit");
    expect(
      messageMenu({ ...base, own: false, messageType: "poll" }).flat(),
    ).not.toContain("edit");
    expect(
      messageMenu({
        ...base,
        own: true,
        messageType: "poll",
        pollClosed: true,
      }).flat(),
    ).not.toContain("edit");
  });
});
