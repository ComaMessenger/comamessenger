import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import {
  chatID,
  fixtures,
  ids,
  mockWorkplace,
  people,
  taskFixtures,
} from "./workplaceMock";

test.use({ timezoneId: "Europe/Moscow", locale: "ru-RU" });

const isPhone = () => test.info().project.name === "phone";
const shot = { animations: "disabled" as const };
const features = ["message_requests", "message_reminders", "message_tasks"];

function withTasks() {
  const data = fixtures();
  data.tasks = taskFixtures();
  return data;
}

async function openChat(page: Page) {
  await page.goto(`/chat/${chatID}`);
  await expect(
    page.locator(".message-feed").getByText("Маты в малом зале разложил."),
  ).toBeVisible();
}

const taskCard = (page: Page, messageID: string) =>
  page.locator(`#message-${messageID} .task-card`);

async function messageMenu(page: Page, messageID: string) {
  const row = page.locator(`#message-${messageID}`);
  await row.scrollIntoViewIfNeeded();
  await row.hover();
  await row.getByRole("button", { name: "Действия с сообщением" }).click();
  return page.getByRole("menu", { name: "Действия с сообщением" });
}

for (const theme of ["light", "dark"] as const) {
  test(`cards in the feed, the slot burns on the reader and unfolds the list (${theme})`, async ({
    page,
  }) => {
    await mockWorkplace(page, { theme, features, data: withTasks() });
    await openChat(page);
    const slot = page.locator(".chat-slot");
    await expect(slot).toHaveAttribute("data-slot-kind", "hot");
    await expect(slot).toContainText("На вас · сегодня, 12:00");
    await expect(slot).toContainText("Повесить новое расписание бассейна");
    await expect(
      slot.getByRole("checkbox", {
        name: "Готово: Повесить новое расписание бассейна",
      }),
    ).toBeVisible();

    const hall = taskCard(page, ids.hall);
    await hall.scrollIntoViewIfNeeded();
    await expect(hall).toContainText("Задача · 1 из 3");
    await expect(hall).toContainText("Открыта");
    await expect(hall).toContainText("Вы · отвечает");
    await expect(hall).toContainText("Слот Олега, после — группа на растяжку.");
    await expect(hall.getByRole("checkbox")).toHaveCount(3);
    await expect(page).toHaveScreenshot(`task-feed-${theme}.png`, shot);
    if (theme === "light") {
      const axe = await new AxeBuilder({ page })
        .include(".chat-slot-wrap")
        .include(`#message-${ids.hall}`)
        .analyze();
      expect(axe.violations).toEqual([]);
    }

    await slot.locator(".chat-slot__main").click();
    const list = page.getByRole("dialog", { name: "Задачи чата" });
    await expect(list.getByRole("heading")).toHaveText([
      "На вас · 2",
      "Остальные · 1",
    ]);
    await expect(list.locator(".task-row")).toHaveCount(3);
    await expect(list.locator(".task-row--mine")).toHaveCount(2);
    await expect(page).toHaveScreenshot(`task-drop-${theme}.png`, shot);
    // A row leads to its card in the feed.
    await list.getByText("Забрать ключи от малого зала у охраны").click();
    await expect(list).toHaveCount(0);
    await expect(taskCard(page, ids.keys)).toBeInViewport();
  });

  test(`the author creates a task with items on two people (${theme})`, async ({
    page,
  }) => {
    const api = await mockWorkplace(page, { theme, features, data: withTasks() });
    await openChat(page);
    await page.getByRole("button", { name: "Добавить", exact: true }).click();
    const menu = page.getByRole("menu", { name: "Добавить" });
    await expect(menu.getByRole("menuitem")).toHaveText([
      "Фото и видео",
      "Файл",
      "Markdown-файл",
      /Запрос\s*Попросить ответ/,
      /Задача\s*Поручить: ответственный, срок, чек-лист/,
      /Позвать агента/,
    ]);
    await menu.getByRole("menuitem", { name: /Задача/ }).click();

    const dialog = page.getByRole("dialog", { name: "Новая задача" });
    await dialog.getByLabel("Что сделать").fill("Проверить аптечку в большом зале");
    await dialog.getByLabel("Описание — необязательно").fill("Докупить бинты.");
    await dialog.getByRole("radio", { name: /Олег Чернов/ }).click();
    await dialog.getByRole("radio", { name: "завтра, 12:00" }).click();
    await dialog.getByRole("button", { name: "Пункт", exact: true }).click();
    await dialog.getByLabel("Пункт 1", { exact: true }).fill("Пересчитать бинты");
    await dialog.getByRole("button", { name: "Исполнитель пункта" }).click();
    await page.getByRole("option", { name: /Марина Соколова/ }).click();
    await dialog.getByRole("button", { name: "Пункт", exact: true }).click();
    await dialog.getByLabel("Пункт 2", { exact: true }).fill("Купить в аптеке");
    await dialog
      .getByRole("button", { name: "Исполнитель пункта", exact: true })
      .click();
    await page.getByRole("option", { name: /Игорь Лаптев/ }).click();
    await expect(dialog.getByText("Напомним завтра, 11:00")).toBeVisible();
    await expect(page).toHaveScreenshot(`task-dialog-${theme}.png`, shot);
    await dialog.getByRole("button", { name: "Создать задачу" }).click();

    await expect(dialog).toHaveCount(0);
    const created = api.calls.find(
      (call) => call.method === "POST" && call.path === `/chats/${chatID}/tasks`,
    );
    expect(created?.body).toMatchObject({
      title: "Проверить аптечку в большом зале",
      description: "Докупить бинты.",
      assignee: { kind: "person", actor_id: people.oleg.actor_id },
      due_at: "2026-11-12T09:00:00.000Z",
      remind_before_due: true,
      items: [
        { text: "Пересчитать бинты", assignee_id: people.marina.actor_id },
        { text: "Купить в аптеке", assignee_id: people.igor.actor_id },
      ],
    });
    const card = page.locator(".task-card", {
      hasText: "Проверить аптечку в большом зале",
    });
    await expect(card).toContainText("Олег Чернов · отвечает");
    await expect(card).toContainText("Задача · 0 из 2");
    await expect(card.getByRole("button", { name: "Напомнить ответственному" })).toBeVisible();
    await expect(page.getByText("Задача создана — ответственный получит уведомление")).toBeVisible();
  });
}

