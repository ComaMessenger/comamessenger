import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import {
  chatID,
  ids,
  mockWorkplace,
  now,
  people,
} from "./workplaceMock";

test.use({ timezoneId: "Europe/Moscow", locale: "ru-RU" });

const isPhone = () => test.info().project.name === "phone";
const shot = { animations: "disabled" as const };

async function openChat(page: Page) {
  await page.goto(`/chat/${chatID}`);
  await expect(
    page.locator(".message-feed").getByText("Маты в малом зале разложил."),
  ).toBeVisible();
}

const card = (page: Page, messageID: string) =>
  page.locator(`#message-${messageID} .request-card`);

/** The arrow next to send on desktop, a long press on send on phones. */
async function openSendMenu(page: Page) {
  if (!isPhone()) {
    await page.getByRole("button", { name: "Настройки отправки" }).click();
    return;
  }
  const send = page.getByRole("button", { name: "Отправить", exact: true });
  await send.dispatchEvent("pointerdown", { pointerType: "touch" });
  await expect(
    page.getByRole("menu", { name: "Настройки отправки" }),
  ).toBeVisible();
  await send.dispatchEvent("pointerup", { pointerType: "touch" });
  await send.dispatchEvent("click");
}

for (const theme of ["light", "dark"] as const) {
  test(`the «+» menu groups attachments, «Запрос» and agents (${theme})`, async ({
    page,
  }) => {
    await mockWorkplace(page, { theme });
    await openChat(page);
    await page.getByRole("button", { name: "Добавить", exact: true }).click();
    const menu = page.getByRole("menu", { name: "Добавить" });
    await expect(menu.getByRole("menuitem")).toHaveText([
      "Фото и видео",
      "Файл",
      "Markdown-файл",
      /Запрос\s*Попросить ответ/,
      /Позвать агента/,
    ]);
    await expect(
      menu.getByRole("group", { name: "Попросить и поручить" }),
    ).toBeVisible();
    // Scheduling left «+»: it lives on the send button only.
    await expect(menu.getByText(/Отправить позже|Отложить/)).toHaveCount(0);
    await expect(page).toHaveScreenshot(`plus-menu-${theme}.png`, shot);
    const axe = await new AxeBuilder({ page }).include(".composer-plus").analyze();
    expect(axe.violations).toEqual([]);

    // «Позвать агента» with one agent mentions it right away.
    await menu.getByRole("menuitem", { name: /Позвать агента/ }).click();
    const composer = page.getByRole("textbox", { name: /Напишите сообщение/ });
    await expect(composer).toHaveValue("@Справка ");

    await composer.fill("Привет");
    await openSendMenu(page);
    await expect(
      page.getByRole("menuitem", { name: /Отправить позже/ }),
    ).toBeVisible();
  });
}

