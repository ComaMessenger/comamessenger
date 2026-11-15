import { afterAll, describe, expect, it } from "vitest";
import { APIError } from "./api";
import {
  avatarBadge,
  awayDraftFromStatus,
  awayDraftProblem,
  awayEndOfDay,
  awayErrorKind,
  awayHeaderText,
  awayKeys,
  awayLine,
  awayNotificationsText,
  awayPickerHint,
  awayPresenceFilters,
  awayPresenceParam,
  awayPresets,
  awaySlot,
  awayTitle,
  currentAway,
  defaultAutoreply,
  emptyAwayDraft,
  isAutoReply,
  isAwayActive,
  isAwayPlanned,
  matchesAwayPresence,
  mentionAwayHint,
  nextAwayChange,
  parseAwayEvent,
  personAwayCaption,
  reduceSubstituting,
  substitutingLine,
  toSetAwayInput,
  visibleSubstitute,
  withAwayKind,
  withDefaultAutoreply,
  type AwayEvent,
  type AwayPerson,
} from "./away";
import { makeAway } from "./pollFixtures";
import type { AwayStatus, DurableEvent } from "./types";

const previousTZ = process.env.TZ;
process.env.TZ = "Europe/Berlin";
afterAll(() => {
  process.env.TZ = previousTZ;
});

// Tuesday 17 November 2026, 10:00 in Berlin.
const now = new Date("2026-11-17T09:00:00Z");
const berlin = (value: string) => new Date(value); // local time strings

const anna: AwayPerson = {
  actor_id: "anna",
  display_name: "Анна Иванова",
  type: "user",
  away: makeAway(),
};
const marina = {
  actor_id: "marina",
  display_name: "Марина Соколова",
  type: "user" as const,
};

describe("is it in effect", () => {
  it("checks the clock, not the flag", () => {
    expect(isAwayActive(makeAway({ active: false }), now)).toBe(true);
    const planned = makeAway({
      starts_at: "2026-11-20T00:00:00+01:00",
      active: true,
    });
    expect(isAwayActive(planned, now)).toBe(false);
    expect(isAwayPlanned(planned, now)).toBe(true);
    const over = makeAway({ ends_at: "2026-11-17T08:00:00Z" });
    expect(isAwayActive(over, now)).toBe(false);
    expect(nextAwayChange(planned, now)).toEqual(
      new Date("2026-11-19T23:00:00Z"),
    );
    expect(isAwayActive(null, now)).toBe(false);
  });

  it("reads timestamps with nanoseconds (the phone's engine)", () => {
    expect(
      isAwayActive(
        makeAway({ starts_at: "2026-11-17T08:59:59.123456789Z" }),
        now,
      ),
    ).toBe(true);
  });
});

describe("awayLine", () => {
  it("says until when, by kind", () => {
    // A vacation of whole days ends at local midnight after 30 November.
    expect(awayLine(makeAway(), now, "ru")).toBe("в отпуске до 30 ноября");
    expect(awayTitle(makeAway(), now, "ru")).toBe("В отпуске до 30 ноября");
    expect(awayLine(makeAway(), now, "en")).toBe("on vacation until Nov 30");
    const appointment = makeAway({
      kind: "appointment",
      ends_at: "2026-11-17T13:00:00Z",
    });
    expect(awayLine(appointment, now, "ru")).toBe("на приёме до 14:00");
    expect(awayHeaderText(appointment, now, "ru")).toBe(
      "🩺 на приёме до 14:00",
    );
    const endOfDay = makeAway({
      kind: "trip",
      ends_at: "2026-11-17T23:00:00Z",
    });
    expect(awayLine(endOfDay, now, "ru")).toBe("на выезде до конца дня");
    const tomorrow = makeAway({ kind: "dnd", ends_at: "2026-11-18T08:00:00Z" });
    expect(awayLine(tomorrow, now, "ru")).toBe("не беспокоить до завтра, 9:00");
    const other = makeAway({
      kind: "other",
      label: "Нет на месте",
      ends_at: "2026-11-17T13:00:00Z",
    });
    expect(awayLine(other, now, "ru")).toBe("нет на месте до 14:00");
  });

  it("names the period of a planned one and nothing once over", () => {
    const planned = makeAway({
      starts_at: "2026-11-19T23:00:00Z",
      ends_at: "2026-11-30T23:00:00Z",
    });
    expect(awayLine(planned, now, "ru")).toBe("с 20 по 30 ноября — в отпуске");
    const across = makeAway({
      starts_at: "2026-11-27T23:00:00Z",
      ends_at: "2026-12-03T23:00:00Z",
    });
    expect(awayLine(across, now, "ru")).toBe(
      "с 28 ноября по 3 декабря — в отпуске",
    );
    expect(
      awayLine(makeAway({ ends_at: "2026-11-17T08:00:00Z" }), now, "ru"),
    ).toBe("");
  });
});

