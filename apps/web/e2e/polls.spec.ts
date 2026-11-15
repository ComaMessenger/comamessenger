import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { chatID, fixtures, mockWorkplace, people } from "./workplaceMock";
import type { PollRecord } from "./pollsMock";

test.use({ timezoneId: "Europe/Moscow", locale: "ru-RU" });

const isPhone = () => test.info().project.name === "phone";
const shot = { animations: "disabled" as const };
const features = [
  "message_requests",
  "message_reminders",
  "message_tasks",
  "message_polls",
];
const pid = (n: number) => `00000000-0000-4000-8000-${String(700 + n).padStart(12, "0")}`;
export const pollIDs = {
  day: pid(1),
  pool: pid(2),
  gear: pid(3),
  secret: pid(4),
};

const poll = (record: Partial<PollRecord> & Pick<PollRecord, "id" | "author" | "question" | "options" | "created_seq">): PollRecord => ({
  chat_id: chatID,
  multiple: false,
  anonymous: false,
  due_at: null,
  status: "open",
  closed_reason: null,
  closed_at: null,
  votes: {},
  counts: record.options.map(() => 0),
  version: 3,
  created_at: "2026-11-11T06:50:00Z",
  next_remind_at: null,
  reminds: 0,
  ...record,
});

/** Three polls of the prototype: before the vote, anonymous closed, the author's. */
export function pollFixtures(): PollRecord[] {
  const { oleg, marina, igor } = people;
  return [
    poll({
      id: pollIDs.pool,
      author: marina.actor_id,
      question: "Удобно ли новое расписание бассейна?",
      options: ["Да, всё устраивает", "Неудобно утро", "Неудобен вечер"],
      anonymous: true,
      status: "closed",
      closed_reason: "author",
      closed_at: "2026-11-10T15:02:00Z",
      votes: { [oleg.actor_id]: [], [igor.actor_id]: [], [marina.actor_id]: [] },
      counts: [2, 1, 0],
      created_seq: 6,
      created_at: "2026-11-10T14:00:00Z",
    }),
    poll({
      id: pollIDs.day,
      author: marina.actor_id,
      question: "Какой день удобнее для выездного занятия в декабре?",
      options: ["Вторник", "Среда", "Четверг"],
      due_at: "2026-11-13T15:00:00Z",
      votes: { [oleg.actor_id]: [1], [igor.actor_id]: [0] },
      created_seq: 7,
      created_at: "2026-11-11T06:24:00Z",
    }),
  ];
}

function authorPoll(): PollRecord {
  const { oleg, marina } = people;
  return poll({
    id: pollIDs.gear,
    author: people.anna.actor_id,
    question: "Какой инвентарь заказать в первую очередь?",
    options: ["Утяжелители 1–2 кг", "Фитболы", "Балансировочные подушки"],
    multiple: true,
    due_at: "2026-11-16T09:00:00Z",
    votes: {
      [oleg.actor_id]: [0, 2],
      [people.anna.actor_id]: [0],
      [marina.actor_id]: [1],
    },
    created_seq: 8,
    created_at: "2026-11-11T07:05:00Z",
  });
}

function withPolls(extra: PollRecord[] = []) {
  const data = fixtures();
  data.polls = [...pollFixtures(), ...extra];
  return data;
}

const card = (page: Page, messageID: string) =>
  page.locator(`#message-${messageID} .poll-card`);

async function openChat(page: Page) {
  await page.goto(`/chat/${chatID}`);
  await expect(
    page.locator(".message-feed").getByText("Маты в малом зале разложил."),
  ).toBeVisible();
}