test("the responsible person starts, ticks an item and closes it", async ({ page }) => {
  const api = await mockWorkplace(page, { features, data: withTasks() });
  await openChat(page);
  const hall = taskCard(page, ids.hall);
  await hall.scrollIntoViewIfNeeded();
  await hall.getByRole("button", { name: "Взять в работу" }).click();
  await expect(hall).toContainText("В работе");
  await hall
    .getByRole("checkbox", { name: "Достать инвентарь из кладовой" })
    .click();
  await expect(hall).toContainText("Задача · 2 из 3");
  await hall.getByRole("button", { name: "Готово", exact: true }).click();
  await expect(hall.locator(".task-card__title--closed")).toBeVisible();
  await expect(hall).toContainText("Готово · Вы, 10:15");
  await expect(hall.getByRole("button", { name: "Вернуть в работу" })).toBeVisible();
  expect(
    api.calls
      .filter(
        (call) => call.method !== "GET" && call.path.startsWith(`/tasks/${ids.hall}`),
      )
      .map((call) => [call.method, call.path, call.body]),
  ).toEqual([
    ["PUT", `/tasks/${ids.hall}/status`, { status: "in_progress", expected_version: 3 }],
    ["PATCH", `/tasks/${ids.hall}/items/${"00000000-0000-4000-8000-000000000102"}`, { done: true }],
    ["PUT", `/tasks/${ids.hall}/status`, { status: "done", expected_version: 5 }],
  ]);

  // «Готово» right in the slot closes the burning one.
  const slot = page.locator(".chat-slot");
  await slot
    .getByRole("checkbox", { name: "Готово: Повесить новое расписание бассейна" })
    .click();
  // Nothing burns any more: the waiting request comes first.
  await expect(slot).toHaveAttribute("data-slot-kind", "requests");
  await expect(slot.getByRole("button", { name: "Задачи: 1" })).toBeVisible();
  await expect(slot.getByRole("button", { name: /Горит на вас/ })).toHaveCount(0);
  expect(
    api.calls.filter((call) => call.method !== "GET").at(-1),
  ).toMatchObject({
    method: "PUT",
    path: `/tasks/${ids.pool}/status`,
    body: { status: "done" },
  });
});

