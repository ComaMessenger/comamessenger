import { expect, test, type Page } from "@playwright/test";
import {
  api,
  livePage,
  member,
  owner,
  run,
  signIn,
  skipWithoutServer,
} from "./liveApi";

/*
 * Tasks on a real server (phase 6.6 wave 3, package T): several people in
 * their own browser contexts, realtime between them. Needs the T server
 * package on the stand: set COMA_LIVE_TASKS=1 next to COMA_LIVE_API.
 */
const skipWithoutTasks = () => {
  skipWithoutServer();
  test.skip(!process.env.COMA_LIVE_TASKS, "COMA_LIVE_TASKS is not set: no tasks on the stand");
};
test.skip(() => test.info().project.name === "phone", "Live run on desktop");
test.describe.configure({ mode: "serial" });

/** «2026-11-15T14:30» in Moscow time, for datetime-local. */
function moscowInput(at: Date): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Moscow",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(at)
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

async function openChat(page: Page, chatID: string, text: string) {
  await page.goto(`/chat/${chatID}`);
  await expect(page.locator(".message-feed").getByText(text).first()).toBeVisible();
}

test("a task with items on two people goes from the author to done and back", async ({
  browser,
}) => {
  skipWithoutTasks();
  const anna = await owner();
  const marina = await member(anna, `Марина ${run}т`, "marinat");
  const oleg = await member(anna, `Олег ${run}т`, "olegt");
  const igor = await member(anna, `Игорь ${run}т`, "igort");
  const lena = await member(anna, `Лена ${run}т`, "lenat");
  const chat = await api<{ id: string }>(marina, "/chats", {
    body: {
      kind: "group",
      visibility: "private",
      name: `Зал ${run}т`,
      member_ids: [oleg.id, igor.id, lena.id],
    },
  });
  const text = `Аптечка в большом зале пустая ${run}`;
  await api(igor, `/chats/${chat.id}/messages`, {
    body: { client_msg_id: crypto.randomUUID(), body: text, body_format: "plain" },
  });

  // The author: «+» → «Задача», two items on two people, due in two hours.
  const author = await livePage(browser);
  await signIn(author, marina);
  await openChat(author, chat.id, text);
  await author.getByRole("button", { name: "Добавить", exact: true }).click();
  await author.getByRole("menuitem", { name: /Задача/ }).click();
  const dialog = author.getByRole("dialog", { name: "Новая задача" });
  const title = `Повесить расписание бассейна ${run}`;
  await dialog.getByLabel("Что сделать").fill(title);
  await dialog.getByRole("radio", { name: new RegExp(oleg.name) }).click();
  await dialog.getByRole("radio", { name: "Другая дата" }).click();
  await dialog
    .getByLabel("Дата и время")
    .fill(moscowInput(new Date(Date.now() + 2 * 3600_000)));
  for (const [index, item, who] of [
    [1, "Снять старое расписание", oleg.name],
    [2, "Распечатать новое", igor.name],
  ] as const) {
    await dialog.getByRole("button", { name: "Пункт", exact: true }).click();
    await dialog.getByLabel(`Пункт ${index}`, { exact: true }).fill(item);
    await dialog
      .getByRole("button", { name: "Исполнитель пункта", exact: true })
      .click();
    await author.getByRole("option", { name: new RegExp(who) }).click();
  }
  await dialog.getByRole("button", { name: "Создать задачу" }).click();
  await expect(dialog).toHaveCount(0);
  const authorCard = author.locator(".task-card", { hasText: title });
  await expect(authorCard).toContainText(`${oleg.name} · отвечает`);
  await expect(authorCard).toContainText("Задача · 0 из 2");
  await expect(authorCard.getByRole("button", { name: "Напомнить ответственному" })).toBeVisible();

  // The responsible person: the chat mark, the red slot, the card.
  const responsible = await livePage(browser);
  await signIn(responsible, oleg);
  await responsible.goto("/chats");
  await expect(
    responsible.locator(".chat-row", { hasText: `Зал ${run}т` }).locator(".chat-row__need"),
  ).toHaveText(/^задача до /);
  await openChat(responsible, chat.id, text);
  const slot = responsible.locator(".chat-slot");
  await expect(slot).toHaveAttribute("data-slot-kind", "hot");
  await expect(slot).toContainText(title);
  const card = responsible.locator(".task-card", { hasText: title });
  await card.getByRole("button", { name: "Взять в работу" }).click();
  await expect(card).toContainText("В работе");
  await expect(authorCard).toContainText("В работе");
  await card.getByRole("checkbox", { name: "Снять старое расписание" }).click();
  await expect(card).toContainText("Задача · 1 из 2");
  await expect(authorCard).toContainText("Задача · 1 из 2");

  // An item's assignee ticks their own item.
  const helper = await livePage(browser);
  await signIn(helper, igor);
  await openChat(helper, chat.id, text);
  const helperCard = helper.locator(".task-card", { hasText: title });
  await helperCard.getByRole("checkbox", { name: "Распечатать новое" }).click();
  await expect(card).toContainText("Задача · 2 из 2");
  await expect(card).toContainText("Все пункты готовы — закрыть задачу?");

  // Someone else: no buttons.
  const other = await livePage(browser);
  await signIn(other, lena);
  await openChat(other, chat.id, text);
  const otherCard = other.locator(".task-card", { hasText: title });
  await expect(otherCard).toContainText(`${oleg.name} · отвечает`);
  await expect(
    otherCard.getByRole("button", { name: /Готово|Взять|Напомнить|Вернуть/ }),
  ).toHaveCount(0);

  // «Готово» reaches the author live; the slot stops burning.
  await card.getByRole("button", { name: "Готово", exact: true }).click();
  await expect(authorCard.locator(".task-pill")).toHaveText("Готово");
  await expect(authorCard).toContainText(`Готово · ${oleg.name}`);
  await expect(slot).toHaveCount(0);
  await expect(otherCard.locator(".task-pill")).toHaveText("Готово");

  // «Вернуть в работу» and «Поставил(а) я» in «Важные».
  await authorCard.getByRole("button", { name: "Вернуть в работу" }).click();
  await expect(card.locator(".task-pill")).toHaveText("Открыта");
  await author.goto("/important?tab=waiting&kind=tasks&role=authored");
  await expect(author.locator(".task-row", { hasText: title })).toBeVisible();

  // «Сделать задачей» from Igor's message.
  await openChat(author, chat.id, text);
  const row = author.locator(".message", { hasText: text }).first();
  await row.hover();
  await row.getByRole("button", { name: "Действия с сообщением" }).click();
  await author.getByRole("menuitem", { name: "Сделать задачей" }).click();
  const fromMessage = author.getByRole("dialog", { name: "Новая задача" });
  await expect(fromMessage.getByLabel("Что сделать")).toHaveValue(text);
  await fromMessage.getByRole("radio", { name: new RegExp(igor.name) }).click();
  await fromMessage.getByRole("button", { name: "Создать задачу" }).click();
  await expect(fromMessage).toHaveCount(0);
  const linked = author.locator(".task-card", { hasText: text });
  await expect(linked.locator(".task-card__source")).toHaveText(
    `из сообщения ${igor.name}: «${text}»`,
  );
  // Igor gets it in «Ждут вас».
  await helper.goto("/important?tab=waiting&kind=tasks");
  await expect(helper.locator(".task-row", { hasText: text })).toBeVisible();
});

