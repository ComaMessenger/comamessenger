import { afterAll, describe, expect, it } from "vitest";
import {
  customStatusExpiresAt,
  customStatusPresets,
  customStatusProblem,
  liveCustomStatus,
  myStatusSummary,
  shownStatus,
  statusSheetSections,
  toSetStatusInput,
} from "./customStatus";
import { makeAway } from "./pollFixtures";

const previousTZ = process.env.TZ;
process.env.TZ = "Europe/Berlin";
afterAll(() => {
  process.env.TZ = previousTZ;
});

const now = new Date("2026-11-17T09:00:00Z");

describe("the custom status", () => {
  it("ends when chosen, as the web dialog does", () => {
    expect(customStatusExpiresAt("none", now)).toBeNull();
    expect(customStatusExpiresAt("hour", now)?.toISOString()).toBe(
      "2026-11-17T10:00:00.000Z",
    );
    expect(customStatusExpiresAt("today", now)?.toISOString()).toBe(
      "2026-11-17T22:59:00.000Z",
    );
    expect(customStatusExpiresAt("week", now)?.toISOString()).toBe(
      "2026-11-24T09:00:00.000Z",
    );
    expect(customStatusPresets.map((preset) => preset.emoji)).toEqual([
      "📅",
      "🏠",
      "🤒",
      "🏝",
    ]);
  });

  it("checks the text and builds the body", () => {
    expect(
      customStatusProblem({ emoji: "", text: "т".repeat(101), expiry: "none" }),
    ).toEqual({ field: "text", reason: "tooLong" });
    expect(
      toSetStatusInput({ emoji: "🏠", text: " Из дома ", expiry: "hour" }, now),
    ).toEqual({
      emoji: "🏠",
      text: "Из дома",
      expires_at: "2026-11-17T10:00:00.000Z",
    });
  });

  it("drops an expired status", () => {
    expect(
      liveCustomStatus(
        {
          status_emoji: "🏠",
          status_text: "Из дома",
          status_expires_at: "2026-11-17T08:00:00Z",
        },
        now,
      ),
    ).toBeNull();
    expect(
      liveCustomStatus({ status_emoji: "", status_text: "" }, now),
    ).toBeNull();
  });
});

describe("away over the custom status (decision 12)", () => {
  const user = {
    status_emoji: "🏠",
    status_text: "Из дома",
    status_expires_at: null,
  };

  it("shows the away status while it is in effect, once", () => {
    expect(shownStatus({ ...user, away: makeAway() }, now, "ru")).toEqual({
      emoji: "🌴",
      text: "В отпуске до 30 ноября",
      away: true,
    });
    expect(shownStatus(user, now, "ru")).toEqual({
      emoji: "🏠",
      text: "Из дома",
      away: false,
    });
  });

  it("sums up the «Статус» row of «Ещё»", () => {
    expect(myStatusSummary({ ...user, away: makeAway() }, now, "ru")).toEqual({
      kind: "away",
      emoji: "🌴",
      text: "В отпуске до 30 ноября",
    });
    const planned = makeAway({
      starts_at: "2026-11-19T23:00:00Z",
      ends_at: "2026-11-30T23:00:00Z",
    });
    expect(myStatusSummary({ ...user, away: planned }, now, "ru")).toEqual({
      kind: "planned",
      emoji: "🌴",
      text: "С 20 по 30 ноября — в отпуске",
      custom: { emoji: "🏠", text: "Из дома" },
    });
    expect(myStatusSummary(user, now, "ru").kind).toBe("custom");
    expect(myStatusSummary({}, now, "ru")).toEqual({ kind: "none" });
  });

  it("offers «Отсутствую» only with actor_away", () => {
    expect(statusSheetSections(true)).toEqual(["away", "custom"]);
    expect(statusSheetSections(false)).toEqual(["custom"]);
  });
});
