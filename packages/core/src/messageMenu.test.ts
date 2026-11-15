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