test("a department queue: the first candidate takes it, the other loses it", async ({
  browser,
}) => {
  skipWithoutTasks();
  const anna = await owner();
  const oleg = await member(anna, `Олег ${run}о`, "olego");
  const igor = await member(anna, `Игорь ${run}о`, "igoro");
  const team = `Зал ${run}о`;
  await api(anna, "/org/departments", {
    body: {
      name: team,
      members: [
        { actor_id: oleg.id, primary: true },
        { actor_id: igor.id, primary: true },
      ],
    },
    expect: 201,
  });
  const chat = await api<{ id: string }>(anna, "/chats", {
    body: {
      kind: "group",
      visibility: "private",
      name: `Смена ${run}о`,
      member_ids: [oleg.id, igor.id],
    },
  });
  const text = `Смена началась ${run}`;
  await api(anna, `/chats/${chat.id}/messages`, {
    body: { client_msg_id: crypto.randomUUID(), body: text, body_format: "plain" },
  });

  // The owner may address groups: the department segment is there.
  const author = await livePage(browser);
  await signIn(author, anna);
  await openChat(author, chat.id, text);
  await author.getByRole("button", { name: "Добавить", exact: true }).click();
  await author.getByRole("menuitem", { name: /Задача/ }).click();
  const dialog = author.getByRole("dialog", { name: "Новая задача" });
  const title = `Проветрить зал ${run}`;
  await dialog.getByLabel("Что сделать").fill(title);
  await dialog.getByRole("radio", { name: "Отдел" }).click();
  await dialog.getByRole("combobox").selectOption({ label: team });
  await expect(dialog.getByText("Увидят 2 человека в этом чате, возьмёт первый")).toBeVisible();
  await dialog.getByRole("button", { name: "Создать задачу" }).click();
  await expect(dialog).toHaveCount(0);
  const authorCard = author.locator(".task-card", { hasText: title });
  await expect(authorCard).toContainText(`Отдел «${team}»`);

  const second = await livePage(browser);
  await signIn(second, igor);
  await second.goto("/important?tab=waiting&kind=tasks");
  const waiting = second.locator(".task-row", { hasText: title });
  await expect(waiting).toBeVisible();

  const first = await livePage(browser);
  await signIn(first, oleg);
  await openChat(first, chat.id, text);
  const card = first.locator(".task-card", { hasText: title });
  await card.getByRole("button", { name: "Взять себе" }).click();
  await expect(card).toContainText("Вы · отвечает");
  await expect(authorCard).toContainText(`${oleg.name} · отвечает`);
  // Igor's «Ждут вас» loses it without a reload.
  await expect(waiting).toHaveCount(0);
});