describe("awayPresets", () => {
  const labels = (kind: Parameters<typeof awayPresets>[0], at = now) =>
    awayPresets(kind, at).map((preset) => preset.label);

  it("offers the chips of decision 3", () => {
    expect(labels("appointment")).toEqual(["14:00", "16:00", "конец дня"]);
    expect(labels("trip")).toEqual(["13:00", "18:00", "завтра"]);
    expect(labels("dnd")).toEqual(["1 час", "18:00", "завтра 9:00"]);
    // Tuesday: the coming Sunday and two weeks.
    expect(labels("vacation")).toEqual(["22 ноября", "30 ноября"]);
  });

  it("ends a day at local midnight and «завтра 9:00» at 9:00", () => {
    const [, , endOfDay] = awayPresets("appointment", now);
    expect(endOfDay!.at).toEqual(berlin("2026-11-18T00:00:00"));
    const [, , tomorrow9] = awayPresets("dnd", now);
    expect(tomorrow9!.at).toEqual(berlin("2026-11-18T09:00:00"));
    const [, , tomorrow] = awayPresets("trip", now);
    expect(tomorrow!.at).toEqual(berlin("2026-11-19T00:00:00"));
  });

  it("leaves out times that passed", () => {
    const evening = new Date("2026-11-17T16:30:00Z"); // 17:30
    expect(labels("appointment", evening)).toEqual(["конец дня"]);
    expect(labels("trip", evening)).toEqual(["18:00", "завтра"]);
  });

  it("counts from a planned start", () => {
    const start = berlin("2026-11-20T00:00:00");
    const presets = awayPresets("appointment", now, { startsAt: start });
    expect(presets[0]!.at).toEqual(berlin("2026-11-20T14:00:00"));
  });

  it("keeps local hours across a daylight saving change", () => {
    // Saturday 24 October 2026, 20:00; summer time ends on Sunday 25.
    const saturday = new Date("2026-10-24T18:00:00Z");
    const tomorrow9 = awayPresets("dnd", saturday).find(
      (preset) => preset.id === "tomorrow9",
    );
    // 9:00 winter time on Sunday is 8:00 UTC.
    expect(tomorrow9!.at.toISOString()).toBe("2026-10-25T08:00:00.000Z");
    const vacation = awayPresets("vacation", saturday);
    // The coming Sunday ends at Monday 0:00 winter time.
    expect(vacation[0]!.at.toISOString()).toBe("2026-10-25T23:00:00.000Z");
    expect(vacation[0]!.label).toBe("25 октября");
    expect(awayEndOfDay(berlin("2026-03-29T12:00:00")).toISOString()).toBe(
      "2026-03-29T22:00:00.000Z",
    );
  });
});

