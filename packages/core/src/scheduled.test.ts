import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { APIError } from "./api";
import {
  failureReasonKey,
  needsAuthorCheck,
  notRetryableReason,
  parseScheduledEvent,
  scheduledErrorKind,
  scheduleProblem,
  scheduleRequestSignature,
  fromLocalInputValue,
  groupScheduled,
  isSchedulable,
  pendingCount,
  pendingSummary,
  reduceScheduled,
  scheduledFailureReasons,
  schedulePresets,
  toLocalInputValue,
  upsertScheduled,
} from "./scheduled";
import type { ScheduledMessage } from "./types";

// Every expectation below is in Berlin time: it has a daylight saving change
// on 29 March 2026 (02:00 → 03:00) and 25 October 2026 (03:00 → 02:00).
const previousTZ = process.env.TZ;
beforeAll(() => {
  process.env.TZ = "Europe/Berlin";
});
afterAll(() => {
  process.env.TZ = previousTZ;
});

const local = (value: string) => fromLocalInputValue(value)!;
const presets = (now: string) =>
  Object.fromEntries(
    schedulePresets(local(now)).map((preset) => [
      preset.id,
      toLocalInputValue(preset.at),
    ]),
  );

describe("schedulePresets", () => {
  it("offers every time on a weekday morning", () => {
    // Wednesday 11 November 2026, 10:15.
    expect(presets("2026-11-11T10:15")).toEqual({
      inHour: "2026-11-11T11:15",
      thisEvening: "2026-11-11T18:00",
      tomorrowMorning: "2026-11-12T09:00",
      nextMonday: "2026-11-16T09:00",
    });
  });

  it("hides the evening once it is less than a minute away or past", () => {
    expect(presets("2026-11-11T17:59")).toHaveProperty("thisEvening");
    const halfMinuteBefore = new Date(
      local("2026-11-11T17:59").getTime() + 30_000,
    );
    expect(
      schedulePresets(halfMinuteBefore).map((preset) => preset.id),
    ).not.toContain("thisEvening");
    expect(presets("2026-11-11T18:00")).not.toHaveProperty("thisEvening");
    expect(presets("2026-11-11T23:30")).not.toHaveProperty("thisEvening");
  });

  it("on Sunday evening, Monday is tomorrow and offered once", () => {
    const sunday = presets("2026-11-15T20:00");
    expect(sunday.tomorrowMorning).toBe("2026-11-16T09:00");
    expect(sunday).not.toHaveProperty("nextMonday");
  });

  it("on Monday, Monday means next week", () => {
    expect(presets("2026-11-16T08:00").nextMonday).toBe("2026-11-23T09:00");
  });

  it("keeps wall-clock times across daylight saving changes", () => {
    // Saturday before spring forward: tomorrow 9:00 is 23 hours later.
    const spring = schedulePresets(local("2026-03-28T10:00"));
    const tomorrow = spring.find((item) => item.id === "tomorrowMorning")!;
    expect(toLocalInputValue(tomorrow.at)).toBe("2026-03-29T09:00");
    expect(tomorrow.at.toISOString()).toBe("2026-03-29T07:00:00.000Z");
    // In an hour is an hour of real time, even across the jump.
    const night = schedulePresets(new Date("2026-03-29T00:30:00Z"));
    expect(night.find((item) => item.id === "inHour")!.at.toISOString()).toBe(
      "2026-03-29T01:30:00.000Z",
    );
    // Autumn: Monday 9:00 after the clocks go back is still 9:00.
    const autumn = presets("2026-10-24T12:00");
    expect(autumn.tomorrowMorning).toBe("2026-10-25T09:00");
    expect(autumn.nextMonday).toBe("2026-10-26T09:00");
    expect(local(autumn.tomorrowMorning!).toISOString()).toBe(
      "2026-10-25T08:00:00.000Z",
    );
  });

  it("refuses times the server would refuse", () => {
    const now = local("2026-11-11T10:00");
    expect(isSchedulable(local("2026-11-11T10:00"), now)).toBe(false);
    expect(isSchedulable(new Date(now.getTime() + 59_000), now)).toBe(false);
    expect(isSchedulable(new Date(now.getTime() + 60_000), now)).toBe(true);
    expect(isSchedulable(local("2027-11-12T10:00"), now)).toBe(false);
    expect(isSchedulable(new Date(Number.NaN), now)).toBe(false);
  });
});