for (const theme of ["light", "dark"] as const) {
  test(`polls in the feed: no counts before one's vote, the result once closed (${theme})`, async ({
    page,
  }) => {
    await mockWorkplace(page, { theme, features, data: withPolls() });
    await openChat(page);
    const day = card(page, pollIDs.day);
    await day.scrollIntoViewIfNeeded();
    await expect(day).toContainText("Опрос");
    await expect(day).toContainText("до пт, 18:00");
    await expect(day).toContainText("2 из 4 ответили");
    await expect(day.getByRole("radio")).toHaveCount(3);
    // Before the vote nobody sees how the others voted.
    await expect(day).not.toContainText("%");
    await expect(day.getByText("Кто голосовал")).toHaveCount(0);

    const pool = card(page, pollIDs.pool);
    await expect(pool).toContainText("Анонимный опрос");
    await expect(pool).toContainText("Закрыт");
    await expect(pool).toContainText("Итог: «Да, всё устраивает» — 2 из 3");
    await expect(pool).toContainText("67%");
    await expect(pool.getByText("Кто голосовал")).toHaveCount(0);
    await expect(page).toHaveScreenshot(`poll-feed-${theme}.png`, shot);
    if (theme === "light") {
      const axe = await new AxeBuilder({ page })
        .include(`#message-${pollIDs.day}`)
        .include(`#message-${pollIDs.pool}`)
        .analyze();
      expect(axe.violations).toEqual([]);
    }
  });

  test(`the author creates a poll from «+» (${theme})`, async ({ page }) => {
    const api = await mockWorkplace(page, { theme, features, data: withPolls() });
    await openChat(page);
    await page.getByRole("button", { name: "Добавить", exact: true }).click();
    const menu = page.getByRole("menu", { name: "Добавить" });
    await expect(menu.getByRole("menuitem")).toHaveText([
      "Фото и видео",
      "Файл",
      "Markdown-файл",
      /Запрос\s*Попросить ответ/,
      /Опрос\s*Узнать мнение, выбрать из вариантов/,
      /Задача\s*Поручить/,
      /Позвать агента/,
    ]);
    await menu.getByRole("menuitem", { name: /Опрос/ }).click();

    const dialog = page.getByRole("dialog", { name: "Новый опрос" });
    await dialog.getByLabel("Вопрос").fill("Во сколько удобнее планёрка по понедельникам?");
    await dialog.getByLabel("Вариант 1", { exact: true }).fill("8:30 — до слотов");
    await dialog.getByLabel("Вариант 2", { exact: true }).fill("13:00 — между слотами");
    await dialog.getByRole("button", { name: "Добавить вариант" }).click();
    await expect(dialog.getByLabel("Вариант 3", { exact: true })).toBeFocused();
    await page.keyboard.type("17:00 — после слотов");
    // The handle moves an option with the keyboard too.
    await dialog
      .getByRole("button", { name: /Переставить вариант 3/ })
      .press("ArrowUp");
    await expect(dialog.getByLabel("Вариант 2", { exact: true })).toHaveValue(
      "17:00 — после слотов",
    );
    await dialog.getByRole("switch", { name: "Несколько ответов" }).click();
    await dialog.getByRole("radio", { name: "до пт, 18:00" }).click();
    await expect(page).toHaveScreenshot(`poll-dialog-${theme}.png`, shot);
    if (theme === "light") {
      const axe = await new AxeBuilder({ page }).include(".poll-dialog").analyze();
      expect(axe.violations).toEqual([]);
    }
    await dialog.getByRole("button", { name: "Отправить опрос" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText("Опрос отправлен")).toBeVisible();
    const created = api.calls.find(
      (call) => call.method === "POST" && call.path === `/chats/${chatID}/polls`,
    );
    expect(created?.body).toMatchObject({
      question: "Во сколько удобнее планёрка по понедельникам?",
      options: ["8:30 — до слотов", "17:00 — после слотов", "13:00 — между слотами"],
      multiple: true,
      anonymous: false,
      due_at: "2026-11-13T15:00:00.000Z",
    });
    const fresh = page
      .locator(".poll-card")
      .filter({ hasText: "Во сколько удобнее планёрка" });
    await expect(fresh).toContainText("Опрос · несколько ответов");
    await expect(fresh).toContainText("0 из 4 ответили");
    // The author sees the results always and may close the poll.
    await expect(fresh.getByRole("button", { name: "Закрыть" })).toBeVisible();
  });
}

test("the form refuses a poll without two options and keeps the draft", async ({
  page,
}) => {
  await mockWorkplace(page, { features, data: withPolls() });
  await openChat(page);
  await page.getByRole("button", { name: "Добавить", exact: true }).click();
  await page.getByRole("menuitem", { name: /Опрос/ }).click();
  const dialog = page.getByRole("dialog", { name: "Новый опрос" });
  await dialog.getByLabel("Вопрос").fill("Субботник в субботу?");
  await dialog.getByLabel("Вариант 1", { exact: true }).fill("Да");
  await dialog.getByRole("button", { name: "Отправить опрос" }).click();
  await expect(dialog.getByText("Нужно хотя бы два варианта")).toBeVisible();
  await dialog.getByLabel("Вариант 2", { exact: true }).fill("да");
  await expect(dialog.getByText("Вариант 2 повторяет другой")).toBeVisible();
  await dialog.getByRole("button", { name: "Отмена" }).click();
  await page.getByRole("button", { name: "Добавить", exact: true }).click();
  await page.getByRole("menuitem", { name: /Опрос/ }).click();
  await expect(
    page.getByRole("dialog", { name: "Новый опрос" }).getByLabel("Вопрос"),
  ).toHaveValue("Субботник в субботу?");
});

test("a participant votes, changes the vote and takes it back", async ({
  page,
}) => {
  const api = await mockWorkplace(page, { features, data: withPolls() });
  await openChat(page);
  const day = card(page, pollIDs.day);
  await day.scrollIntoViewIfNeeded();
  await day.getByRole("radio", { name: "Среда" }).click();
  await expect(day).toContainText("3 из 4 ответили");
  await expect(day.getByLabel("Среда: 67 %")).toBeVisible();
  await expect(day.getByRole("img", { name: "Ваш выбор" })).toHaveCount(1);
  await expect(day.getByRole("button", { name: "Отменить голос" })).toBeVisible();
  await expect(day.getByRole("button", { name: "Кто голосовал" })).toBeVisible();

  await day.getByRole("radio", { name: /Четверг/ }).click();
  await expect(day.getByLabel("Четверг: 33 %")).toBeVisible();
  await expect(day).toContainText("3 из 4 ответили");

  await day.getByRole("button", { name: "Отменить голос" }).click();
  await expect(day).toContainText("2 из 4 ответили");
  await expect(day).not.toContainText("%");
  expect(
    api.calls
      .filter((call) => call.path === `/polls/${pollIDs.day}/vote`)
      .map((call) => [call.method, call.body]),
  ).toEqual([
    ["PUT", { options: [1] }],
    ["PUT", { options: [2] }],
    ["DELETE", null],
  ]);

  // Who voted: by option, names of the chat.
  await day.getByRole("radio", { name: "Вторник" }).click();
  await day.getByRole("button", { name: "Кто голосовал" }).click();
  const voters = page.getByRole("dialog", { name: "Кто голосовал" });
  await expect(voters.getByRole("tab")).toHaveText([
    "Вторник · 2",
    "Среда · 1",
    "Четверг · 0",
  ]);
  await expect(voters.locator(".poll-voters__row")).toHaveText([
    /Игорь Лаптев/,
    /Анна Иванова/,
  ]);
  // Only the author and chat admins see who has not voted.
  await expect(voters.getByRole("tab", { name: /Не ответили/ })).toHaveCount(0);
});

for (const theme of ["light", "dark"] as const) {
  test(`the author: who voted, remind and close with the result (${theme})`, async ({
    page,
  }) => {
    const api = await mockWorkplace(page, {
      theme,
      features,
      data: withPolls([authorPoll()]),
    });
    await openChat(page);
    const gear = card(page, pollIDs.gear);
    await gear.scrollIntoViewIfNeeded();
    await expect(gear).toContainText("Опрос · несколько ответов");
    await expect(gear).toContainText("3 из 4 ответили");
    await expect(gear.getByLabel("Утяжелители 1–2 кг: 50 %")).toBeVisible();
    await gear.getByRole("button", { name: "Кто голосовал" }).click();
    const voters = page.getByRole("dialog", { name: "Кто голосовал" });
    await expect(voters.getByRole("tab")).toHaveText([
      "Утяжелители 1–2 кг · 2",
      "Фитболы · 1",
      "Балансировочные подушки · 1",
      "Не ответили · 1",
    ]);
    await expect(voters.locator(".poll-voters__row")).toHaveText([
      /Олег Чернов/,
      /Анна Иванова/,
    ]);
    await voters.getByRole("tab", { name: "Не ответили · 1" }).click();
    await expect(voters.locator(".poll-voters__row")).toHaveText([/Игорь Лаптев/]);
    await expect(page).toHaveScreenshot(`poll-author-${theme}.png`, shot);
    if (isPhone()) await voters.getByRole("button", { name: "Готово" }).click();
    else await page.keyboard.press("Escape");
    await expect(voters).toHaveCount(0);

    await gear
      .getByRole("button", { name: "Напомнить не ответившим · 1" })
      .click();
    await expect(page.getByText("Напомнили 1 человеку")).toBeVisible();
    await expect(gear).toContainText("Напомнили · повторно");

    // «Изменить»: only the question changes, the card says «изм.».
    const row = page.locator(`#message-${pollIDs.gear}`);
    await row.hover();
    await row.getByRole("button", { name: "Действия с сообщением" }).click();
    await page.getByRole("menuitem", { name: "Редактировать" }).click();
    const edit = page.getByRole("dialog", { name: "Изменить вопрос" });
    await edit.getByLabel("Вопрос").fill("Что заказать первым к декабрю?");
    await edit.getByRole("button", { name: "Сохранить" }).click();
    await expect(edit).toHaveCount(0);
    await expect(gear).toContainText("Что заказать первым к декабрю?");
    await expect(gear).toContainText("изм.");
    expect(
      api.calls.find((call) => call.method === "PATCH")?.body,
    ).toEqual({ question: "Что заказать первым к декабрю?", expected_version: 3 });

    await gear.getByRole("button", { name: "Закрыть" }).click();
    await page
      .getByRole("dialog", { name: "Закрыть опрос?" })
      .getByRole("button", { name: "Закрыть" })
      .click();
    await expect(gear).toContainText("Закрыт");
    await expect(gear).toContainText("Итог: «Утяжелители 1–2 кг» — 2 из 3");
    await expect(gear.getByRole("button", { name: "Закрыть" })).toHaveCount(0);
    // A closed poll is not edited any more.
    await row.hover();
    await row.getByRole("button", { name: "Действия с сообщением" }).click();
    await expect(page.getByRole("menuitem", { name: "Редактировать" })).toHaveCount(0);
    await page.keyboard.press("Escape");
    expect(
      api.calls
        .filter((call) => call.method === "POST" && call.path.startsWith("/polls/"))
        .map((call) => call.path),
    ).toEqual([`/polls/${pollIDs.gear}/remind`, `/polls/${pollIDs.gear}/close`]);
  });
}

test("an anonymous vote is final and names stay hidden from the author", async ({
  page,
}) => {
  const secret = poll({
    id: pollIDs.secret,
    author: people.marina.actor_id,
    question: "Как вам новая разминка?",
    options: ["Нравится", "Не нравится"],
    anonymous: true,
    votes: { [people.oleg.actor_id]: [] },
    counts: [1, 0],
    created_seq: 9,
  });
  await mockWorkplace(page, { features, data: withPolls([secret]) });
  await openChat(page);
  const anon = card(page, pollIDs.secret);
  await anon.scrollIntoViewIfNeeded();
  await expect(anon).toContainText("Анонимный опрос");
  await expect(anon).toContainText("Анонимно · голос нельзя изменить");
  await anon.getByRole("radio", { name: "Не нравится" }).click();
  await expect(anon).toContainText("2 из 4 ответили");
  await expect(anon.getByLabel("Не нравится: 50 %")).toBeVisible();
  // The device remembers the choice; the server does not know it.
  await expect(anon.getByRole("img", { name: "Ваш выбор" })).toHaveCount(1);
  await expect(anon.getByRole("button", { name: "Отменить голос" })).toHaveCount(0);
  await expect(anon.getByRole("button", { name: "Кто голосовал" })).toHaveCount(0);
  await expect(anon.getByRole("button", { name: "Нравится" })).toHaveCount(0);
  await expect(anon).not.toContainText("Анонимно · голос нельзя изменить");
});

test("the author of an anonymous poll sees counts and no names", async ({
  page,
}) => {
  const secret = poll({
    id: pollIDs.secret,
    author: people.anna.actor_id,
    question: "Как вам новая разминка?",
    options: ["Нравится", "Не нравится"],
    anonymous: true,
    votes: { [people.oleg.actor_id]: [], [people.igor.actor_id]: [] },
    counts: [1, 1],
    created_seq: 9,
  });
  await mockWorkplace(page, { features, data: withPolls([secret]) });
  await openChat(page);
  const anon = card(page, pollIDs.secret);
  await anon.scrollIntoViewIfNeeded();
  await expect(
    anon.getByRole("radio", { name: "Нравится: 50 %", exact: true }),
  ).toBeVisible();
  await expect(anon.getByRole("button", { name: "Кто голосовал" })).toHaveCount(0);
  await expect(anon.locator(".poll-option__faces")).toHaveCount(0);
  await expect(
    anon.getByRole("button", { name: "Напомнить не ответившим · 1" }),
  ).toBeVisible();
});

for (const theme of ["light", "dark"] as const) {
  test(`«Ждут вас → Опросы»: only polls with a due date, voted right in the list (${theme})`, async ({
    page,
  }) => {
    const noDue = poll({
      id: pollIDs.secret,
      author: people.oleg.actor_id,
      question: "Чай или кофе на планёрке?",
      options: ["Чай", "Кофе"],
      created_seq: 9,
    });
    const api = await mockWorkplace(page, {
      theme,
      features,
      data: withPolls([noDue]),
    });
    await page.goto("/important?tab=waiting");
    const chips = page.getByRole("group", { name: "Что ждёт" });
    await expect(chips.getByRole("button")).toHaveText([
      /Всё/,
      /Запросы\s*1/,
      "Задачи",
      /Опросы\s*1/,
    ]);
    await chips.getByRole("button", { name: /Опросы/ }).click();
    await expect(page).toHaveURL(/kind=polls/);
    const item = page.getByRole("article", { name: "Опрос · Марина Соколова" });
    await expect(item).toContainText("Инструкторы · зал · до пт, 18:00");
    await expect(item).toContainText("Какой день удобнее для выездного занятия");
    await expect(page.getByText("Чай или кофе на планёрке?")).toHaveCount(0);
    await expect(page.getByRole("article")).toHaveCount(1);
    await expect(page).toHaveScreenshot(`poll-waiting-${theme}.png`, shot);
    if (theme === "light") {
      const axe = await new AxeBuilder({ page }).include(".inbox").analyze();
      expect(axe.violations).toEqual([]);
    }
    await item.getByRole("radio", { name: "Четверг" }).click();
    await expect(item).toHaveCount(0);
    await expect(page.getByText("Никто не ждёт вашего ответа")).toBeVisible();
    expect(
      api.calls.filter((call) => call.method === "PUT").map((call) => call.path),
    ).toEqual([`/polls/${pollIDs.day}/vote`]);
  });
}

test("without message_polls «+» has no Poll", async ({ page }) => {
  await mockWorkplace(page, {
    features: ["message_requests", "message_reminders", "message_tasks"],
    data: withPolls(),
  });
  await openChat(page);
  await page.getByRole("button", { name: "Добавить", exact: true }).click();
  const menu = page.getByRole("menu", { name: "Добавить" });
  await expect(menu.getByRole("menuitem", { name: /Задача/ })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: /Опрос/ })).toHaveCount(0);
});
