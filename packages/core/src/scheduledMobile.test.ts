import { afterAll, describe, expect, it } from "vitest";
import { APIError } from "./api";
import type { ScheduledMessage } from "./types";
import * as scheduled from "./scheduledMobile";

// Every case runs on a Berlin clock: it has a daylight saving change, the
// last Sunday of March forward and of October back.
// Set at load time: describe bodies run before any beforeAll hook.
const previousTZ = process.env.TZ;
process.env.TZ = "Europe/Berlin";
afterAll(() => {
  process.env.TZ = previousTZ;
});

/** A local wall-clock moment in Berlin. */
function local(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
) {
  return new Date(year, month - 1, day, hour, minute, second);
}

function record(
  id: string,
  sendAt: string,
  overrides: Partial<ScheduledMessage> = {},
): ScheduledMessage {
  return {
    id,
    chat_id: "chat-1",
    thread_root_id: null,
    reply_to_id: null,
    client_msg_id: `client-${id}`,
    body: `text ${id}`,
    body_format: "markdown",
    mentioned_actor_ids: [],
    files: [],
    silent: false,
    send_at: sendAt,
    status: "pending",
    failure_reason: null,
    message_id: null,
    version: 1,
    created_at: "2026-11-11T08:00:00Z",
    updated_at: "2026-11-11T08:00:00Z",
    ...overrides,
  };
}

const keys = (now: Date) => scheduled.choices(now).map((choice) => choice.key);

describe("ready-made times", () => {
  it("offers all four on a weekday morning, on the device clock", () => {
    const now = local(2026, 11, 11, 9, 40, 30); // Wednesday
    const result = scheduled.choices(now);
    expect(result.map((choice) => choice.key)).toEqual([
      "inHour",
      "tonight",
      "tomorrow",
      "monday",
    ]);
    const at = Object.fromEntries(result.map((c) => [c.key, c.at]));
    // An hour from now, up to the next whole minute.
    expect(at.inHour).toEqual(local(2026, 11, 11, 10, 41));
    expect(at.tonight).toEqual(local(2026, 11, 11, 18, 0));
    expect(at.tomorrow).toEqual(local(2026, 11, 12, 9, 0));
    expect(at.monday).toEqual(local(2026, 11, 16, 9, 0));
  });

  it("keeps a whole minute as it is", () => {
    const now = local(2026, 11, 11, 9, 40);
    expect(scheduled.choices(now)[0]!.at).toEqual(local(2026, 11, 11, 10, 40));
  });

  it("hides the evening once it has passed or is a moment away", () => {
    expect(keys(local(2026, 11, 11, 17, 58, 59))).toContain("tonight");
    expect(keys(local(2026, 11, 11, 17, 59, 30))).not.toContain("tonight");
    expect(keys(local(2026, 11, 11, 18, 0))).not.toContain("tonight");
    expect(keys(local(2026, 11, 11, 22, 0))).toEqual([
      "inHour",
      "tomorrow",
      "monday",
    ]);
  });

  it("crosses midnight: late in the evening tomorrow is the next date", () => {
    const now = local(2026, 12, 31, 23, 30);
    const at = Object.fromEntries(
      scheduled.choices(now).map((c) => [c.key, c.at]),
    );
    expect(at.inHour).toEqual(local(2027, 1, 1, 0, 30));
    expect(at.tomorrow).toEqual(local(2027, 1, 1, 9, 0));
    // 31 December 2026 is a Thursday.
    expect(at.monday).toEqual(local(2027, 1, 4, 9, 0));
  });

  it("just after midnight tomorrow is the day after, not today", () => {
    const now = local(2026, 11, 12, 0, 5);
    const at = Object.fromEntries(
      scheduled.choices(now).map((c) => [c.key, c.at]),
    );
    expect(at.tomorrow).toEqual(local(2026, 11, 13, 9, 0));
    expect(at.tonight).toEqual(local(2026, 11, 12, 18, 0));
  });

  it("on Monday offers next Monday, on Sunday drops it as the same as tomorrow", () => {
    const monday = local(2026, 11, 16, 8, 0);
    const mondayChoice = scheduled
      .choices(monday)
      .find((c) => c.key === "monday");
    expect(mondayChoice?.at).toEqual(local(2026, 11, 23, 9, 0));
    expect(keys(local(2026, 11, 15, 12, 0))).toEqual([
      "inHour",
      "tonight",
      "tomorrow",
    ]);
  });

  it("keeps 9:00 on the wall clock across the spring change", () => {
    // Saturday 28 March 2026, the clocks go forward at 2:00 on Sunday.
    const now = local(2026, 3, 28, 20, 0);
    const at = Object.fromEntries(
      scheduled.choices(now).map((c) => [c.key, c.at]),
    );
    expect(at.tomorrow!.getHours()).toBe(9);
    expect(at.tomorrow!.toISOString()).toBe("2026-03-29T07:00:00.000Z");
    expect(at.monday!.toISOString()).toBe("2026-03-30T07:00:00.000Z");
  });

  it("an hour ahead is sixty real minutes during the autumn change", () => {
    // 25 October 2026 at 2:30 summer time; at 3:00 the clocks go back to 2:00.
    const now = new Date("2026-10-25T00:30:00Z");
    const inHour = scheduled.choices(now)[0]!;
    expect(inHour.key).toBe("inHour");
    expect(inHour.at.getTime() - now.getTime()).toBe(60 * 60_000);
    expect(
      scheduled
        .choices(now)
        .find((c) => c.key === "tomorrow")!
        .at.toISOString(),
    ).toBe("2026-10-26T08:00:00.000Z");
  });
});