describe("local input values", () => {
  it("round-trips and rejects impossible times", () => {
    expect(toLocalInputValue(local("2026-01-02T03:04"))).toBe(
      "2026-01-02T03:04",
    );
    expect(fromLocalInputValue("2026-02-31T10:00")).toBeNull();
    // 02:30 does not exist in Berlin on 29 March 2026.
    expect(fromLocalInputValue("2026-03-29T02:30")).toBeNull();
    expect(fromLocalInputValue("tomorrow")).toBeNull();
  });
});

let sequence = 0;
function record(patch: Partial<ScheduledMessage> = {}): ScheduledMessage {
  sequence += 1;
  return {
    id: `s${sequence}`,
    chat_id: "c1",
    thread_root_id: null,
    reply_to_id: null,
    client_msg_id: `k${sequence}`,
    body: "hello",
    body_format: "markdown",
    mentioned_actor_ids: [],
    files: [],
    silent: false,
    send_at: "2026-11-12T08:00:00Z",
    status: "pending",
    failure_reason: null,
    message_id: null,
    version: 1,
    created_at: "2026-11-11T08:00:00Z",
    updated_at: "2026-11-11T08:00:00Z",
    sent_at: null,
    failed_at: null,
    ...patch,
  };
}

describe("groupScheduled", () => {
  it("puts failures first and pending ones by local day", () => {
    const now = local("2026-11-11T23:30");
    const lateToday = record({
      send_at: local("2026-11-11T23:50").toISOString(),
    });
    // 00:30 Berlin is still the 11th in UTC: grouping follows local time.
    const earlyTomorrow = record({
      send_at: local("2026-11-12T00:30").toISOString(),
    });
    const tomorrowMorning = record({
      send_at: local("2026-11-12T09:00").toISOString(),
    });
    const later = record({ send_at: local("2026-11-20T09:00").toISOString() });
    const oldFailure = record({
      status: "failed",
      failure_reason: "missed_send_time",
      failed_at: "2026-11-10T08:00:00Z",
    });
    const newFailure = record({
      status: "failed",
      failure_reason: "security_reset",
      failed_at: "2026-11-11T08:00:00Z",
    });
    const groups = groupScheduled(
      [
        later,
        oldFailure,
        tomorrowMorning,
        lateToday,
        newFailure,
        earlyTomorrow,
      ],
      now,
    );
    expect(groups.failed.map((item) => item.id)).toEqual([
      newFailure.id,
      oldFailure.id,
    ]);
    expect(
      groups.days.map((day) => [day.key, day.kind, day.items.map((i) => i.id)]),
    ).toEqual([
      ["2026-11-11", "today", [lateToday.id]],
      ["2026-11-12", "tomorrow", [earlyTomorrow.id, tomorrowMorning.id]],
      ["2026-11-20", "later", [later.id]],
    ]);
  });
});

describe("summaries", () => {
  it("counts pending messages of the chat and finds the next", () => {
    const items = [
      record({ send_at: "2026-11-13T08:00:00Z" }),
      record({ send_at: "2026-11-12T08:00:00Z" }),
      record({ chat_id: "c2", send_at: "2026-11-11T09:00:00Z" }),
      record({ status: "failed", failure_reason: "forbidden" }),
    ];
    const summary = pendingSummary(items, "c1");
    expect(summary.count).toBe(2);
    expect(summary.next?.id).toBe(items[1]!.id);
    expect(pendingSummary(items, "c3")).toEqual({ count: 0, next: null });
    expect(pendingCount(items)).toBe(3);
  });
});