test("a request is sent to chosen people with own buttons and a due date", async ({
  page,
}) => {
  const api = await mockWorkplace(page);
  await openChat(page);
  await page.getByRole("button", { name: "Добавить", exact: true }).click();
  await page.getByRole("menuitem", { name: /Запрос/ }).click();
  const dialog = page.getByRole("dialog", { name: "Запрос" });
  await expect(dialog.getByText("Ждём от 3 человек.", { exact: false })).toBeVisible();

  // Nothing written yet: the form says what is missing.
  await dialog.getByRole("button", { name: /Отправить запрос/ }).click();
  await expect(dialog.getByText("Напишите, о чём просите ответить")).toBeVisible();
  await dialog
    .getByRole("textbox", { name: "Вопрос" })
    .fill("Кто сможет провести группу в субботу?");

  await dialog.getByRole("radio", { name: "Люди" }).click();
  await expect(
    dialog.getByText("Выберите, от кого ждёте ответа"),
  ).toBeVisible();
  await dialog.getByRole("button", { name: people.oleg.display_name }).click();
  await dialog.getByRole("button", { name: people.igor.display_name }).click();
  await expect(dialog.getByText(/Ждём от 2 человек/)).toBeVisible();

  await dialog.getByRole("radio", { name: "Свои кнопки" }).click();
  await dialog.getByRole("textbox", { name: "Кнопка 1" }).fill("Утром");
  await dialog.getByRole("textbox", { name: "Кнопка 2" }).fill("утром");
  await expect(dialog.getByText("Кнопка 2 повторяет другую")).toBeVisible();
  await dialog.getByRole("textbox", { name: "Кнопка 2" }).fill("Днём");
  await dialog.getByRole("button", { name: "Кнопка", exact: true }).click();
  await dialog.getByRole("textbox", { name: "Кнопка 3" }).fill("Не смогу");

  await dialog.getByRole("radio", { name: "до пт, 18:00" }).click();
  await expect(
    dialog.getByText("завтра, 18:00. Вам — итог в тот же момент"),
  ).toBeVisible();
  await expect(page).toHaveScreenshot("request-dialog.png", shot);
  const axe = await new AxeBuilder({ page }).include(".request-dialog").analyze();
  expect(axe.violations).toEqual([]);

  await dialog
    .getByRole("button", { name: "Отправить запрос · 2 людям" })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText("Запрос отправлен")).toBeVisible();
  const created = api.calls.find(
    (call) => call.method === "POST" && call.path.endsWith("/requests"),
  );
  expect(created?.body).toMatchObject({
    body: "Кто сможет провести группу в субботу?",
    body_format: "plain",
    audience: {
      kind: "people",
      actor_ids: [people.oleg.actor_id, people.igor.actor_id],
    },
    answer: { preset: "custom", options: ["Утром", "Днём", "Не смогу"] },
    allow_comment: true,
    due_at: "2026-11-13T15:00:00.000Z",
    auto_remind: true,
  });
  const sent = page.locator(".request-card", {
    hasText: "Кто сможет провести группу в субботу?",
  });
  await expect(sent).toContainText("ждём ответа: 2 человека");
  await expect(sent).toContainText("Ответили 0 из 2");
  await expect(sent.getByRole("button", { name: "Напомнить · 2" })).toBeVisible();
});

for (const theme of ["light", "dark"] as const) {
  test(`a recipient answers in the feed, comments and changes the answer (${theme})`, async ({
    page,
  }) => {
    const api = await mockWorkplace(page, { theme });
    await openChat(page);
    const strip = page.getByRole("button", { name: /Ждут вашего ответа/ });
    await expect(strip).toHaveText(/Ждут вашего ответа · до пт, 18:00/);
    await expect(page).toHaveScreenshot(`request-feed-${theme}.png`, shot);

    const planning = card(page, ids.planning);
    await expect(planning).toContainText("ждём ответа: 3 человека");
    await planning.getByRole("button", { name: "Приду", exact: true }).click();
    await expect(planning).toContainText("Ваш ответ: Приду");
    await expect(planning).toContainText(
      "Ответили 2 из 3 · изменить можно до пт, 18:00",
    );
    expect(api.calls.at(-1)).toMatchObject({
      method: "PUT",
      path: `/requests/${ids.planning}/answer`,
      body: { option: 0 },
    });
    // Nothing waits for me any more.
    await expect(strip).toHaveCount(0);

    await planning.getByRole("button", { name: "+ Комментарий" }).click();
    await planning
      .getByRole("textbox", { name: "Комментарий к ответу" })
      .fill("буду к 8:20");
    await planning.getByRole("button", { name: "Сохранить" }).click();
    await expect(planning).toContainText("Ваш комментарий: буду к 8:20");
    expect(api.calls.at(-1)?.body).toEqual({
      option: 0,
      comment: "буду к 8:20",
      expected_version: 1,
    });

    await planning.getByRole("button", { name: "Изменить" }).first().click();
    await planning.getByRole("button", { name: "Не приду" }).click();
    await expect(planning).toContainText("Ваш ответ: Не приду");
    await expect(planning).toContainText("Ваш комментарий: буду к 8:20");
    await planning.scrollIntoViewIfNeeded();
    await expect(planning).toHaveScreenshot(`request-answered-${theme}.png`, shot);
  });
}