describe("the form", () => {
  it("starts with the kind's switches", () => {
    const vacation = emptyAwayDraft(now);
    expect([vacation.autoreplyEnabled, vacation.mutePush]).toEqual([
      true,
      true,
    ]);
    expect(vacation.endsPreset).toBe("weekEnd");
    const appointment = withAwayKind(vacation, "appointment", now);
    expect([appointment.autoreplyEnabled, appointment.mutePush]).toEqual([
      false,
      false,
    ]);
    expect(appointment.endsPreset).toBe("at14");
    const trip = withAwayKind(vacation, "trip", now);
    expect([trip.autoreplyEnabled, trip.mutePush]).toEqual([true, false]);
    const dnd = withAwayKind(vacation, "dnd", now);
    expect([dnd.autoreplyEnabled, dnd.mutePush]).toEqual([false, true]);
  });

  it("names the first problem", () => {
    const base = { ...emptyAwayDraft(now), autoreplyText: "Я в отпуске." };
    expect(awayDraftProblem({ ...base, kind: "other" }, now)).toEqual({
      field: "label",
      reason: "empty",
    });
    expect(
      awayDraftProblem({ ...base, kind: "other", label: "л".repeat(41) }, now),
    ).toEqual({ field: "label", reason: "tooLong" });
    expect(awayDraftProblem({ ...base, endsAt: null }, now)).toEqual({
      field: "endsAt",
      reason: "empty",
    });
    expect(
      awayDraftProblem({ ...base, endsAt: new Date(now.getTime() - 1) }, now),
    ).toEqual({ field: "endsAt", reason: "beforeStart" });
    expect(
      awayDraftProblem(
        { ...base, endsAt: new Date(now.getTime() + 181 * 86_400_000) },
        now,
      ),
    ).toEqual({ field: "endsAt", reason: "tooLong" });
    expect(
      awayDraftProblem(
        {
          ...base,
          startsAt: new Date(now.getTime() + 366 * 86_400_000),
          endsAt: new Date(now.getTime() + 367 * 86_400_000),
        },
        now,
      ),
    ).toEqual({ field: "startsAt", reason: "tooFar" });
    expect(awayDraftProblem({ ...base, autoreplyText: " " }, now)).toEqual({
      field: "autoreply",
      reason: "empty",
    });
    expect(
      awayDraftProblem({ ...base, substituteID: "me" }, now, "me"),
    ).toEqual({ field: "substitute", reason: "self" });
    expect(awayDraftProblem(base, now, "me")).toBeNull();
  });

  it("sends «с» only when it is ahead", () => {
    const draft = {
      ...emptyAwayDraft(now, "other"),
      label: " Нет на месте ",
      autoreplyText: " текст ",
      substituteID: "marina",
    };
    const input = toSetAwayInput(draft, now);
    expect(input).toMatchObject({
      kind: "other",
      label: "Нет на месте",
      autoreply: { enabled: false, text: "текст" },
      substitute_id: "marina",
      mute_push: false,
    });
    expect("starts_at" in input).toBe(false);
    expect("expected_version" in input).toBe(false);
    const planned = toSetAwayInput(
      { ...draft, startsAt: berlin("2026-11-20T00:00:00"), expectedVersion: 3 },
      now,
    );
    expect(planned.starts_at).toBe("2026-11-19T23:00:00.000Z");
    expect(planned.expected_version).toBe(3);
    expect("label" in toSetAwayInput(emptyAwayDraft(now), now)).toBe(false);
  });

  it("opens on a saved status", () => {
    const status: AwayStatus = {
      ...makeAway({ substitute_id: "marina" }),
      autoreply: { enabled: true, text: "Я в отпуске" },
      mute_push: true,
      version: 4,
    };
    expect(awayDraftFromStatus(status)).toMatchObject({
      kind: "vacation",
      autoreplyEnabled: true,
      autoreplyEdited: true,
      substituteID: "marina",
      mutePush: true,
      expectedVersion: 4,
    });
  });
});

describe("defaultAutoreply", () => {
  const ends = new Date("2026-11-30T23:00:00Z");

  it("says until when and whom to write", () => {
    expect(
      defaultAutoreply(
        { kind: "vacation", endsAt: ends, substitute: "Марина Соколова" },
        now,
        "ru",
      ),
    ).toBe(
      "Я в отпуске до 30 ноября. По срочным вопросам — к Марине Соколовой.",
    );
    expect(
      defaultAutoreply({ kind: "vacation", endsAt: ends }, now, "ru"),
    ).toBe("Я в отпуске до 30 ноября, отвечу после возвращения.");
    expect(
      defaultAutoreply(
        { kind: "trip", endsAt: new Date("2026-11-17T12:00:00Z") },
        now,
        "ru",
      ),
    ).toBe("Я на выезде до 13:00, отвечу после.");
    expect(
      defaultAutoreply(
        { kind: "vacation", endsAt: ends, substitute: "Marina Sokolova" },
        now,
        "ru",
      ),
    ).toBe(
      "Я в отпуске до 30 ноября. По срочным вопросам пишите: Marina Sokolova.",
    );
    expect(
      defaultAutoreply(
        { kind: "vacation", endsAt: ends, substitute: "Marina Sokolova" },
        now,
        "en",
      ),
    ).toBe(
      "I'm on vacation until Nov 30. For urgent questions, contact Marina Sokolova.",
    );
  });

  it("counts «до» from a planned start", () => {
    expect(
      defaultAutoreply(
        {
          kind: "appointment",
          startsAt: berlin("2026-11-20T10:00:00"),
          endsAt: berlin("2026-11-20T14:00:00"),
        },
        now,
        "ru",
      ),
    ).toBe("Я на приёме до 14:00, отвечу после.");
  });

  it("follows the fields until the person types their own", () => {
    const draft = emptyAwayDraft(now);
    const filled = withDefaultAutoreply(draft, "Марина Соколова", now, "ru");
    expect(filled.autoreplyText).toContain("к Марине Соколовой");
    const typed = { ...filled, autoreplyText: "Свой", autoreplyEdited: true };
    expect(withDefaultAutoreply(typed, null, now, "ru")).toBe(typed);
  });
});