describe("days and validation", () => {
  it("counts calendar days on 23 and 25 hour days", () => {
    expect(
      scheduled.dayDistance(
        local(2026, 3, 30, 0, 30),
        local(2026, 3, 29, 23, 0),
      ),
    ).toBe(1);
    expect(
      scheduled.dayDistance(
        local(2026, 10, 26, 0, 30),
        local(2026, 10, 25, 1, 0),
      ),
    ).toBe(1);
    expect(
      scheduled.dayDistance(
        local(2026, 11, 11, 23, 59),
        local(2026, 11, 11, 0, 0),
      ),
    ).toBe(0);
    expect(
      scheduled.dayDistance(
        local(2026, 11, 10, 23, 59),
        local(2026, 11, 11, 0, 0),
      ),
    ).toBe(-1);
  });

  it("refuses the past, the next few seconds and more than a year ahead", () => {
    const now = local(2026, 11, 11, 9, 0);
    expect(scheduled.sendAtProblem(local(2026, 11, 11, 8, 59), now)).toBe(
      "past",
    );
    expect(scheduled.sendAtProblem(local(2026, 11, 11, 9, 0, 30), now)).toBe(
      "past",
    );
    expect(scheduled.sendAtProblem(local(2026, 11, 11, 9, 1), now)).toBeNull();
    expect(scheduled.sendAtProblem(local(2027, 11, 11, 9, 0), now)).toBeNull();
    expect(scheduled.sendAtProblem(local(2027, 11, 11, 9, 1), now)).toBe(
      "tooFar",
    );
    expect(scheduled.sendAtProblem(new Date(Number.NaN), now)).toBe("past");
  });

  it("combines the picked day with the picked time on the device clock", () => {
    expect(
      scheduled.combine(
        local(2026, 3, 29, 15, 0),
        local(2000, 1, 1, 9, 45, 12),
      ),
    ).toEqual(local(2026, 3, 29, 9, 45));
  });
});

describe("grouping", () => {
  const now = local(2026, 11, 11, 10, 0);

  it("puts failures first, then waiting messages by local day", () => {
    const items = [
      record("c", local(2026, 11, 16, 9).toISOString()),
      record("a", local(2026, 11, 11, 18).toISOString()),
      record("f", local(2026, 11, 10, 9).toISOString(), {
        status: "failed",
        failure_reason: "missed_send_time",
      }),
      record("b", local(2026, 11, 11, 23, 30).toISOString()),
      record("s", local(2026, 11, 11, 9).toISOString(), { status: "sent" }),
      record("d", local(2026, 11, 12, 0, 10).toISOString()),
    ];
    const result = scheduled.sections(items, now);
    expect(
      result.map((section) => [
        section.kind,
        section.kind === "day" ? section.distance : null,
        section.items.map((item) => item.id),
      ]),
    ).toEqual([
      ["failed", null, ["f"]],
      ["day", 0, ["a", "b"]],
      ["day", 1, ["d"]],
      ["day", 5, ["c"]],
    ]);
  });

  it("survives a broken send time instead of throwing", () => {
    const result = scheduled.sections([record("x", "not a date")], now);
    expect(result).toHaveLength(1);
    expect(result[0]!.items[0]!.id).toBe("x");
  });

  it("summarizes a chat for the strip", () => {
    const items = [
      record("a", local(2026, 11, 12, 9).toISOString()),
      record("b", local(2026, 11, 11, 18).toISOString()),
      record("c", local(2026, 11, 11, 12).toISOString(), { chat_id: "chat-2" }),
      record("f", local(2026, 11, 10, 9).toISOString(), { status: "failed" }),
    ];
    expect(scheduled.summary(items, "chat-1")).toEqual({
      count: 3,
      failed: 1,
      nearest: local(2026, 11, 11, 18),
    });
    expect(scheduled.summary(items).count).toBe(4);
    expect(scheduled.summary([], "chat-1")).toEqual({
      count: 0,
      failed: 0,
      nearest: null,
    });
  });
});

describe("failure reasons", () => {
  it("knows every reason of the contract and tolerates new ones", () => {
    for (const reason of scheduled.failureReasons)
      expect(scheduled.failureReason(reason)).toBe(reason);
    expect(scheduled.failureReason("quota_exceeded")).toBe("unknown");
    expect(scheduled.failureReason(null)).toBe("unknown");
    expect(scheduled.failureReasons).toHaveLength(11);
  });
});

