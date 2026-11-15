import { describe, expect, it, vi } from "vitest";
import { APIError } from "@comamessenger/core";
import {
  drainReminderActions,
  performReminderAction,
  queueReminderAction,
  reminderAction,
  reminderActionIDs,
  reminderTarget,
  type ReminderAction,
} from "./actionQueue";

const chat = "0192f0c4-1111-7000-8000-000000000001";
const message = "0192f0c4-3333-7000-8000-000000000003";
const reminder = "0192f0c4-4444-7000-8000-000000000004";
const url = `/chat/${chat}?message=${message}&reminder=${reminder}`;

function api() {
  return {
    setMessageReminder: vi.fn(async () => ({}) as never),
    deleteMessageReminder: vi.fn(async () => undefined),
    updateReminder: vi.fn(async () => ({}) as never),
    deleteReminder: vi.fn(async () => undefined),
  };
}

const apiError = (status: number) =>
  new APIError(status, "reminder_not_found", "gone");

describe("reminder push buttons", () => {
  // Sunday 15 November 2026, 10:41 local time.
  const now = new Date(2026, 10, 15, 10, 41, 20);

  it("finds the reminder in the payload or its address", () => {
    expect(reminderTarget({ url })).toEqual({
      messageID: message,
      reminderID: reminder,
    });
    expect(
      reminderTarget({
        url: "/important?tab=reminders",
        reminder_id: reminder,
      }),
    ).toEqual({ messageID: null, reminderID: reminder });
    expect(reminderTarget({ url: "/important?tab=reminders" })).toBeNull();
    expect(reminderTarget(null)).toBeNull();
  });

  it("turns the three buttons into actions; a tap on the push is none", () => {
    const inHour = reminderAction(reminderActionIDs.inHour, { url }, now);
    expect(inHour).toMatchObject({ kind: "move", messageID: message });
    expect(new Date((inHour as { at: string }).at)).toEqual(
      new Date(2026, 10, 15, 11, 41, 0),
    );
    const tomorrow = reminderAction(reminderActionIDs.tomorrow, { url }, now);
    expect(new Date((tomorrow as { at: string }).at)).toEqual(
      new Date(2026, 10, 16, 9, 0, 0),
    );
    expect(reminderAction(reminderActionIDs.done, { url }, now)).toMatchObject({
      kind: "done",
      messageID: message,
      reminderID: reminder,
    });
    expect(
      reminderAction(
        "expo.modules.notifications.actions.DEFAULT",
        { url },
        now,
      ),
    ).toBeNull();
  });

  it("acts by message, or by id once the message is gone", async () => {
    const client = api();
    const done = reminderAction(reminderActionIDs.done, { url }, now)!;
    expect(await performReminderAction(client, done, now)).toBe("done");
    expect(client.deleteMessageReminder).toHaveBeenCalledWith(message);
    const orphan = reminderAction(
      reminderActionIDs.inHour,
      { reminder_id: reminder },
      now,
    )!;
    expect(await performReminderAction(client, orphan, now)).toBe("done");
    expect(client.updateReminder).toHaveBeenCalledWith(reminder, {
      remind_at: (orphan as { at: string }).at,
    });
  });

  it("keeps an action for later without network and drops a refused one", async () => {
    const offline = api();
    offline.deleteMessageReminder.mockRejectedValue(new TypeError("offline"));
    const done = reminderAction(reminderActionIDs.done, { url }, now)!;
    expect(await performReminderAction(offline, done, now)).toBe("retry");
    const gone = api();
    gone.deleteMessageReminder.mockRejectedValue(apiError(404));
    expect(await performReminderAction(gone, done, now)).toBe("dropped");
    // A move whose time passed while it waited is dropped.
    const move = reminderAction(reminderActionIDs.inHour, { url }, now)!;
    const later = new Date(now.getTime() + 2 * 60 * 60_000);
    expect(await performReminderAction(api(), move, later)).toBe("dropped");
  });

  it("drains in order and stops at the first network failure", async () => {
    const other = "0192f0c4-5555-7000-8000-000000000005";
    const queue: ReminderAction[] = [
      reminderAction(reminderActionIDs.done, { url }, now)!,
      reminderAction(reminderActionIDs.done, { message_id: other }, now)!,
    ];
    const client = api();
    client.deleteMessageReminder.mockRejectedValueOnce(
      new TypeError("offline"),
    );
    const result = await drainReminderActions(client, queue, now);
    expect(result).toEqual({ left: queue, sent: 0 });
    expect(client.deleteMessageReminder).toHaveBeenCalledTimes(1);
    const again = await drainReminderActions(client, result.left, now);
    expect(again).toEqual({ left: [], sent: 2 });
  });

  it("a later button on the same reminder replaces the waiting one", () => {
    const move = reminderAction(reminderActionIDs.inHour, { url }, now)!;
    const done = reminderAction(reminderActionIDs.done, { url }, now)!;
    expect(queueReminderAction([move], done)).toEqual([done]);
  });
});
