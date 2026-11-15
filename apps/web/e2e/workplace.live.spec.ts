import {
  expect,
  request as playwrightRequest,
  test,
  type APIRequestContext,
  type Browser,
  type Page,
} from "@playwright/test";

/*
 * Requests and reminders against a real server (phase 6.4 wave 1): four
 * people in separate browser contexts, realtime between them, River jobs
 * that fire reminders. Runs only with COMA_LIVE_API pointing at a fresh
 * server (an empty database: the test bootstraps it) and the web app built
 * against it (VITE_API_URL). See docs/phases/06.4-requests-and-reminders.md.
 */

const api = process.env.COMA_LIVE_API;
test.skip(!api, "set COMA_LIVE_API to run against a live server");
test.skip(
  () => test.info().project.name !== "desktop",
  "one live run is enough: the phone layout is covered by the mocked specs",
);
test.use({ timezoneId: "Europe/Moscow", locale: "ru-RU" });
test.describe.configure({ mode: "serial" });

type Person = {
  key: string;
  name: string;
  email: string;
  password: string;
  id: string;
  token: string;
};

const people: Record<"marina" | "anna" | "oleg" | "igor", Person> = {
  marina: { key: "marina", name: "Марина Соколова", email: "marina@example.test", password: "marina secure password", id: "", token: "" },
  anna: { key: "anna", name: "Анна Иванова", email: "anna@example.test", password: "anna secure password", id: "", token: "" },
  oleg: { key: "oleg", name: "Олег Чернов", email: "oleg@example.test", password: "oleg secure password", id: "", token: "" },
  igor: { key: "igor", name: "Игорь Лаптев", email: "igor@example.test", password: "igor secure password", id: "", token: "" },
};
let chatID = "";
let textID = "";
const question = `Планёрка в понедельник в 8:30. Будете? ${Date.now() % 10000}`;

async function json<T>(response: Awaited<ReturnType<APIRequestContext["get"]>>): Promise<T> {
  if (!response.ok())
    throw new Error(`${response.url()} → ${response.status()} ${await response.text()}`);
  return (await response.json()) as T;
}

test.beforeAll(async () => {
  const http = await playwrightRequest.newContext({ baseURL: api });
  const status = await json<{ bootstrapped: boolean }>(
    await http.get("/api/v1/bootstrap/status"),
  );
  expect(status.bootstrapped, "the live server must start empty").toBe(false);
  const owner = await json<{ access_token: string; user: { id: string } }>(
    await http.post("/api/v1/bootstrap", {
      data: {
        organization_name: "Реабцентр «Опора»",
        organization_slug: "opora",
        display_name: people.marina.name,
        handle: "marina",
        email: people.marina.email,
        password: people.marina.password,
        timezone: "UTC",
      },
    }),
  );
  people.marina.id = owner.user.id;
  people.marina.token = owner.access_token;
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  for (const person of [people.anna, people.oleg, people.igor]) {
    const invite = await json<{ accept_url: string }>(
      await http.post("/api/v1/invitations", {
        headers: auth(people.marina.token),
        data: { email: person.email, role: "member" },
      }),
    );
    const token = invite.accept_url.split("/").pop()!;
    const accepted = await json<{ access_token: string; user: { id: string } }>(
      await http.post(`/api/v1/invitations/${token}/accept`, {
        data: {
          display_name: person.name,
          handle: person.key,
          password: person.password,
          timezone: "UTC",
        },
      }),
    );
    person.id = accepted.user.id;
    person.token = accepted.access_token;
  }
  for (const person of Object.values(people))
    await json(
      await http.patch("/api/v1/preferences", {
        headers: auth(person.token),
        data: { locale: "ru" },
      }),
    );
  const chat = await json<{ id: string }>(
    await http.post("/api/v1/chats", {
      headers: auth(people.marina.token),
      data: {
        kind: "group",
        visibility: "private",
        name: "Инструкторы · зал",
        member_ids: [people.anna.id, people.oleg.id, people.igor.id],
      },
    }),
  );
  chatID = chat.id;
  const text = await json<{ id: string }>(
    await http.post(`/api/v1/chats/${chatID}/messages`, {
      headers: auth(people.oleg.token),
      data: {
        client_msg_id: crypto.randomUUID(),
        body: "Маты в малом зале разложил.",
        body_format: "plain",
      },
    }),
  );
  textID = text.id;
  await http.dispose();
});