test("the slot shares pinned, tasks and scheduled in one line", async ({ browser }) => {
  skipWithoutTasks();
  const anna = await owner();
  const oleg = await member(anna, `Олег ${run}с`, "olegs");
  const chat = await api<{ id: string }>(anna, "/chats", {
    body: {
      kind: "group",
      visibility: "private",
      name: `Слот ${run}`,
      member_ids: [oleg.id],
    },
  });
  const pinned = await api<{ id: string }>(anna, `/chats/${chat.id}/messages`, {
    body: {
      client_msg_id: crypto.randomUUID(),
      body: `Ключи на стойке ${run}`,
      body_format: "plain",
    },
  });
  await api(anna, `/messages/${pinned.id}/pin`, { method: "PUT" });
  await api(anna, `/chats/${chat.id}/tasks`, {
    body: {
      client_msg_id: crypto.randomUUID(),
      title: `Задача без срока ${run}`,
      assignee: { kind: "person", actor_id: anna.id },
      remind_before_due: false,
    },
  });
  await api(anna, `/chats/${chat.id}/scheduled-messages`, {
    body: {
      client_msg_id: crypto.randomUUID(),
      body: `Отложенное ${run}`,
      body_format: "plain",
      send_at: new Date(Date.now() + 2 * 86_400_000).toISOString(),
    },
  });
  const page = await livePage(browser);
  await signIn(page, anna);
  await openChat(page, chat.id, `Ключи на стойке ${run}`);
  const slot = page.locator(".chat-slot");
  await expect(slot).toHaveAttribute("data-slot-kind", "pinned");
  await expect(slot).toContainText(`Ключи на стойке ${run}`);
  await slot.getByRole("button", { name: "Задачи: 1" }).click();
  await expect(slot).toContainText(`Задача без срока ${run}`);
  await expect(slot).toContainText("на вас 1");
  await slot.getByRole("button", { name: "Отложено: 1" }).click();
  await expect(slot).toContainText(`Отложенное ${run}`);
});
