import { describe, expect, it } from "vitest";
import type {
  Chat,
  DurableEvent,
  User,
  UserPreferences,
} from "@comamessenger/core";
import { shouldPlayNotificationSound } from "./notificationSound";

const user = { id: "recipient", timezone: "UTC" } as User;
const chat = {
  id: "chat",
  kind: "group",
  notify_level: "default",
  muted_until: null,
} as Chat;
const preferences = {
  sound_enabled: true,
  snoozed_until: null,
  schedule: null,
  notify_messages: "direct_and_mentions",
  notify_threads: "mentions",
  notify_reactions: true,
  notify_invites: true,
  notify_system: true,
} as UserPreferences;
const event = {
  op: "event",
  seq: 1,
  type: "message.created",
  occurred_at: "2026-08-24T12:00:00Z",
  actor_id: "sender",
  chat_id: "chat",
  subject_id: "message",
  data: {},
} as DurableEvent;

describe("notification sound policy", () => {
  it("follows mentions, chat overrides and snooze", () => {
    expect(shouldPlayNotificationSound(event, user, preferences, chat)).toBe(
      false,
    );
    expect(
      shouldPlayNotificationSound(
        { ...event, data: { mentioned_actor_ids: [user.id] } },
        user,
        preferences,
        chat,
      ),
    ).toBe(true);
    expect(
      shouldPlayNotificationSound(event, user, preferences, {
        ...chat,
        notify_level: "all",
      }),
    ).toBe(true);
    expect(
      shouldPlayNotificationSound(
        event,
        user,
        {
          ...preferences,
          snoozed_until: "2026-08-24T13:00:00Z",
        },
        chat,
      ),
    ).toBe(false);
  });

  it("applies quiet hours and category preferences", () => {
    expect(
      shouldPlayNotificationSound(
        event,
        user,
        {
          ...preferences,
          schedule: { days: "weekdays", from: "13:00", to: "18:00" },
        },
        { ...chat, notify_level: "all" },
      ),
    ).toBe(false);
    expect(
      shouldPlayNotificationSound({ ...event, type: "reaction.added" }, user, {
        ...preferences,
        notify_reactions: false,
      }),
    ).toBe(false);
  });
});
