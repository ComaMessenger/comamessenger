import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import {
  chatID,
  fixtures,
  ids,
  mockWorkplace,
  taskFixtures,
} from "./workplaceMock";

test.use({ timezoneId: "Europe/Moscow", locale: "ru-RU" });

const shot = { animations: "disabled" as const };
const features = ["message_requests", "message_reminders", "message_tasks"];

/**
 * Pinned messages, open tasks of the chat (none burning on Anna) and her
 * scheduled message in one chat; the request waiting for her is answered.
 */
function calmChat() {
  const data = fixtures();
  data.tasks = taskFixtures().filter(
    (task) => task.id === ids.hall || task.id === ids.keys,
  );
  data.pins = [ids.mats, ids.printouts];
  data.scheduled = [
    {
      id: "00000000-0000-4000-8000-000000000301",
      chat_id: chatID,
      body: "Напоминаю: в пятницу мой слот в большом зале",
      send_at: "2026-11-12T06:00:00Z",
    },
  ];
  const planning = data.requests.find((item) => item.id === ids.planning)!;
  planning.answers[planning.recipients[0]!] = {
    option: 0,
    comment: "",
    answered_at: "2026-11-11T07:00:00Z",
    late: false,
    version: 1,
  };
  return data;
}

async function openChat(page: Page) {
  await page.goto(`/chat/${chatID}`);
  await expect(
    page.locator(".message-feed").getByText("Маты в малом зале разложил."),
  ).toBeVisible();
}

for (const theme of ["light", "dark"] as const) {
  test(`one line under the header: pinned, tasks and scheduled share it (${theme})`, async ({
    page,
  }) => {
    await mockWorkplace(page, { theme, features, data: calmChat() });
    await openChat(page);
    const slot = page.locator(".chat-slot");
    // Pinned comes first while nothing burns on the reader.
    await expect(slot).toHaveAttribute("data-slot-kind", "pinned");
    await expect(slot).toContainText("Закреплённое 1 из 2");
    await expect(slot).toContainText("Маты в малом зале разложил.");
    const chips = slot.getByRole("group", { name: "Что показать под шапкой" });
    await expect(chips.getByRole("button")).toHaveText(["2", "2", "1"]);
    await expect(chips.getByRole("button", { name: "Закреплённое: 2" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    // Anna answers for open tasks here: the dot on the tasks icon.
    await expect(
      chips.getByRole("button", { name: "Задачи: 2" }).locator(".chat-slot__dot"),
    ).toBeVisible();
    await expect(page).toHaveScreenshot(`chat-slot-pinned-${theme}.png`, shot);
    if (theme === "light") {
      const axe = await new AxeBuilder({ page }).include(".chat-slot-wrap").analyze();
      expect(axe.violations).toEqual([]);
    }

    // A tap on the text goes to the pinned message and moves to the next.
    await slot.locator(".chat-slot__main").click();
    await expect(slot).toContainText("Закреплённое 2 из 2");
    await expect(slot).toContainText("Буду, захвачу распечатки расписания.");
    await slot.locator(".chat-slot__main").click();
    await expect(slot).toContainText("Закреплённое 1 из 2");

    await chips.getByRole("button", { name: "Задачи: 2" }).click();
    await expect(slot).toHaveAttribute("data-slot-kind", "tasks");
    await expect(slot).toContainText("Задачи · 2 · на вас 1");
    await expect(slot).toContainText("Подготовить большой зал к слоту в пт, 9:00");
    await expect(page).toHaveScreenshot(`chat-slot-tasks-${theme}.png`, shot);

    await chips.getByRole("button", { name: "Отложено: 1" }).click();
    await expect(slot).toHaveAttribute("data-slot-kind", "scheduled");
    await expect(slot).toContainText("Отложено · завтра, 9:00");
    await slot.locator(".chat-slot__main").click();
    await expect(page).toHaveURL(new RegExp(`/scheduled\\?chat=${chatID}`));
  });
}

test("the chosen kind lasts until the chat is left", async ({ page }) => {
  await mockWorkplace(page, { features, data: calmChat() });
  await openChat(page);
  const slot = page.locator(".chat-slot");
  await slot.getByRole("button", { name: "Отложено: 1" }).click();
  await expect(slot).toHaveAttribute("data-slot-kind", "scheduled");
  await page.goto("/chats");
  await openChat(page);
  await expect(page.locator(".chat-slot")).toHaveAttribute("data-slot-kind", "pinned");
});

test("the slot is gone when the chat has nothing to show", async ({ page }) => {
  const data = fixtures();
  data.requests = [];
  await mockWorkplace(page, { features, data });
  await openChat(page);
  await expect(page.locator(".message-feed").getByText("Буду, захвачу")).toBeVisible();
  await expect(page.locator(".chat-slot")).toHaveCount(0);
});
