import { describe, expect, it } from "vitest";
import { declineRuName, firstNameIn } from "./names";

describe("declineRuName", () => {
  it.each([
    ["Анна", "Анны", "Анну", "Анне"],
    ["Ольга", "Ольги", "Ольгу", "Ольге"],
    ["Мария", "Марии", "Марию", "Марии"],
    ["Илья", "Ильи", "Илью", "Илье"],
    ["Никита", "Никиты", "Никиту", "Никите"],
    ["Олег", "Олега", "Олега", "Олегу"],
    ["Сергей", "Сергея", "Сергея", "Сергею"],
    ["Игорь", "Игоря", "Игоря", "Игорю"],
  ])("%s", (name, genitive, accusative, dative) => {
    expect(declineRuName(name, "genitive")).toBe(genitive);
    expect(declineRuName(name, "accusative")).toBe(accusative);
    expect(declineRuName(name, "dative")).toBe(dative);
  });

  it.each([
    [
      "Марина Соколова",
      "Марины Соколовой",
      "Марину Соколову",
      "Марине Соколовой",
    ],
    ["Олег Чернов", "Олега Чернова", "Олега Чернова", "Олегу Чернову"],
    [
      "Дарья Ровинская",
      "Дарьи Ровинской",
      "Дарью Ровинскую",
      "Дарье Ровинской",
    ],
    [
      "Иван Вишневский",
      "Ивана Вишневского",
      "Ивана Вишневского",
      "Ивану Вишневскому",
    ],
    ["Анна Шевчук", "Анны Шевчук", "Анну Шевчук", "Анне Шевчук"],
    ["Пётр Шевчук", "Петра Шевчука", "Петра Шевчука", "Петру Шевчуку"],
    ["Ирина Шевченко", "Ирины Шевченко", "Ирину Шевченко", "Ирине Шевченко"],
  ])("%s", (name, genitive, accusative, dative) => {
    expect(declineRuName(name, "genitive")).toBe(genitive);
    expect(declineRuName(name, "accusative")).toBe(accusative);
    expect(declineRuName(name, "dative")).toBe(dative);
  });

  it("gives up on what it cannot know", () => {
    expect(declineRuName("Marina Sokolova", "dative")).toBeNull();
    expect(declineRuName("Павел", "genitive")).toBe("Павла");
    expect(declineRuName("Михаил Лев", "genitive")).toBeNull();
    expect(declineRuName("Любовь", "genitive")).toBeNull();
    expect(declineRuName("", "genitive")).toBeNull();
    // Саша: the surname tells.
    expect(declineRuName("Саша Петров", "dative")).toBe("Саше Петрову");
  });

  it("keeps the first name as written when unsure", () => {
    expect(firstNameIn("Марина Соколова", "accusative")).toBe("Марину");
    expect(firstNameIn("Мигель Иванов", "accusative")).toBe("Мигель");
    expect(firstNameIn("Anna", "accusative")).toBe("Anna");
  });
});
