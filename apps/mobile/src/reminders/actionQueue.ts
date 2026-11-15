import {
  APIError,
  reminderInput,
  reminderPresets,
  type MessengerAPI,
} from "@comamessenger/core";

/**
 * The buttons of a «Напомнить мне» push: «Через час», «Завтра, 9:00» and
 * «Готово». They work without opening the app; when the server cannot be
 * reached (no network, the app was closed) the action waits in a queue and
 * goes on the next start. Free of native modules, unit-tested.
 */

export const reminderCategory = "coma.reminder";

export const reminderActionIDs = {
  inHour: "reminder-in-hour",
  tomorrow: "reminder-tomorrow",
  done: "reminder-done",
} as const;

export type ReminderActionID =
  (typeof reminderActionIDs)[keyof typeof reminderActionIDs];

/** Which reminder a push is about: by message, or by id once the message is gone. */
export type ReminderTarget = {
  messageID: string | null;
  reminderID: string | null;
};

export type ReminderAction = ReminderTarget &
  ({ kind: "move"; at: string } | { kind: "done" }) & {
    /** When the button was pressed; a queued move to a past time is dropped. */
    pressedAt: string;
  };

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The reminder a push points at: `message_id` / `reminder_id` of the
 * payload, else the `?message=&reminder=` of its address.
 */
export function reminderTarget(data: unknown): ReminderTarget | null {
  if (!data || typeof data !== "object") return null;
  const value = data as Record<string, unknown>;
  const id = (field: unknown) =>
    typeof field === "string" && uuid.test(field) ? field : null;
  let messageID = id(value.message_id);
  let reminderID = id(value.reminder_id);
  if (typeof value.url === "string") {
    const query = value.url.split("?")[1] ?? "";
    for (const part of query.split("&")) {
      const [name, raw] = part.split("=");
      if (name === "message") messageID ??= id(raw);
      if (name === "reminder") reminderID ??= id(raw);
    }
  }
  return messageID || reminderID ? { messageID, reminderID } : null;
}

/** The action of a pressed button, or null for a tap on the push itself. */
export function reminderAction(
  actionID: string,
  data: unknown,
  now: Date,
): ReminderAction | null {
  const target = reminderTarget(data);
  if (!target) return null;
  const pressedAt = now.toISOString();
  switch (actionID) {
    case reminderActionIDs.inHour: {
      const at = new Date(now.getTime() + 60 * 60_000);
      at.setSeconds(0, 0);
      return { ...target, kind: "move", at: at.toISOString(), pressedAt };
    }
    case reminderActionIDs.tomorrow: {
      const at = reminderPresets(now).find(
        (preset) => preset.id === "tomorrowMorning",
      )?.at;
      if (!at) return null;
      return { ...target, kind: "move", at: at.toISOString(), pressedAt };
    }
    case reminderActionIDs.done:
      return { ...target, kind: "done", pressedAt };
  }
  return null;
}

type API = Pick<
  MessengerAPI,
  | "setMessageReminder"
  | "deleteMessageReminder"
  | "updateReminder"
  | "deleteReminder"
>;

export type ActionOutcome = "done" | "retry" | "dropped";

/**
 * Sends one action. The network failing keeps it for later; the server
 * refusing it (the reminder is gone, the time passed) drops it.
 */
export async function performReminderAction(
  api: API,
  action: ReminderAction,
  now: Date,
): Promise<ActionOutcome> {
  if (action.kind === "move" && Date.parse(action.at) <= now.getTime() + 60_000)
    return "dropped";
  try {
    if (action.kind === "done") {
      if (action.messageID) await api.deleteMessageReminder(action.messageID);
      else if (action.reminderID) await api.deleteReminder(action.reminderID);
    } else {
      const input = reminderInput(new Date(action.at));
      if (action.messageID)
        await api.setMessageReminder(action.messageID, input);
      else if (action.reminderID)
        await api.updateReminder(action.reminderID, input);
    }
    return "done";
  } catch (error) {
    if (error instanceof APIError && error.status < 500 && error.status !== 429)
      return error.status === 401 ? "retry" : "dropped";
    return "retry";
  }
}

/**
 * Sends the queue in order and returns what is left: actions after a
 * network failure wait for the next try. A later action on the same
 * reminder replaces an earlier one still waiting.
 */
export async function drainReminderActions(
  api: API,
  queue: readonly ReminderAction[],
  now: Date,
): Promise<{ left: ReminderAction[]; sent: number }> {
  const left: ReminderAction[] = [];
  let sent = 0;
  let offline = false;
  for (const action of queue) {
    if (offline) {
      left.push(action);
      continue;
    }
    const outcome = await performReminderAction(api, action, now);
    if (outcome === "retry") {
      offline = true;
      left.push(action);
    } else if (outcome === "done") sent += 1;
  }
  return { left, sent };
}

const sameTarget = (left: ReminderTarget, right: ReminderTarget) =>
  (left.messageID !== null && left.messageID === right.messageID) ||
  (left.reminderID !== null && left.reminderID === right.reminderID);

/** Adds an action, replacing a waiting one for the same reminder. */
export function queueReminderAction(
  queue: readonly ReminderAction[],
  action: ReminderAction,
): ReminderAction[] {
  return [...queue.filter((item) => !sameTarget(item, action)), action];
}