test("the author sees «Готово» live and reminds the responsible person", async ({ page }) => {
  const api = await mockWorkplace(page, {
    features,
    data: withTasks(),
    me: "marina",
  });
  await openChat(page);
  const hall = taskCard(page, ids.hall);
  await hall.scrollIntoViewIfNeeded();
  await expect(hall).toContainText("Анна Иванова · отвечает");
  await hall.getByRole("button", { name: "Напомнить ответственному" }).click();
  await expect(hall).toContainText("Напомнили · снова можно сегодня, 12:15");
  expect(api.calls.filter((call) => call.method !== "GET").at(-1)).toMatchObject({
    method: "POST",
    path: `/tasks/${ids.hall}/nudge`,
  });

  // Anna closes it on her device: task.updated reaches the author.
  const record = api.data.tasks.find((item) => item.id === ids.hall)!;
  record.status = "done";
  record.status_changed_at = "2026-11-11T07:20:00Z";
  record.status_changed_by = people.anna.actor_id;
  record.version = 10;
  await api.emit({
    op: "event",
    seq: 50,
    type: "task.updated",
    occurred_at: "2026-11-11T07:20:00Z",
    actor_id: people.anna.actor_id,
    chat_id: chatID,
    subject_id: ids.hall,
    data: {
      message_id: ids.hall,
      chat_id: chatID,
      task: api.taskMessage(record).task,
    },
  });
  await expect(hall.locator(".task-pill")).toHaveText("Готово");
  await expect(hall).toContainText("Готово · Анна Иванова, 10:20");
  await expect(hall.getByRole("button", { name: "Вернуть в работу" })).toBeVisible();
});