describe("failureReasonKey", () => {
  it("has a key for every reason and a fallback", () => {
    const keys = scheduledFailureReasons.map(failureReasonKey);
    expect(scheduledFailureReasons).toHaveLength(11);
    expect(new Set(keys).size).toBe(11);
    expect(failureReasonKey("security_reset")).toBe(
      "scheduledReasonSecurityReset",
    );
    expect(failureReasonKey("something_new")).toBe("scheduledReasonUnknown");
    expect(failureReasonKey(null)).toBe("scheduledReasonUnknown");
  });
});

describe("reduceScheduled", () => {
  const event = (item: ScheduledMessage, patch: Record<string, unknown>) =>
    ({
      id: item.id,
      chat_id: item.chat_id,
      status: item.status,
      version: item.version,
      send_at: item.send_at,
      failure_reason: item.failure_reason,
      ...patch,
    }) as Parameters<typeof reduceScheduled>[2];

  it("asks to read a record it does not know", () => {
    const item = record();
    const result = reduceScheduled(
      [],
      "scheduled_message.created",
      event(item, {}),
    );
    expect(result).toMatchObject({
      refetch: item.id,
      changed: false,
      items: [],
    });
  });

  it("ignores events older than the list", () => {
    const item = record({ version: 3 });
    const result = reduceScheduled(
      [item],
      "scheduled_message.updated",
      event(item, { version: 2, send_at: "2026-12-01T00:00:00Z" }),
    );
    expect(result).toMatchObject({ refetch: null, changed: false });
    expect(result.items[0]).toBe(item);
  });

  it("applies status at once and reads the content again", () => {
    const item = record();
    const result = reduceScheduled(
      [item],
      "scheduled_message.failed",
      event(item, {
        version: 2,
        status: "failed",
        failure_reason: "not_member",
      }),
    );
    expect(result.refetch).toBe(item.id);
    expect(result.items[0]).toMatchObject({
      status: "failed",
      failure_reason: "not_member",
      // The version moves with the record read again, not with the event.
      version: 1,
      body: "hello",
    });
  });

  it("removes sent and deleted records, even at the same version", () => {
    const item = record({ version: 4 });
    expect(
      reduceScheduled(
        [item],
        "scheduled_message.deleted",
        event(item, { status: "deleted" }),
      ).items,
    ).toEqual([]);
    expect(
      reduceScheduled(
        [item],
        "scheduled_message.sent",
        event(item, { status: "sent", version: 5 }),
      ).items,
    ).toEqual([]);
    expect(
      reduceScheduled(
        [],
        "scheduled_message.deleted",
        event(item, { status: "deleted" }),
      ).changed,
    ).toBe(false);
  });

  it("upserts fresh records without going back in time", () => {
    const item = record({ version: 2 });
    expect(
      upsertScheduled([item], { ...item, version: 1, body: "old" })[0]!.body,
    ).toBe("hello");
    expect(
      upsertScheduled([item], { ...item, version: 3, body: "new" })[0]!.body,
    ).toBe("new");
    expect(
      upsertScheduled([item], { ...item, version: 3, status: "sent" }),
    ).toEqual([]);
    expect(upsertScheduled([], item)).toEqual([item]);
  });
});

describe("notRetryableReason", () => {
  it("reads the reason of a refused retry", () => {
    expect(
      notRetryableReason(
        new APIError(409, "scheduled_message_not_retryable", "no", {
          reason: "not_member",
        }),
      ),
    ).toBe("not_member");
    expect(
      notRetryableReason(new APIError(409, "version_conflict", "no")),
    ).toBeNull();
    expect(notRetryableReason(new Error("offline"))).toBeNull();
  });
});

describe("needsAuthorCheck", () => {
  it("asks to check messages stopped by a security event only", () => {
    const failed = (failure_reason: string) =>
      ({ status: "failed", failure_reason }) as Pick<
        ScheduledMessage,
        "status" | "failure_reason"
      >;
    expect(needsAuthorCheck(failed("security_reset"))).toBe(true);
    expect(needsAuthorCheck(failed("session_revoked"))).toBe(true);
    for (const reason of scheduledFailureReasons.filter(
      (item) => item !== "security_reset" && item !== "session_revoked",
    ))
      expect(needsAuthorCheck(failed(reason)), reason).toBe(false);
    expect(
      needsAuthorCheck({ status: "pending", failure_reason: "security_reset" }),
    ).toBe(false);
  });
});