describe("what colleagues see", () => {
  const lookup = (id: string) => (id === "marina" ? marina : null);

  it("shows the substitute unless they are away or gone", () => {
    const away = makeAway({ substitute_id: "marina" });
    expect(visibleSubstitute(away, lookup, now)).toBe(marina);
    expect(
      visibleSubstitute(away, () => ({ ...marina, away: makeAway() }), now),
    ).toBeNull();
    expect(
      visibleSubstitute(away, () => ({ ...marina, deactivated: true }), now),
    ).toBeNull();
    expect(visibleSubstitute(makeAway(), lookup, now)).toBeNull();
  });

  it("puts the kind on the avatar instead of the green dot", () => {
    expect(avatarBadge("online", makeAway(), now)).toEqual({
      kind: "away",
      awayKind: "vacation",
      emoji: "🌴",
    });
    expect(avatarBadge("online", null, now)).toEqual({ kind: "online" });
    expect(avatarBadge("offline", null, now)).toBeNull();
  });

  it("builds the slot line of a direct chat", () => {
    expect(awaySlot(anna, marina, now, "ru")).toEqual({
      title: "Вместо Анны — Марина Соколова",
      caption: "Анна в отпуске до 30 ноября",
      emoji: "🌴",
      substituteID: "marina",
    });
    expect(awaySlot(anna, null, now, "ru")).toMatchObject({
      title: "Анна в отпуске до 30 ноября",
      substituteID: null,
    });
    expect(
      awaySlot({ ...anna, display_name: "Anna" }, marina, now, "ru")!.title,
    ).toBe("Замещает: Марина Соколова");
    expect(awaySlot({ ...anna, away: null }, marina, now, "ru")).toBeNull();
    expect(awaySlot({ ...anna, type: "agent" }, null, now, "ru")).toBeNull();
  });

  it("gives the three texts of the mention hint", () => {
    expect(mentionAwayHint(anna, null, now, "ru")).toMatchObject({
      text: "Анна в отпуске до 30 ноября — ответит позже",
      notificationsOff: false,
      substitute: null,
    });
    const muted = { ...anna, away: makeAway({ notifications_off: true }) };
    expect(mentionAwayHint(muted, null, now, "ru")!.text).toBe(
      "Анна в отпуске до 30 ноября — уведомление не придёт",
    );
    expect(mentionAwayHint(anna, marina, now, "ru")!.substitute).toEqual({
      actorID: "marina",
      name: "Марина Соколова",
      label: "Упомянуть Марину",
    });
    const dnd = {
      ...anna,
      away: makeAway({ kind: "dnd", ends_at: "2026-11-17T17:00:00Z" }),
    };
    expect(mentionAwayHint(dnd, null, now, "ru")!.text).toBe(
      "Анна просит не беспокоить до 18:00 — ответит позже",
    );
    expect(mentionAwayHint(anna, marina, now, "en")).toMatchObject({
      text: "Анна is on vacation until Nov 30 — will reply later",
      substitute: { label: "Mention Марина" },
    });
    expect(
      mentionAwayHint({ ...anna, away: null }, null, now, "ru"),
    ).toBeNull();
  });

  it("hints in pickers without redirecting anything", () => {
    expect(awayPickerHint(anna, marina, now, "ru")).toEqual({
      text: "в отпуске до 30 ноября · замещает Марина",
      choose: { actorID: "marina", label: "Выбрать Марину" },
    });
    expect(
      awayPickerHint({ ...anna, away: null }, marina, now, "ru"),
    ).toBeNull();
  });

  it("says whom the reader substitutes and that push is off", () => {
    expect(
      substitutingLine({ away: makeAway() }, "Анна Иванова", now, "ru"),
    ).toBe("Вы замещаете Анну до 30 ноября");
    expect(
      substitutingLine(
        {
          away: makeAway({
            starts_at: "2026-11-19T23:00:00Z",
            ends_at: "2026-11-30T23:00:00Z",
          }),
        },
        "Анна Иванова",
        now,
        "ru",
      ),
    ).toBe("Вы замещаете Анну с 20 по 30 ноября");
    expect(
      awayNotificationsText(makeAway({ notifications_off: true }), now, "ru"),
    ).toBe("выкл. до 30 ноября");
    expect(awayNotificationsText(makeAway(), now, "ru")).toBeNull();
  });

  it("marks auto-replies", () => {
    expect(isAutoReply({ auto_reply: true })).toBe(true);
    expect(isAutoReply({})).toBe(false);
  });
});