async function signIn(browser: Browser, person: Person, theme: "light" | "dark" = "light") {
  const context = await browser.newContext({
    timezoneId: "Europe/Moscow",
    locale: "ru-RU",
    viewport: { width: 1280, height: 800 },
  });
  await context.addInitScript((value) => {
    localStorage.setItem("coma-locale", "ru");
    localStorage.setItem("coma-theme", value);
  }, theme);
  const page = await context.newPage();
  await page.goto("/");
  await page.getByLabel("Почта").fill(person.email);
  await page.getByLabel("Пароль", { exact: true }).fill(person.password);
  await page.getByRole("button", { name: "Войти" }).click();
  await expect(page.getByRole("navigation", { name: "Основная навигация" })).toBeVisible();
  return page;
}

async function openChat(page: Page) {
  await page.goto(`/chat/${chatID}`);
  await expect(page.locator(".message-feed").getByText("Маты в малом зале разложил.")).toBeVisible();
}

const requestCard = (page: Page) =>
  page.locator(".request-card", { hasText: question });

async function attach(page: Page, name: string) {
  await test.info().attach(name, {
    body: await page.screenshot(),
    contentType: "image/png",
  });
}

test("a request goes from the author to recipients, reminds and closes", async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const marina = await signIn(browser, people.marina);
  await openChat(marina);
  await marina.getByRole("button", { name: "Добавить", exact: true }).click();
  await marina.getByRole("menuitem", { name: /Запрос/ }).click();
  const dialog = marina.getByRole("dialog", { name: "Запрос" });
  await dialog.getByRole("textbox", { name: "Вопрос" }).fill(question);
  await dialog.getByRole("radio", { name: "Люди" }).click();
  await dialog.getByRole("button", { name: people.anna.name }).click();
  await dialog.getByRole("button", { name: people.oleg.name }).click();
  await dialog.getByRole("radio", { name: "Приду / Не приду" }).click();
  await dialog.getByRole("radio", { name: "Без срока" }).click();
  await dialog.getByRole("button", { name: "Отправить запрос · 2 людям" }).click();
  await expect(dialog).toHaveCount(0);
  const authorCard = requestCard(marina);
  await expect(authorCard).toContainText("ждём ответа: 2 человека");
  await expect(authorCard).toContainText("Ответили 0 из 2");
  await attach(marina, "author-card-light");

  // A recipient: the mark in the list, the strip, buttons, a comment.
  const anna = await signIn(browser, people.anna);
  await anna.goto("/chats");
  await expect(
    anna.locator(".chat-row", { hasText: "Инструкторы · зал" }).locator(".chat-row__need"),
  ).toHaveText("ждут ответа");
  await openChat(anna);
  await expect(anna.getByRole("button", { name: /Ждут вашего ответа/ })).toBeVisible();
  const annaCard = requestCard(anna);
  await annaCard.getByRole("button", { name: "Приду", exact: true }).click();
  await expect(annaCard).toContainText("Ваш ответ: Приду");
  await annaCard.getByRole("button", { name: "+ Комментарий" }).click();
  await annaCard.getByRole("textbox", { name: "Комментарий к ответу" }).fill("буду к 8:20");
  await annaCard.getByRole("button", { name: "Сохранить" }).click();
  await expect(annaCard).toContainText("Ваш комментарий: буду к 8:20");
  await expect(anna.getByRole("button", { name: /Ждут вашего ответа/ })).toHaveCount(0);

  // The author sees it live: the count and the bars.
  await expect(authorCard).toContainText("Ответили 1 из 2");
  await expect(authorCard.locator(".request-tally").first()).toHaveText(/Приду\s*1/);

  // Someone who is not asked: no buttons, the count only.
  const igor = await signIn(browser, people.igor, "dark");
  await openChat(igor);
  const igorCard = requestCard(igor);
  await expect(igorCard).toContainText("Ответа ждут не от вас — кнопок нет");
  await expect(igorCard).toContainText("Ответили 1 из 2");
  await expect(igorCard.getByRole("button")).toHaveCount(0);
  await attach(igor, "observer-card-dark");

  // Who answered what; remind those who have not.
  await authorCard.getByRole("button", { name: "Подробнее" }).click();
  const panel = marina.getByRole("complementary", { name: "Ответы" });
  await expect(panel.getByRole("tab", { name: /Нет ответа\s*1/ })).toHaveAttribute("aria-selected", "true");
  await expect(panel).toContainText(people.oleg.name);
  await panel.getByRole("tab", { name: /Приду/ }).first().click();
  await expect(panel).toContainText("«буду к 8:20»");
  await panel.getByRole("button", { name: "Напомнить не ответившим · 1" }).click();
  await expect(marina.getByText("Напомнили 1 человеку")).toBeVisible();
  await expect(panel.getByRole("button", { name: /Напомнили · снова можно/ })).toBeDisabled();
  await attach(marina, "answers-panel-light");

  // The other recipient answers from «Важные → Ждут вас».
  const oleg = await signIn(browser, people.oleg, "dark");
  await oleg.goto("/important");
  await expect(oleg.getByRole("tab", { name: /Ждут вас\s*1/ })).toHaveAttribute("aria-selected", "true");
  const item = oleg.getByRole("article", { name: `Запрос · ${people.marina.name}` });
  await attach(oleg, "important-waiting-dark");
  await item.getByRole("button", { name: "Не приду" }).click();
  await expect(oleg.getByRole("heading", { name: "Отвечено" })).toBeVisible();
  await expect(item).toContainText("Ваш ответ: Не приду");

  await expect(authorCard).toContainText("Ответили 2 из 2");
  await expect(igorCard).toContainText("Ответили 2 из 2");

  // Closing reaches everyone.
  await panel.getByRole("button", { name: "Закрыть", exact: true }).click();
  await marina.getByRole("dialog", { name: "Закрыть запрос?" }).getByRole("button", { name: "Закрыть", exact: true }).click();
  await expect(authorCard.locator(".request-pill")).toHaveText("Закрыт");
  await expect(annaCard.locator(".request-pill")).toHaveText("Закрыт");
  await expect(annaCard.getByRole("button", { name: "Изменить" })).toHaveCount(0);

  // The device zone replaced the default one in every profile that signed in.
  const http = await playwrightRequest.newContext({ baseURL: api });
  for (const person of [people.marina, people.anna]) {
    const me = await json<{ timezone: string }>(
      await http.get("/api/v1/me", { headers: { Authorization: `Bearer ${person.token}` } }),
    );
    expect(me.timezone).toBe("Europe/Moscow");
  }
  await http.dispose();
});

