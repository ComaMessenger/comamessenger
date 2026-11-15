import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { annaVacation, chats, mockAway, people } from "./awayMock";

// «Отсутствую» (phase 6.7 wave 4): setting a vacation, what colleagues see
// in a direct chat, the hint when mentioning, «Люди» and «Снять».
test.use({ timezoneId: "Europe/Moscow", locale: "ru-RU" });

const isPhone = () => test.info().project.name === "phone";
const shot = { animations: "disabled" as const };

async function openStatus(page: Page) {
  if (isPhone()) {
    await page.goto("/more");
    await page.getByRole("button", { name: /^Статус/ }).click();
  } else {
    await page.goto("/chats");
    await page.getByRole("button", { name: /Анна Иванова/ }).first().click();
    await page.getByRole("menu", { name: "Меню профиля" })
      .getByRole("menuitem")
      .filter({ hasText: /Установить статус…|В отпуске/ })
      .click();
  }
  const dialog = page.getByRole("dialog", { name: "Статус" });
  await expect(dialog).toBeVisible();
  return dialog;
}

for (const theme of ["light", "dark"] as const) {
  test(`Anna sets a vacation with an auto-reply and a substitute, then clears it (${theme})`, async ({
    page,
  }) => {
    const mock = await mockAway(page, { theme, me: "anna" });
    const dialog = await openStatus(page);
    await expect(
      dialog.getByRole("radio", { name: "Отсутствую" }),
    ).toHaveAttribute("aria-checked", "true");
    await expect(
      dialog.getByRole("radio", { name: /В отпуске/ }),
    ).toHaveAttribute("aria-checked", "true");
    await dialog.getByRole("radio", { name: "15 ноября" }).click();
    await dialog.getByRole("button", { name: /Выбрать…/ }).click();
    await page.getByRole("option", { name: /Марина Соколова/ }).click();
    const text = dialog.getByLabel("Текст автоответа");
    await expect(text).toHaveValue(
      "Я в отпуске до 15 ноября. По срочным вопросам — к Марине Соколовой.",
    );
    await expect(
      dialog.getByRole("switch", { name: "Не присылать уведомления" }),
    ).toHaveAttribute("aria-checked", "true");
    await expect(page).toHaveScreenshot(`away-dialog-${theme}.png`, shot);
    if (theme === "light") {
      const axe = await new AxeBuilder({ page })
        .include(".status-dialog")
        .analyze();
      expect(axe.violations).toEqual([]);
    }
    await dialog.getByRole("button", { name: "Сохранить" }).click();
    await expect(dialog).toHaveCount(0);
    const put = mock.calls.find(
      (call) => call.path === "/me/away" && call.method === "PUT",
    );
    expect(put?.body).toMatchObject({
      kind: "vacation",
      ends_at: "2026-11-15T21:00:00.000Z",
      substitute_id: people.marina.actor_id,
      mute_push: true,
      autoreply: {
        enabled: true,
        text: "Я в отпуске до 15 ноября. По срочным вопросам — к Марине Соколовой.",
      },
    });
    expect(put?.body).not.toHaveProperty("starts_at");
    await expect(page.getByText("Статус установлен — его видят коллеги")).toBeVisible();

    // The status is shown where it is set from.
    if (isPhone())
      await expect(
        page.getByRole("button", { name: /Статус 🌴 В отпуске до 15 ноября/ }),
      ).toBeVisible();
    else {
      await page.getByRole("button", { name: /Анна Иванова/ }).first().click();
      await expect(
        page.getByRole("menuitem", { name: /🌴 В отпуске до 15 ноября/ }),
      ).toBeVisible();
      await page.keyboard.press("Escape");
    }

    // «Снять».
    const again = await openStatus(page);
    await expect(again.getByLabel("Текст автоответа")).toHaveValue(
      "Я в отпуске до 15 ноября. По срочным вопросам — к Марине Соколовой.",
    );
    await again.getByRole("button", { name: "Снять" }).click();
    await expect(again).toHaveCount(0);
    expect(
      mock.calls.some(
        (call) => call.path === "/me/away" && call.method === "DELETE",
      ),
    ).toBe(true);
    if (isPhone())
      await expect(
        page.getByRole("button", { name: "Статус Не установлен" }),
      ).toBeVisible();
    else {
      await page.getByRole("button", { name: /Анна Иванова/ }).first().click();
      await expect(
        page.getByRole("menuitem", { name: "Установить статус…" }),
      ).toBeVisible();
    }
  });

  test(`Oleg sees Anna away in their direct chat and gets one auto-reply (${theme})`, async ({
    page,
  }) => {
    const mock = await mockAway(page, {
      theme,
      me: "oleg",
      away: { anna: annaVacation() },
    });
    await page.goto(`/chat/${chats.annaDirect}`);
    await expect(
      page.locator(".conversation-head [data-testid=conversation-status]"),
    ).toHaveText("🌴 в отпуске до 30 ноября");
    await expect(
      page.locator(".conversation-head .ui-avatar__status"),
    ).toHaveText("🌴");
    const slot = page.locator(".chat-slot");
    await expect(slot).toHaveAttribute("data-slot-kind", "away");
    await expect(slot).toContainText("Вместо Анны — Марина Соколова");
    await expect(slot).toContainText("Анна в отпуске до 30 ноября");

    const field = page.locator(".composer textarea");
    await field.fill("Привет! Подменишь в среду в бассейне?");
    await field.press("Enter");
    await expect.poll(() => mock.deliver()).toBe(1);
    const tag = page.locator(".message-feed .auto-reply-tag");
    await expect(tag).toHaveCount(1);
    await expect(tag).toHaveText("Автоответ");
    await expect(
      page.locator(".message--auto-reply").getByText(
        "Я в отпуске до 30 ноября. По срочным вопросам — к Марине Соколовой.",
      ),
    ).toBeVisible();
    await field.fill("Ой, забыл, что ты в отпуске.");
    await field.press("Enter");
    await expect(
      page.locator(".message-feed").getByText("Ой, забыл, что ты в отпуске."),
    ).toBeVisible();
    expect(await mock.deliver()).toBe(0);
    await expect(tag).toHaveCount(1);
    await expect(page).toHaveScreenshot(`away-direct-${theme}.png`, shot);
    if (theme === "light") {
      const axe = await new AxeBuilder({ page })
        .include(".chat-slot-wrap")
        .include(".conversation-head")
        .analyze();
      expect(axe.violations).toEqual([]);
    }

    // The slot opens the direct chat with the substitute.
    await slot.locator(".chat-slot__main").click();
    await expect(page).toHaveURL(new RegExp(`/chat/${chats.marinaDirect}$`));
  });

  test(`mentioning Anna in a group says she is away and offers Marina (${theme})`, async ({
    page,
  }) => {
    await mockAway(page, { theme, me: "oleg", away: { anna: annaVacation() } });
    await page.goto(`/chat/${chats.group}`);
    await expect(
      page.locator(".message-feed").getByText("Кто в среду подменит в бассейне?"),
    ).toBeVisible();
    const field = page.locator(".composer textarea");
    await field.click();
    await field.pressSequentially("@Ан");
    const menu = page.getByRole("menu", { name: "Участники" });
    const anna = menu.getByRole("menuitem", { name: /Анна Иванова/ });
    await expect(anna).toContainText("в отпуске до 30 ноября");
    await anna.click();
    await field.pressSequentially("сможешь в среду?");
    const hint = page.locator(".away-hint");
    await expect(hint).toContainText(
      "Анна в отпуске до 30 ноября — уведомление не придёт",
    );
    await expect(
      hint.getByRole("button", { name: "Упомянуть Марину" }),
    ).toBeVisible();
    await expect(page).toHaveScreenshot(`away-mention-${theme}.png`, shot);
    await hint.getByRole("button", { name: "Упомянуть Марину" }).click();
    await expect(field).toHaveValue("@Анна Иванова сможешь в среду? @Марина Соколова ");
    await field.press("Enter");
    await expect(page.locator(".away-hint")).toHaveCount(0);
    await expect(page.locator(".away-mention-note")).toContainText(
      "Анна в отпуске до 30 ноября — уведомление не придёт · видно только вам",
    );
  });

  test(`«Люди» filter shows who is away (${theme})`, async ({ page }) => {
    const mock = await mockAway(page, {
      theme,
      me: "oleg",
      away: { anna: annaVacation() },
    });
    await page.goto("/members");
    const list = page.locator(".directory-list");
    await expect(list.getByText("Марина Соколова")).toBeVisible();
    await list.getByRole("button", { name: "Отсутствуют" }).click();
    await expect(list.locator(".directory-row--member")).toHaveCount(1);
    const row = list.locator(".directory-row--member").first();
    await expect(row).toContainText("Анна Иванова");
    await expect(row).toContainText("Инструктор ЛФК · в отпуске до 30 ноября");
    await expect(row.locator(".away-note")).toBeVisible();
    await expect(row.locator(".ui-avatar__status")).toHaveText("🌴");
    expect(
      mock.calls.some((call) => call.path === "/actors?presence=away"),
    ).toBe(true);
    if (!isPhone()) {
      await row.click();
      const card = page.locator(".away-card");
      await expect(card).toContainText("В отпуске до 30 ноября");
      await expect(card).toContainText("Марина Соколова");
      await expect(card.getByRole("button", { name: "Написать" })).toBeVisible();
    }
    await expect(page).toHaveScreenshot(`away-people-${theme}.png`, shot);
    await list.getByRole("button", { name: "На месте" }).click();
    await expect(list.locator(".directory-row--member")).toHaveCount(2);
    await expect(list).not.toContainText("Анна Иванова");
  });
}

test("without actor_away the status has no «Отсутствую»", async ({ page }) => {
  await mockAway(page, { me: "anna", features: [] });
  const dialog = await openStatus(page);
  await expect(dialog.getByRole("radio", { name: "Отсутствую" })).toHaveCount(0);
  await expect(dialog.getByLabel("Текст статуса")).toBeVisible();
});