test("someone else in the chat sees the task without buttons", async ({ page }) => {
  await mockWorkplace(page, { features, data: withTasks(), me: "igor" });
  await openChat(page);
  const hall = taskCard(page, ids.hall);
  await hall.scrollIntoViewIfNeeded();
  await expect(hall).toContainText("Анна Иванова · отвечает");
  await expect(
    hall.getByRole("button", { name: /Готово|Взять|Напомнить|Вернуть/ }),
  ).toHaveCount(0);
  for (const box of await hall.getByRole("checkbox").all())
    await expect(box).toBeDisabled();
  // Nothing burns on Igor: his request first, the tasks of the chat next.
  const slot = page.locator(".chat-slot");
  await expect(slot).toHaveAttribute("data-slot-kind", "requests");
  await slot.getByRole("button", { name: "Задачи: 3" }).click();
  await expect(slot).toHaveAttribute("data-slot-kind", "tasks");
  await expect(slot).toContainText("Задачи · 3");
  await expect(slot.getByRole("button", { name: "Задачи: 3" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

test("«Сделать задачей» turns a message into a task that links back", async ({ page }) => {
  const api = await mockWorkplace(page, { features, data: withTasks() });
  await openChat(page);
  const menu = await messageMenu(page, ids.printouts);
  // Right after the reminder item, as in the shared menu order.
  const texts = await menu.getByRole("menuitem").allTextContents();
  expect(texts.indexOf("Сделать задачей")).toBe(
    texts.indexOf("Изменить напоминание") + 1,
  );
  await menu.getByRole("menuitem", { name: "Сделать задачей" }).click();
  const dialog = page.getByRole("dialog", { name: "Новая задача" });
  await expect(dialog).toContainText(
    "из сообщения Игорь Лаптев: «Буду, захвачу распечатки расписания.»",
  );
  await expect(dialog.getByLabel("Что сделать")).toHaveValue(
    "Буду, захвачу распечатки расписания.",
  );
  await dialog.getByRole("radio", { name: /Игорь Лаптев/ }).click();
  await dialog.getByRole("button", { name: "Создать задачу" }).click();
  await expect(dialog).toHaveCount(0);
  expect(
    api.calls.find((call) => call.method === "POST" && call.path.endsWith("/tasks"))
      ?.body,
  ).toMatchObject({
    title: "Буду, захвачу распечатки расписания.",
    source_message_id: ids.printouts,
    assignee: { kind: "person", actor_id: people.igor.actor_id },
  });
  const card = page.locator(".task-card", {
    hasText: "Буду, захвачу распечатки расписания.",
  });
  await expect(card.locator(".task-card__source")).toHaveText(
    "из сообщения Игорь Лаптев: «Буду, захвачу распечатки расписания.»",
  );
  // A task is not made from a task.
  const again = await messageMenu(page, ids.pool);
  await expect(again.getByRole("menuitem", { name: "Сделать задачей" })).toHaveCount(0);
});

for (const theme of ["light", "dark"] as const) {
  test(`the author edits the task and its checklist in the panel (${theme})`, async ({
    page,
  }) => {
    const api = await mockWorkplace(page, {
      theme,
      features,
      data: withTasks(),
      me: "marina",
    });
    await openChat(page);
    const hall = taskCard(page, ids.hall);
    await hall.scrollIntoViewIfNeeded();
    await hall.getByRole("button", { name: "Действия с задачей" }).click();
    await page.getByRole("menuitem", { name: "Изменить" }).click();
    await expect(page).toHaveURL(new RegExp(`/chat/${chatID}/tasks/${ids.hall}$`));
    const panel = page.getByRole("complementary", { name: "Задача" });
    await expect(panel.getByRole("heading", { name: "Чек-лист · 1 из 3" })).toBeVisible();
    await expect(page).toHaveScreenshot(`task-panel-${theme}.png`, shot);
    const form = panel.getByRole("form", { name: "Изменить задачу" });
    await form.getByLabel("Что сделать").fill("Подготовить большой зал к пятнице");
    await form.getByRole("button", { name: "Сохранить" }).click();
    await expect(panel.locator(".task-card__title")).toHaveText(
      "Подготовить большой зал к пятнице",
    );
    expect(api.calls.filter((call) => call.method !== "GET").at(-1)).toMatchObject({
      method: "PATCH",
      path: `/tasks/${ids.hall}`,
      body: { expected_version: 3, title: "Подготовить большой зал к пятнице" },
    });
    await panel.getByLabel("Новый пункт").fill("Принести колонку");
    await panel.getByRole("button", { name: "Пункт", exact: true }).click();
    await expect(panel.getByLabel("Текст пункта")).toHaveCount(4);
    expect(api.calls.filter((call) => call.method !== "GET").at(-1)).toMatchObject({
      method: "POST",
      path: `/tasks/${ids.hall}/items`,
      body: { text: "Принести колонку" },
    });
  });
}

test("«Все задачи чата» lists open, done and canceled tasks", async ({ page }) => {
  await mockWorkplace(page, { features, data: withTasks() });
  await page.goto(`/chat/${chatID}/tasks`);
  const panel = page.getByRole("complementary", { name: "Все задачи чата" });
  await expect(panel.getByRole("tab", { name: "Открытые · 3" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(panel.locator(".task-row")).toHaveCount(3);
  await panel.getByRole("tab", { name: "Готово" }).click();
  await expect(panel.locator(".task-row")).toHaveText([/Передать график на декабрь/]);
  await panel.getByRole("tab", { name: "Отменённые" }).click();
  await expect(panel.getByText("Отменённых задач нет")).toBeVisible();
  await panel.getByRole("tab", { name: "Готово" }).click();
  await panel.getByText("Передать график на декабрь").click();
  await expect(page).toHaveURL(new RegExp(`/chat/${chatID}/tasks/${ids.december}$`));
});

test("the chat list marks a burning task over a request", async ({ page }) => {
  test.skip(isPhone(), "the phone list is checked by the chats screen");
  await mockWorkplace(page, { features, data: withTasks() });
  await page.goto("/chats");
  await expect(
    page.locator(".chat-row", { hasText: "Инструкторы · зал" }).locator(".chat-row__need"),
  ).toHaveText("задача до 12:00");
  await expect(
    page.locator(".chat-row", { hasText: "Общий" }).locator(".chat-row__need"),
  ).toHaveText("задача просрочена");
  // «Важные»: requests + burning tasks + fired reminders.
  await expect(
    page
      .getByRole("navigation", { name: "Основная навигация" })
      .getByRole("button", { name: /Важные/ }),
  ).toContainText("4");
});

test("an older server shows no tasks anywhere", async ({ page }) => {
  await mockWorkplace(page, { features: ["message_requests", "message_reminders"] });
  await openChat(page);
  await page.getByRole("button", { name: "Добавить", exact: true }).click();
  const menu = page.getByRole("menu", { name: "Добавить" });
  await expect(menu.getByRole("menuitem", { name: /Задача/ })).toHaveCount(0);
  await page.keyboard.press("Escape");
  const actions = await messageMenu(page, ids.printouts);
  await expect(actions.getByRole("menuitem", { name: "Сделать задачей" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.locator(".chat-slot")).toHaveAttribute("data-slot-kind", "requests");
  await expect(page.locator(".chat-slot__chips")).toHaveCount(0);
});
