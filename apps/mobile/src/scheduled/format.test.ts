import { afterAll, describe, expect, it } from "vitest";
import { formatDate, formatDay, formatSectionDay, formatTime } from "./format";

const previousTZ = process.env.TZ;
process.env.TZ = "Europe/Moscow";
afterAll(() => {
  process.env.TZ = previousTZ;
});

const ru = { locale: "ru", hour12: false };
const en12 = { locale: "en", hour12: true };
const words = { today: "сегодня", tomorrow: "завтра" };
const now = new Date(2026, 10, 11, 9, 40); // Wednesday 11 November

describe("scheduled time formatting", () => {
  it("follows the device clock: 24 or 12 hours", () => {
    const at = new Date(2026, 10, 12, 18, 5);
    expect(formatTime(at, ru)).toBe("18:05");
    expect(formatTime(at, en12)).toMatch(/^6:05\sPM$/);
  });

  it("names today and tomorrow, otherwise the date, with a year only when it differs", () => {
    expect(formatDay(new Date(2026, 10, 11, 23, 59), now, ru, words)).toBe(
      "сегодня",
    );
    expect(formatDay(new Date(2026, 10, 12, 0, 0), now, ru, words)).toBe(
      "завтра",
    );
    expect(formatDay(new Date(2026, 10, 16, 9), now, ru, words)).toBe(
      "16 ноября",
    );
    expect(formatDate(new Date(2027, 0, 4, 9), now, ru)).toMatch(
      /^4 января 2027/,
    );
  });

  it("capitalizes day headings of the list", () => {
    expect(formatSectionDay(new Date(2026, 10, 12), now, ru, words)).toBe(
      "Завтра",
    );
    expect(formatSectionDay(new Date(2026, 10, 16), now, ru, words)).toBe(
      "Понедельник, 16 ноября",
    );
  });
});