test("a reminder about a message fires, shows in «Важные» and is done", async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const anna = await signIn(browser, people.anna);
  await openChat(anna);
  const row = anna.locator(`#message-${textID}`);
  await row.hover();
  await row.getByRole("button", { name: "Действия с сообщением" }).click();
  await anna.getByRole("menuitem", { name: "Напомнить мне" }).click();
  const picker = anna.getByRole("dialog", { name: "Напомнить мне" });
  await picker.getByText("Своё время").click();
  await picker.getByRole("radio", { name: "Другая дата" }).click();
  // Two minutes ahead on the Moscow clock of the page.
  const at = await anna.evaluate(() => {
    const value = new Date(Date.now() + 2 * 60_000);
    const pad = (n: number) => String(n).padStart(2, "0");
    return {
      day: `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`,
      time: `${pad(value.getHours())}:${pad(value.getMinutes())}`,
    };
  });
  await picker.getByLabel("День", { exact: true }).fill(at.day);
  await picker.getByLabel("Время", { exact: true }).fill(at.time);
  await picker.getByLabel("Заметка для себя").fill("позвонить Марине");
  await picker.getByRole("button", { name: /^Напомнить: / }).click();
  await expect(picker).toHaveCount(0);
  await expect(anna.getByText(/Напомню .*Список — в «Важных»/)).toBeVisible();
  await expect(row.getByRole("button", { name: /^Напоминание / })).toBeVisible();

  await anna.goto("/important?tab=reminders");
  const today = anna.getByRole("region", { name: "Сегодня" });
  await expect(today).toContainText("Маты в малом зале разложил.");
  await expect(today).toContainText("позвонить Марине");
  await attach(anna, "reminders-pending-light");

  // The River job fires it; the list follows reminder.fired.
  const fired = anna.getByRole("region", { name: "Сработали" });
  await expect(fired).toContainText("позвонить Марине", { timeout: 200_000 });
  await expect(anna.getByRole("tab", { name: /Напоминания\s*1/ })).toBeVisible();
  await attach(anna, "reminders-fired-light");
  await fired.getByRole("button", { name: "Открыть" }).click();
  const strip = anna.getByRole("status").filter({ hasText: "Напоминание: позвонить Марине" });
  await expect(strip).toBeVisible();
  await strip.getByRole("button", { name: "Готово" }).click();
  await expect(anna.getByText("Готово. Напоминание убрано")).toBeVisible();
  await anna.goto("/important?tab=reminders");
  await expect(anna.getByText("Напоминаний нет")).toBeVisible();
});
