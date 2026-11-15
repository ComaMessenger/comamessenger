import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { ids, mockWorkplace } from "./workplaceMock";

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