test("the observer sees no buttons and the count follows realtime", async ({
  page,
}) => {
  const api = await mockWorkplace(page);
  await openChat(page);
  const journal = card(page, ids.journal);
  await expect(journal).toContainText("Ответа ждут не от вас — кнопок нет");
  await expect(journal).toContainText("Ответили 1 из 2");
  await expect(journal.getByRole("button")).toHaveCount(0);
  await api.emit({
    op: "event",
    seq: 20,
    type: "request.updated",
    occurred_at: now.toISOString(),
    actor_id: people.igor.actor_id,
    chat_id: chatID,
    subject_id: ids.journal,
    data: {
      message_id: ids.journal,
      chat_id: chatID,
      status: "open",
      closed_reason: null,
      answered_count: 2,
      waiting_count: 0,
      version: 3,
    },
  });
  await expect(journal).toContainText("Ответили 2 из 2");
  await api.emit({
    op: "event",
    seq: 21,
    type: "request.updated",
    occurred_at: now.toISOString(),
    actor_id: people.igor.actor_id,
    chat_id: chatID,
    subject_id: ids.journal,
    data: {
      message_id: ids.journal,
      chat_id: chatID,
      status: "closed",
      closed_reason: "author",
      answered_count: 2,
      waiting_count: 0,
      version: 4,
    },
  });
  await expect(journal.locator(".request-pill")).toHaveText("Закрыт");
});

for (const theme of ["light", "dark"] as const) {
  test(`the author reads the answers, reminds and closes (${theme})`, async ({
    page,
  }) => {
    const api = await mockWorkplace(page, { theme });
    await openChat(page);
    const saturday = card(page, ids.saturday);
    await expect(saturday).toContainText("ждём ответа: весь чат · 3");
    await expect(saturday.locator(".request-tally")).toHaveText([
      /Приду\s*1/,
      /Не приду\s*1/,
      /Пока не знаю\s*0/,
      /Нет ответа\s*1/,
    ]);
    await saturday.getByRole("button", { name: "Подробнее" }).click();
    await expect(page).toHaveURL(
      new RegExp(`/chat/${chatID}/requests/${ids.saturday}$`),
    );
    const panel = page.getByRole("complementary", { name: "Ответы" });
    await expect(panel).toContainText("Запрос · весь чат");
    await expect(panel.getByRole("tab", { name: /Нет ответа\s*1/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(panel).toContainText("Игорь Лаптев");
    await expect(panel).toContainText("прочитал(а), не ответил(а)");
    await panel.getByRole("tab", { name: /Не приду/ }).click();
    await expect(panel).toContainText("«дежурю в бассейне»");
    await expect(panel).toHaveScreenshot(`request-answers-${theme}.png`, shot);

    await panel
      .getByRole("button", { name: "Напомнить не ответившим · 1" })
      .click();
    await expect(page.getByText("Напомнили 1 человеку")).toBeVisible();
    await expect(
      panel.getByRole("button", { name: "Напомнили · снова можно сегодня, 12:15" }),
    ).toBeDisabled();
    expect(
      api.calls.some(
        (call) =>
          call.method === "POST" &&
          call.path === `/requests/${ids.saturday}/remind`,
      ),
    ).toBe(true);

    await panel.getByRole("button", { name: "Закрыть", exact: true }).click();
    const confirm = page.getByRole("dialog", { name: "Закрыть запрос?" });
    await confirm.getByRole("button", { name: "Закрыть", exact: true }).click();
    await expect(panel.locator(".request-pill")).toHaveText("Закрыт");
    await expect(saturday.locator(".request-pill")).toHaveText("Закрыт");
    await expect(saturday.getByRole("button", { name: /Напомнить/ })).toHaveCount(0);
  });
}

test("an older server keeps the menus as they were", async ({ page }) => {
  await mockWorkplace(page, { features: [] });
  await openChat(page);
  await page.getByRole("button", { name: "Добавить", exact: true }).click();
  const menu = page.getByRole("menu", { name: "Добавить" });
  await expect(menu.getByRole("menuitem", { name: /Запрос/ })).toHaveCount(0);
  await expect(menu.getByRole("menuitem", { name: /Позвать агента/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: /Ждут вашего ответа/ })).toHaveCount(0);
  await page.goto("/important");
  await expect(page.getByRole("tablist", { name: "Разделы «Важных»" })).toHaveCount(0);
});