describe("realtime events", () => {
  const event = (overrides: Record<string, unknown> = {}) =>
    scheduled.parseEvent({
      id: "a",
      chat_id: "chat-1",
      status: "pending",
      version: 2,
      send_at: "2026-11-12T08:00:00Z",
      failure_reason: null,
      ...overrides,
    })!;

  it("rejects events of an unexpected shape", () => {
    expect(scheduled.parseEvent(null)).toBeNull();
    expect(scheduled.parseEvent({ id: "a" })).toBeNull();
    expect(scheduled.parseEvent({ ...event(), status: "exploded" })).toBeNull();
    expect(scheduled.parseEvent({ ...event(), version: "2" })).toBeNull();
    expect(
      scheduled.parseEvent({ ...event(), failure_reason: "brand_new" })
        ?.failure_reason,
    ).toBe("unknown");
  });

  it("fetches a record it does not know: events carry no text", () => {
    const change = scheduled.applyEvent([], event());
    expect(change).toEqual({ items: [], fetch: ["a"], changed: false });
  });

  it("drops events not newer than the list", () => {
    const items = [record("a", "2026-11-12T08:00:00Z", { version: 3 })];
    expect(scheduled.applyEvent(items, event({ version: 3 })).changed).toBe(
      false,
    );
    expect(
      scheduled.applyEvent(items, event({ version: 2, status: "deleted" }))
        .items,
    ).toHaveLength(1);
  });

  it("removes a sent or deleted record, also deleted on another device", () => {
    const items = [
      record("a", "2026-11-12T08:00:00Z"),
      record("b", "2026-11-13T08:00:00Z"),
    ];
    expect(
      scheduled
        .applyEvent(items, event({ status: "sent" }))
        .items.map((i) => i.id),
    ).toEqual(["b"]);
    expect(
      scheduled
        .applyEvent(items, event({ status: "deleted" }))
        .items.map((i) => i.id),
    ).toEqual(["b"]);
  });

  it("marks a failure at once and keeps the text", () => {
    const items = [record("a", "2026-11-12T08:00:00Z")];
    const change = scheduled.applyEvent(
      items,
      event({ status: "failed", failure_reason: "not_member" }),
    );
    expect(change.fetch).toEqual([]);
    expect(change.items[0]).toMatchObject({
      status: "failed",
      failure_reason: "not_member",
      version: 2,
      body: "text a",
    });
  });

  it("moves an edited record and reads it again for the new text", () => {
    const items = [
      record("a", "2026-11-12T08:00:00Z"),
      record("b", "2026-11-13T08:00:00Z"),
    ];
    const change = scheduled.applyEvent(
      items,
      event({ send_at: "2026-11-14T08:00:00Z" }),
    );
    expect(change.items.map((item) => item.id)).toEqual(["b", "a"]);
    expect(change.fetch).toEqual(["a"]);
  });

  it("merges a fetched record unless the list already has a newer one", () => {
    const items = [record("a", "2026-11-12T08:00:00Z", { version: 4 })];
    expect(
      scheduled.merge(
        items,
        record("a", "2026-11-12T08:00:00Z", { version: 3, body: "old" }),
      )[0]!.body,
    ).toBe("text a");
    expect(
      scheduled.merge(
        items,
        record("a", "2026-11-12T08:00:00Z", { version: 5, body: "new" }),
      )[0]!.body,
    ).toBe("new");
    expect(
      scheduled.merge(
        items,
        record("a", "2026-11-12T08:00:00Z", { version: 5, status: "sent" }),
      ),
    ).toEqual([]);
    expect(
      scheduled.merge([], record("z", "2026-11-12T08:00:00Z")).map((i) => i.id),
    ).toEqual(["z"]);
  });
});

describe("errors", () => {
  it("tells conflicts, closed and deleted records apart", () => {
    const api = (status: number, code: string) =>
      new APIError(status, code as never, "");
    expect(scheduled.errorKind(api(409, "version_conflict"))).toBe("conflict");
    expect(scheduled.errorKind(api(409, "scheduled_message_closed"))).toBe(
      "closed",
    );
    expect(scheduled.errorKind(api(404, "scheduled_message_not_found"))).toBe(
      "gone",
    );
    expect(scheduled.errorKind(api(422, "limit_reached"))).toBe("limit");
    expect(scheduled.errorKind(api(413, "payload_too_large"))).toBe("tooLarge");
    expect(scheduled.errorKind(api(403, "forbidden"))).toBe("forbidden");
    expect(scheduled.errorKind(api(500, "internal"))).toBe("other");
    expect(scheduled.errorKind(new TypeError("Network request failed"))).toBe(
      "network",
    );
  });

  it("reuses an idempotency key only for the same request", () => {
    const base = {
      body: "hi",
      send_at: "2026-11-12T08:00:00Z",
      file_ids: ["f2", "f1"],
    };
    expect(scheduled.requestSignature(base)).toBe(
      scheduled.requestSignature({ ...base, file_ids: ["f1", "f2"] }),
    );
    expect(scheduled.requestSignature(base)).not.toBe(
      scheduled.requestSignature({ ...base, send_at: "2026-11-12T09:00:00Z" }),
    );
    expect(scheduled.requestSignature(base)).not.toBe(
      scheduled.requestSignature({ ...base, silent: true }),
    );
  });
});
