import { afterAll, describe, expect, it } from "vitest";
import { APIError } from "./api";
import {
  applyReminderEvent,
  formatReminderWhen,
  groupReminders,
  parseReminderEvent,
  reduceReminderIds,
  reduceReminders,
  reminderAt,
  reminderCustomDays,
  reminderErrorKind,
  reminderFor,
  reminderHref,
  reminderInput,
  reminderKeys,
  reminderMissed,
  reminderPresetHint,
  reminderPresets,
  reminderProblem,
  upsertReminder,
  withReminder,
  type ParsedReminderEvent,
} from "./reminders";
import { fromLocalInputValue, toLocalInputValue } from "./scheduled";
import type { Reminder, ReminderIdEntry } from "./types";

// Berlin time, set before collection: describe blocks build dates at once.
// Daylight saving ends on 25 October 2026 (03:00 → 02:00); 15 November 2026
// is a Sunday.
const previousTZ = process.env.TZ;
process.env.TZ = "Europe/Berlin";
afterAll(() => {
  process.env.TZ = previousTZ;
});

const local = (value: string) => fromLocalInputValue(value)!;
const presets = (now: string) =>
  Object.fromEntries(
    reminderPresets(local(now)).map((preset) => [
      preset.id,
      toLocalInputValue(preset.at),
    ]),
  );

function reminder(overrides: Partial<Reminder> = {}): Reminder {
  return {
    id: "r1",
    message_id: "m1",
    chat_id: "c1",
    note: "",
    remind_at: local("2026-11-16T09:00").toISOString(),
    state: "pending",
    fired_at: null,
    late: false,
    version: 1,
    access: "available",
    message: null,
    ...overrides,
  };
}

function parsed(type: string, data: Record<string, unknown>) {
  const event = parseReminderEvent({
    type,
    data: { id: "r1", message_id: "m1", chat_id: "c1", ...data },
  });
  if (!event) throw new Error(`unparsed ${type}`);
  return event;
}

describe("ready-made times", () => {
  it("offers an hour, the evening, tomorrow morning and Monday", () => {
    // Saturday 14 November, 9:41, as in the prototype.
    expect(presets("2026-11-14T09:41")).toEqual({
      inHour: "2026-11-14T10:41",
      thisEvening: "2026-11-14T18:00",
      tomorrowMorning: "2026-11-15T09:00",
      nextMonday: "2026-11-16T09:00",
    });
  });

  it("hides the evening when less than an hour is left", () => {
    expect(presets("2026-11-14T17:00")).toHaveProperty("thisEvening");
    expect(presets("2026-11-14T17:01")).not.toHaveProperty("thisEvening");
  });

  it("means the next Monday on a Monday and skips it on a Sunday", () => {
    expect(presets("2026-11-16T10:00").nextMonday).toBe("2026-11-23T09:00");
    expect(presets("2026-11-15T10:00")).not.toHaveProperty("nextMonday");
  });

  it("keeps 9:00 across the autumn change", () => {
    // Saturday 24 October: the night to Sunday is 25 hours long.
    expect(presets("2026-10-24T20:00")).toEqual({
      inHour: "2026-10-24T21:00",
      tomorrowMorning: "2026-10-25T09:00",
      nextMonday: "2026-10-26T09:00",
    });
    const now = local("2026-10-24T20:00");
    const morning = reminderPresets(now).find(
      (preset) => preset.id === "tomorrowMorning",
    )!;
    expect(morning.at.getTime() - now.getTime()).toBe(14 * 3_600_000);
  });

  it("words the hints as in the prototype", () => {
    const now = local("2026-11-14T09:41");
    const hints = Object.fromEntries(
      reminderPresets(now).map((preset) => [
        preset.id,
        reminderPresetHint(preset, now, "ru"),
      ]),
    );
    expect(hints).toEqual({
      inHour: "в 10:41",
      thisEvening: "в 18:00",
      tomorrowMorning: "вс, в 9:00",
      nextMonday: "16 ноября, 9:00",
    });
  });

  it("words a time for the button and the toast", () => {
    const now = local("2026-11-14T09:41");
    expect(formatReminderWhen(local("2026-11-14T10:41"), now, "ru")).toBe(
      "сегодня в 10:41",
    );
    expect(formatReminderWhen(local("2026-11-15T09:00"), now, "ru")).toBe(
      "завтра в 9:00",
    );
    expect(formatReminderWhen(local("2026-11-16T09:00"), now, "ru")).toBe(
      "пн, 16 ноября, 9:00",
    );
    expect(formatReminderWhen(local("2026-11-15T09:00"), now, "en")).toBe(
      "tomorrow at 9:00 AM",
    );
    expect(formatReminderWhen(local("2027-01-04T09:00"), now, "ru")).toBe(
      "пн, 4 января 2027, 9:00",
    );
  });

  it("offers days for «Своё время» without the Monday already offered", () => {
    const days = reminderCustomDays(local("2026-11-14T09:41")).map((day) =>
      toLocalInputValue(day).slice(0, 10),
    );
    expect(days).toEqual(["2026-11-17", "2026-11-18", "2026-11-19"]);
    expect(
      toLocalInputValue(reminderAt(local("2026-11-17T00:00"), 9, 30)),
    ).toBe("2026-11-17T09:30");
  });

  it("keeps times between a minute and a year ahead and short notes", () => {
    const now = local("2026-11-14T09:41");
    expect(reminderProblem(local("2026-11-14T09:41"), now)).toBe("past");
    expect(reminderProblem(local("2026-11-14T09:43"), now)).toBeNull();
    expect(reminderProblem(local("2027-11-15T09:41"), now)).toBe("tooFar");
    expect(
      reminderProblem(local("2026-11-15T09:00"), now, "x".repeat(201)),
    ).toBe("noteTooLong");
    expect(reminderInput(local("2026-11-15T09:00"), "  позвонить ")).toEqual({
      remind_at: local("2026-11-15T09:00").toISOString(),
      note: "позвонить",
    });
    expect(reminderInput(local("2026-11-15T09:00"))).not.toHaveProperty("note");
  });
});

