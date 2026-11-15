import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { fixtures, ids, mockWorkplace, taskFixtures } from "./workplaceMock";

test.use({ timezoneId: "Europe/Moscow", locale: "ru-RU" });

const isPhone = () => test.info().project.name === "phone";
const shot = { animations: "disabled" as const };

for (const theme of ["light", "dark"] as const) {
  test(`«Важные» opens on «Ждут вас» and answers right in the list (${theme})`, async ({
    page,
  }) => {
    const api = await mockWorkplace(page, { theme });
    await page.goto("/important");
    const tabs = page.getByRole("tablist", { name: "Разделы «Важных»" });
    await expect(tabs.getByRole("tab")).toHaveText([
      /Ждут вас\s*1/,
      "Сохранённые",
      /Напоминания\s*1/,
    ]);
    await expect(tabs.getByRole("tab", { name: /Ждут вас/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    const item = page.getByRole("article", {
      name: "Запрос · Марина Соколова",
    });
    await expect(item).toContainText("Инструкторы · зал · ответить до пт, 18:00");
    await expect(item).toContainText(
      "Планёрка в понедельник в 8:30, большой зал. Будете?",
    );
    await expect(page).toHaveScreenshot(`important-waiting-${theme}.png`, shot);
    if (theme === "light") {
      const axe = await new AxeBuilder({ page }).include(".inbox").analyze();
      expect(axe.violations).toEqual([]);
    }

    await item.getByRole("button", { name: "Не приду" }).click();
    await expect(page.getByRole("heading", { name: "Отвечено" })).toBeVisible();
    await expect(item).toContainText("Ваш ответ: Не приду");
    expect(api.calls.filter((call) => call.method === "PUT")).toEqual([
      {
        method: "PUT",
        path: `/requests/${ids.planning}/answer`,
        body: { option: 1 },
      },
    ]);
    // Nothing waits any more: the counter leaves the tab and the badge.
    await expect(tabs.getByRole("tab", { name: /Ждут вас/ })).toHaveText(
      "Ждут вас",
    );

    await tabs.getByRole("tab", { name: "Сохранённые" }).click();
    await expect(page).toHaveURL(/\/important\?tab=saved$/);
    await expect(page.getByText("Нет важных сообщений")).toBeVisible();
    await item.waitFor({ state: "detached" });
  });
}

test("the chat list marks chats where an answer is awaited", async ({ page }) => {
  test.skip(isPhone(), "the phone list is checked by the chats screen");
  await mockWorkplace(page);
  await page.goto("/chats");
  const row = page.locator(".chat-row", { hasText: "Инструкторы · зал" });
  await expect(row.locator(".chat-row__need")).toHaveText("ответить до пт");
  await expect(
    page.locator(".chat-row", { hasText: "Общий" }).locator(".chat-row__need"),
  ).toHaveCount(0);
  await expect(
    page.getByRole("navigation", { name: "Основная навигация" }).getByRole("button", { name: /Важные/ }),
  ).toContainText("2");
});

const taskFeatures = ["message_requests", "message_reminders", "message_tasks"];
function withTasks() {
  const data = fixtures();
  data.tasks = taskFixtures();
  return data;
}

for (const theme of ["light", "dark"] as const) {
  test(`«Ждут вас» puts requests and tasks in one list and filters «Задачи» (${theme})`, async ({
    page,
  }) => {
    const api = await mockWorkplace(page, {
      theme,
      features: taskFeatures,
      data: withTasks(),
    });
    await page.goto("/important");
    const tabs = page.getByRole("tablist", { name: "Разделы «Важных»" });
    await expect(tabs.getByRole("tab", { name: /Ждут вас/ })).toHaveText(/Ждут вас\s*4/);
    const filters = page.getByRole("group", { name: "Что ждёт" });
    await expect(filters.getByRole("button")).toHaveText([
      /Всё\s*4/,
      /Запросы\s*1/,
      /Задачи\s*3/,
    ]);
    // By due date: the overdue task, today's, Friday's task, the request.
    await expect(page.locator(".inbox > .inbox-task, .inbox > .inbox-card")).toHaveCount(4);
    await expect(page.locator(".inbox-task").first()).toContainText(
      "Сдать журнал инструктажа по технике безопасности",
    );
    await expect(page.locator(".inbox-task").first()).toContainText("вчера, 18:00");

    await filters.getByRole("button", { name: /Задачи/ }).click();
    await expect(page).toHaveURL(/\/important\?tab=waiting&kind=tasks$/);
    await expect(page.getByRole("heading", { level: 2 })).toHaveText([
      "Просрочено · 1",
      "Сегодня · 1",
      "Позже · 1",
      "Готово за 7 дней · 1",
    ]);
    await expect(page).toHaveScreenshot(`important-tasks-${theme}.png`, shot);
    if (theme === "light") {
      const axe = await new AxeBuilder({ page }).include(".inbox").analyze();
      expect(axe.violations).toEqual([]);
    }

    // The round «Готово» closes the task right in the list.
    await page
      .getByRole("checkbox", { name: "Готово: Повесить новое расписание бассейна" })
      .click();
    await expect(page.getByRole("heading", { level: 2 })).toHaveText([
      "Просрочено · 1",
      "Позже · 1",
      "Готово за 7 дней · 2",
    ]);
    expect(api.calls.filter((call) => call.method === "PUT").at(-1)).toMatchObject({
      path: `/tasks/${ids.pool}/status`,
      body: { status: "done" },
    });

    await page.getByRole("radio", { name: "Поставил(а) я" }).click();
    await expect(page).toHaveURL(/kind=tasks&role=authored$/);
    const authored = page.locator(".task-row");
    await expect(authored).toHaveCount(1);
    await expect(authored).toContainText("Забрать ключи от малого зала у охраны");
    await expect(authored).toContainText("Олег Чернов");
    await authored.locator(".task-row__body").click();
    await expect(page).toHaveURL(new RegExp(`/chat/.+\\?message=${ids.keys}`));
  });
}
