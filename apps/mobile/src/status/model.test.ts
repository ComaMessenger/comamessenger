import { describe, expect, it } from "vitest";
import { lastEmoji, shortName, substituteChips } from "./model";

const peer = (id: string, name: string, type: "user" | "agent" = "user") => ({
  actor_id: id,
  display_name: name,
  type,
});

describe("«Вместо меня»", () => {
  const chats = [
    { kind: "direct" as const, direct_peer: peer("oleg", "Олег Чернов"), last_activity_seq: 5 },
    { kind: "group" as const, direct_peer: null, last_activity_seq: 9 },
    { kind: "direct" as const, direct_peer: peer("bot", "Помощник", "agent"), last_activity_seq: 8 },
    { kind: "direct" as const, direct_peer: peer("marina", "Марина Соколова"), last_activity_seq: 7 },
    { kind: "direct" as const, direct_peer: peer("me", "Анна Иванова"), last_activity_seq: 6 },
    { kind: "direct" as const, direct_peer: peer("igor", "Игорь Лаптев"), last_activity_seq: 1 },
  ] as never[];

  it("offers the people of the latest direct chats, not agents or oneself", () => {
    expect(
      substituteChips(chats, { selfID: "me", chosen: null }).map(
        (chip) => chip.actorID,
      ),
    ).toEqual(["marina", "oleg"]);
  });

  it("puts the chosen substitute first and keeps two more", () => {
    expect(
      substituteChips(chats, {
        selfID: "me",
        chosen: { actorID: "igor", name: "Игорь Лаптев" },
      }).map((chip) => chip.actorID),
    ).toEqual(["igor", "marina", "oleg"]);
    expect(
      substituteChips(chats, {
        selfID: "me",
        chosen: { actorID: "marina", name: "Марина Соколова" },
      }).map((chip) => chip.actorID),
    ).toEqual(["marina", "oleg", "igor"]);
  });

  it("writes a chip as in the prototype: «Марина С.»", () => {
    expect(shortName("Марина Соколова")).toBe("Марина С.");
    expect(shortName("Марина")).toBe("Марина");
    expect(shortName("  Олег   Иванович  Чернов ")).toBe("Олег Ч.");
    expect(shortName("")).toBe("");
  });
});

describe("«Свой эмодзи»", () => {
  it("takes the last emoji typed, flags and joined ones whole", () => {
    expect(lastEmoji("🌴")).toBe("🌴");
    expect(lastEmoji("a🙂b🎧")).toBe("🎧");
    expect(lastEmoji("🇷🇺")).toBe("🇷🇺");
    expect(lastEmoji("👩‍💻")).toBe("👩‍💻");
    expect(lastEmoji("текст")).toBe("");
  });
});