describe("the list", () => {
  const now = local("2026-11-14T09:41");

  it("puts fired ones first, then today, tomorrow, days of the week, later", () => {
    const items = [
      reminder({
        id: "later",
        remind_at: local("2026-12-01T09:00").toISOString(),
      }),
      reminder({
        id: "mon",
        remind_at: local("2026-11-16T09:00").toISOString(),
      }),
      reminder({
        id: "today",
        remind_at: local("2026-11-14T18:00").toISOString(),
      }),
      reminder({
        id: "old",
        state: "fired",
        fired_at: local("2026-11-13T09:00").toISOString(),
        late: true,
      }),
      reminder({
        id: "new",
        state: "fired",
        fired_at: local("2026-11-14T09:00").toISOString(),
      }),
      reminder({
        id: "tomorrow",
        remind_at: local("2026-11-15T09:00").toISOString(),
      }),
      reminder({
        id: "later2",
        remind_at: local("2026-11-25T09:00").toISOString(),
      }),
    ];
    const groups = groupReminders(items, now);
    expect(groups.fired.map((item) => item.id)).toEqual(["new", "old"]);
    expect(
      groups.days.map((group) => [
        group.kind,
        group.key,
        group.items.map((item) => item.id),
      ]),
    ).toEqual([
      ["today", "2026-11-14", ["today"]],
      ["tomorrow", "2026-11-15", ["tomorrow"]],
      ["thisWeek", "2026-11-16", ["mon"]],
      ["later", "later", ["later2", "later"]],
    ]);
    expect(reminderMissed(groups.fired[1]!)).toBe(true);
  });

  it("leads to the message, or to the list without one", () => {
    expect(reminderHref(reminder())).toBe("/chat/c1?message=m1&reminder=r1");
    expect(
      reminderHref(reminder({ message_id: null, access: "deleted" })),
    ).toBe("/important?tab=reminders");
    expect(reminderHref(reminder({ access: "none" }))).toBe(
      "/important?tab=reminders",
    );
  });
});