describe("«Люди»", () => {
  it("offers the filters only with actor_away", () => {
    expect(awayPresenceFilters(["actor_away"])).toEqual([
      "all",
      "here",
      "away",
    ]);
    expect(awayPresenceFilters([])).toEqual([]);
    expect(awayPresenceParam("all")).toBeUndefined();
    expect(awayPresenceParam("away")).toBe("away");
  });

  it("filters a loaded list and writes the caption", () => {
    expect(matchesAwayPresence(anna, "away", now)).toBe(true);
    expect(matchesAwayPresence(anna, "here", now)).toBe(false);
    expect(matchesAwayPresence(marina, "here", now)).toBe(true);
    expect(matchesAwayPresence({ type: "agent" }, "here", now)).toBe(false);
    expect(
      personAwayCaption({ title: "инструктор", away: makeAway() }, now, "ru"),
    ).toEqual({ text: "инструктор · в отпуске до 30 ноября", away: true });
    expect(personAwayCaption({ title: "инструктор" }, now, "ru")).toEqual({
      text: "инструктор",
      away: false,
    });
  });
});

describe("realtime", () => {
  const raw = (type: string, data: Record<string, unknown>): DurableEvent => ({
    op: "event",
    seq: 1,
    type,
    occurred_at: "2026-11-17T09:00:00Z",
    actor_id: null,
    subject_id: "anna",
    data,
  });

  it("parses the events and never keeps private fields", () => {
    const parsed = parseAwayEvent(
      raw("actor.away.updated", {
        actor_id: "anna",
        away: { ...makeAway(), autoreply_text: "секрет", mute_push: true },
      }),
    );
    expect(parsed?.type).toBe("actor.away.updated");
    expect(Object.keys(parsed!.data.away as object).sort()).toEqual(
      [
        "active",
        "ends_at",
        "kind",
        "label",
        "notifications_off",
        "starts_at",
        "substitute_id",
      ].sort(),
    );
    expect(
      parseAwayEvent(
        raw("actor.away.updated", { actor_id: "anna", away: null }),
      ),
    ).toEqual({
      type: "actor.away.updated",
      data: { actor_id: "anna", away: null },
    });
    expect(
      parseAwayEvent(raw("actor.away.updated", { actor_id: "anna", away: 1 })),
    ).toBeNull();
  });

  it("prefers an event over the page", () => {
    expect(currentAway("anna", makeAway(), { anna: null })).toBeNull();
    expect(currentAway("anna", makeAway(), {})).toEqual(makeAway());
  });

  it("keeps «Вы замещаете …» current", () => {
    const items = [{ actor_id: "anna", away: makeAway() }];
    const assigned = parseAwayEvent(
      raw("away.substitute.assigned", {
        actor_id: "anna",
        starts_at: "2026-11-17T00:00:00Z",
        ends_at: "2026-12-05T00:00:00Z",
      }),
    ) as AwayEvent;
    expect(reduceSubstituting(items, assigned).items[0]!.away.ends_at).toBe(
      "2026-12-05T00:00:00Z",
    );
    const fresh = parseAwayEvent(
      raw("away.substitute.assigned", {
        actor_id: "oleg",
        starts_at: "2026-11-17T00:00:00Z",
        ends_at: "2026-12-05T00:00:00Z",
      }),
    ) as AwayEvent;
    expect(reduceSubstituting(items, fresh).stale).toBe(true);
    const removed = parseAwayEvent(
      raw("away.substitute.removed", { actor_id: "anna" }),
    ) as AwayEvent;
    expect(reduceSubstituting(items, removed).items).toEqual([]);
  });
});

describe("keys and errors", () => {
  it("maps the server's codes", () => {
    expect(
      awayErrorKind(new APIError(422, "away_substitute_invalid", "")),
    ).toBe("substituteInvalid");
    expect(awayErrorKind(new APIError(409, "away_version_conflict", ""))).toBe(
      "conflict",
    );
    expect(awayErrorKind(new TypeError("offline"))).toBe("network");
    expect(awayKeys.people("u1", "away")).toEqual([
      "away",
      "u1",
      "people",
      "away",
    ]);
  });
});