describe("scheduleProblem", () => {
  it("tells the past from too far ahead", () => {
    const now = local("2026-11-11T09:00");
    expect(scheduleProblem(local("2026-11-11T08:59"), now)).toBe("past");
    expect(scheduleProblem(new Date(now.getTime() + 30_000), now)).toBe("past");
    expect(scheduleProblem(local("2026-11-11T09:01"), now)).toBeNull();
    expect(scheduleProblem(local("2027-11-11T09:00"), now)).toBeNull();
    expect(scheduleProblem(local("2027-11-11T09:01"), now)).toBe("tooFar");
    expect(scheduleProblem(new Date(Number.NaN), now)).toBe("past");
  });

  it("crosses the year: late on 31 December tomorrow is 1 January", () => {
    const at = presets("2026-12-31T23:30");
    expect(at.inHour).toBe("2027-01-01T00:30");
    expect(at.tomorrowMorning).toBe("2027-01-01T09:00");
    // 31 December 2026 is a Thursday.
    expect(at.nextMonday).toBe("2027-01-04T09:00");
  });
});

describe("parseScheduledEvent", () => {
  const data = {
    id: "a",
    chat_id: "chat-1",
    status: "pending",
    version: 2,
    send_at: "2026-11-12T08:00:00Z",
    failure_reason: null,
  };

  it("accepts the contract shape", () => {
    expect(parseScheduledEvent(data)).toEqual(data);
  });

  it("rejects events of an unexpected shape", () => {
    expect(parseScheduledEvent(null)).toBeNull();
    expect(parseScheduledEvent({ id: "a" })).toBeNull();
    expect(parseScheduledEvent({ ...data, status: "exploded" })).toBeNull();
    expect(parseScheduledEvent({ ...data, version: "2" })).toBeNull();
  });

  it("keeps a reason it does not know, worded as unknown", () => {
    const event = parseScheduledEvent({
      ...data,
      status: "failed",
      failure_reason: "brand_new",
    })!;
    expect(event.failure_reason).toBe("brand_new");
    expect(failureReasonKey(event.failure_reason)).toBe(
      "scheduledReasonUnknown",
    );
  });
});

describe("scheduledErrorKind", () => {
  it("tells conflicts, closed, deleted and not retryable apart", () => {
    const api = (status: number, code: string) =>
      new APIError(status, code as never, "");
    expect(scheduledErrorKind(api(409, "version_conflict"))).toBe("conflict");
    expect(scheduledErrorKind(api(409, "scheduled_message_closed"))).toBe(
      "closed",
    );
    expect(scheduledErrorKind(api(404, "scheduled_message_not_found"))).toBe(
      "gone",
    );
    expect(
      scheduledErrorKind(api(409, "scheduled_message_not_retryable")),
    ).toBe("notRetryable");
    expect(scheduledErrorKind(api(422, "limit_reached"))).toBe("limit");
    expect(scheduledErrorKind(api(413, "payload_too_large"))).toBe("tooLarge");
    expect(scheduledErrorKind(api(403, "forbidden"))).toBe("forbidden");
    expect(scheduledErrorKind(api(500, "internal"))).toBe("other");
    expect(scheduledErrorKind(new TypeError("Network request failed"))).toBe(
      "network",
    );
  });
});

describe("scheduleRequestSignature", () => {
  it("reuses an idempotency key only for the same request", () => {
    const base = {
      body: "hi",
      send_at: "2026-11-12T08:00:00Z",
      file_ids: ["f2", "f1"],
    };
    expect(scheduleRequestSignature(base)).toBe(
      scheduleRequestSignature({ ...base, file_ids: ["f1", "f2"] }),
    );
    expect(scheduleRequestSignature(base)).not.toBe(
      scheduleRequestSignature({ ...base, send_at: "2026-11-12T09:00:00Z" }),
    );
    expect(scheduleRequestSignature(base)).not.toBe(
      scheduleRequestSignature({ ...base, silent: true }),
    );
  });
});