describe("realtime", () => {
  it("rejects malformed events and keeps the reason", () => {
    expect(
      parseReminderEvent({ type: "reminder.created", data: { id: "r1" } }),
    ).toBeNull();
    expect(
      parseReminderEvent({
        type: "reminder.snoozed",
        data: {
          id: "r1",
          message_id: null,
          chat_id: "c1",
          version: 1,
          remind_at: "x",
          state: "pending",
        },
      }),
    ).toBeNull();
    const deleted = parsed("reminder.deleted", {
      remind_at: "2026-11-16T08:00:00Z",
      state: "pending",
      version: 2,
      reason: "message_deleted",
    });
    expect(deleted.data).toMatchObject({ reason: "message_deleted" });
  });

  it("moves, fires and deletes by version", () => {
    const items = [reminder()];
    const moved = reduceReminders(
      items,
      parsed("reminder.updated", {
        remind_at: "2026-11-17T08:00:00Z",
        state: "pending",
        version: 2,
      }),
    );
    expect(moved.items[0]).toMatchObject({
      remind_at: "2026-11-17T08:00:00Z",
      version: 2,
    });
    expect(moved.stale).toBe(true);
    const old = reduceReminders(
      moved.items,
      parsed("reminder.updated", {
        remind_at: "2026-11-16T08:00:00Z",
        state: "pending",
        version: 1,
      }),
    );
    expect(old.changed).toBe(false);
    const fired = reduceReminders(
      moved.items,
      parsed("reminder.fired", {
        fired_at: "2026-11-17T08:20:00Z",
        late: true,
        version: 3,
      }),
    );
    expect(fired.items[0]).toMatchObject({
      state: "fired",
      late: true,
      version: 3,
    });
    // Moving a fired one returns it to pending.
    const again = reduceReminders(
      fired.items,
      parsed("reminder.updated", {
        remind_at: "2026-11-18T08:00:00Z",
        state: "pending",
        version: 4,
      }),
    );
    expect(again.items[0]).toMatchObject({
      state: "pending",
      fired_at: null,
      late: false,
    });
    const gone = reduceReminders(
      again.items,
      parsed("reminder.deleted", {
        remind_at: "2026-11-18T08:00:00Z",
        state: "pending",
        version: 4,
        reason: "removed",
      }),
    );
    expect(gone.items).toEqual([]);
  });

  it("asks for the list when the reminder is unknown", () => {
    const result = reduceReminders(
      [],
      parsed("reminder.created", {
        remind_at: "2026-11-17T08:00:00Z",
        state: "pending",
        version: 1,
      }),
    );
    expect(result).toEqual({ items: [], changed: false, stale: true });
  });

  it("keeps the newer record on upsert", () => {
    expect(
      upsertReminder([reminder({ version: 3 })], reminder({ version: 2 }))[0]!
        .version,
    ).toBe(3);
    expect(upsertReminder([reminder()], reminder({ id: "r2" }))).toHaveLength(
      2,
    );
  });

  it("keeps the bells of a chat", () => {
    const entries: ReminderIdEntry[] = [
      { message_id: "m1", remind_at: "2026-11-16T08:00:00Z", state: "pending" },
    ];
    expect(reminderFor(entries, "m1")?.state).toBe("pending");
    const created = reduceReminderIds(
      entries,
      "c1",
      parsed("reminder.created", {
        id: "r2",
        message_id: "m2",
        remind_at: "2026-11-17T08:00:00Z",
        state: "pending",
        version: 1,
      }),
    );
    expect(created.map((entry) => entry.message_id)).toEqual(["m1", "m2"]);
    const fired = reduceReminderIds(
      created,
      "c1",
      parsed("reminder.fired", {
        fired_at: "2026-11-16T08:00:00Z",
        late: false,
        version: 2,
      }),
    );
    expect(reminderFor(fired, "m1")?.state).toBe("fired");
    const other = reduceReminderIds(
      fired,
      "c2",
      parsed("reminder.deleted", {
        remind_at: "x",
        state: "fired",
        version: 2,
      }),
    );
    expect(other).toHaveLength(2);
    expect(
      withReminder(fired, "m1", null).map((entry) => entry.message_id),
    ).toEqual(["m2"]);
    expect(withReminder(undefined, "m3", "2026-11-20T08:00:00Z")).toEqual([
      { message_id: "m3", remind_at: "2026-11-20T08:00:00Z", state: "pending" },
    ]);
  });

  it("updates TanStack caches: the bells now, the lists on next view", () => {
    const calls: unknown[] = [];
    let ids: ReminderIdEntry[] | undefined = [];
    applyReminderEvent(
      {
        setQueryData: (key, updater) => {
          calls.push(["set", key]);
          ids = updater(ids);
        },
        invalidateQueries: ({ queryKey }) =>
          calls.push(["invalidate", queryKey]),
      },
      "me",
      parsed("reminder.created", {
        remind_at: "2026-11-17T08:00:00Z",
        state: "pending",
        version: 1,
      }) as ParsedReminderEvent,
    );
    expect(calls).toEqual([
      ["set", reminderKeys.ids("me", "c1")],
      ["invalidate", ["reminders", "me", "list"]],
    ]);
    expect(ids).toHaveLength(1);
  });
});

describe("errors", () => {
  it("maps server codes", () => {
    const error = (status: number, code: string) =>
      new APIError(status, code as never, code);
    expect(reminderErrorKind(error(422, "reminder_invalid"))).toBe("invalid");
    expect(reminderErrorKind(error(409, "reminder_limit_reached"))).toBe(
      "limit",
    );
    expect(reminderErrorKind(error(404, "message_not_found"))).toBe("gone");
    expect(reminderErrorKind(error(501, "not_implemented"))).toBe(
      "unavailable",
    );
    expect(reminderErrorKind(new Error("offline"))).toBe("network");
  });
});
