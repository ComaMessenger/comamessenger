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
 * Polls on a real server (phase 6.7 wave 4, package P): the author and two
 * colleagues in their own browser contexts, realtime between them. Needs
 * the P server package on the stand: set COMA_LIVE_POLLS=1 next to
 * COMA_LIVE_API.
 */
const skipWithoutPolls = () => {
  skipWithoutServer();
  test.skip(!process.env.COMA_LIVE_POLLS, "COMA_LIVE_POLLS is not set: no polls on the stand");
};
test.skip(() => test.info().project.name === "phone", "Live run on desktop");
test.describe.configure({ mode: "serial" });

async function openChat(page: Page, chatID: string, text: string) {
  await page.goto(`/chat/${chatID}`);
  await expect(page.locator(".message-feed").getByText(text).first()).toBeVisible();
}

const pollCard = (page: Page, question: string) =>
  page.locator(".poll-card").filter({ hasText: question });

test("an ordinary poll: create, vote, change, who voted, remind, close", async ({
  browser,
}) => {
  skipWithoutPolls();
  const anna = await owner();
  const marina = await member(anna, `Марина ${run}о`, "marinao");
  const oleg = await member(anna, `Олег ${run}о`, "olego");
  const igor = await member(anna, `Игорь ${run}о`, "igoro");
  const chat = await api<{ id: string }>(marina, "/chats", {
    body: {
      kind: "group",
      visibility: "private",
      name: `Зал ${run}о`,
      member_ids: [oleg.id, igor.id],
    },
  });
  const hello = `Давайте выберем день ${run}`;
  await api(marina, `/chats/${chat.id}/messages`, {
    body: { client_msg_id: crypto.randomUUID(), body: hello, body_format: "plain" },
  });

  // The author: «+» → «Опрос», three options, due Friday.
  const author = await livePage(browser);
  await signIn(author, marina);
  await openChat(author, chat.id, hello);
  await author.getByRole("button", { name: "Добавить", exact: true }).click();
  await author.getByRole("menuitem", { name: /Опрос/ }).click();
  const dialog = author.getByRole("dialog", { name: "Новый опрос" });
  const question = `Какой день удобнее для выезда ${run}?`;
  await dialog.getByLabel("Вопрос").fill(question);
  await dialog.getByLabel("Вариант 1", { exact: true }).fill("Вторник");
  await dialog.getByLabel("Вариант 2", { exact: true }).fill("Среда");
  await dialog.getByRole("button", { name: "Добавить вариант" }).click();
  await dialog.getByLabel("Вариант 3", { exact: true }).fill("Четверг");
  await dialog.getByRole("radio", { name: /до завтра/ }).click();
  await dialog.getByRole("button", { name: "Отправить опрос" }).click();
  await expect(dialog).toHaveCount(0);
  const mine = pollCard(author, question);
  await expect(mine).toContainText("0 из 3 ответили");

  // A colleague sees no counts before the vote, votes, changes the vote.
  const voter = await livePage(browser);
  await signIn(voter, oleg);
  await openChat(voter, chat.id, question);
  const card = pollCard(voter, question);
  await expect(card.getByRole("radio")).toHaveCount(3);
  await expect(card).not.toContainText("%");
  await card.getByRole("radio", { name: "Среда" }).click();
  await expect(card.getByRole("radio", { name: "Среда: 100 %" })).toBeVisible();
  await expect(card).toContainText("1 из 3 ответили");
  await card.getByRole("radio", { name: /Четверг/ }).click();
  await expect(card.getByRole("radio", { name: "Четверг: 100 %" })).toBeVisible();

  // The third one still sees no counts; the author sees them live.
  const third = await livePage(browser);
  await signIn(third, igor);
  await openChat(third, chat.id, question);
  const thirdCard = pollCard(third, question);
  await expect(thirdCard).toContainText("1 из 3 ответили");
  await expect(thirdCard).not.toContainText("%");
  await expect(mine.getByRole("radio", { name: "Четверг: 100 %" })).toBeVisible();
  // «Напомнить не ответившим»: the third one has not voted yet.
  await mine.getByRole("button", { name: /Напомнить не ответившим · 1/ }).click();
  await expect(author.getByText("Напомнили 1 человеку")).toBeVisible();
  await expect(mine).toContainText("Напомнили · повторно");

  // «Ждут вас → Опросы» for the third one: vote right in the list.
  await third.goto("/important?tab=waiting&kind=polls");
  const item = third.getByRole("article", { name: `Опрос · ${marina.name}` });
  await expect(item).toContainText(question);
  await item.getByRole("radio", { name: "Вторник" }).click();
  await expect(item).toHaveCount(0);

  // The author: who voted (names by option, nobody waits), close, result.
  await expect(mine).toContainText("2 из 3 ответили");
  await mine.getByRole("button", { name: "Кто голосовал" }).click();
  const voters = author.getByRole("dialog", { name: "Кто голосовал" });
  await expect(voters.getByRole("tab", { name: /Четверг · 1/ })).toBeVisible();
  await voters.getByRole("tab", { name: /Четверг/ }).click();
  await expect(voters.locator(".poll-voters__row")).toHaveText([new RegExp(oleg.name)]);
  await voters.getByRole("tab", { name: /Не ответили/ }).click();
  await expect(voters.locator(".poll-voters__row")).toHaveText([new RegExp(marina.name)]);
  await author.keyboard.press("Escape");
  // The question edited: «изм.» for everyone.
  const row = author.locator(".message", { has: mine });
  await row.hover();
  await row.getByRole("button", { name: "Действия с сообщением" }).click();
  await author.getByRole("menuitem", { name: "Редактировать" }).click();
  const edit = author.getByRole("dialog", { name: "Изменить вопрос" });
  const edited = `Какой день лучше для выезда в декабре ${run}?`;
  await edit.getByLabel("Вопрос").fill(edited);
  await edit.getByRole("button", { name: "Сохранить" }).click();
  await expect(edit).toHaveCount(0);
  const mineEdited = pollCard(author, edited);
  await expect(mineEdited).toContainText("изм.");
  await expect(pollCard(voter, edited)).toContainText("изм.");
  await mineEdited.getByRole("button", { name: "Закрыть" }).click();
  await author
    .getByRole("dialog", { name: "Закрыть опрос?" })
    .getByRole("button", { name: "Закрыть" })
    .click();
  await expect(mineEdited).toContainText("Закрыт");
  await expect(mineEdited).toContainText(/Итог: «(Вторник|Четверг)», «(Вторник|Четверг)» — по 1 из 2/);
  // Realtime: the colleague sees the result and cannot vote any more.
  const closed = pollCard(voter, edited);
  await expect(closed).toContainText("Закрыт");
  await expect(closed.getByRole("radio")).toHaveCount(0);
  await expect(closed.getByRole("button", { name: "Отменить голос" })).toHaveCount(0);
  for (const page of [author, voter, third]) await page.context().close();
});

test("an anonymous poll: the vote is final, names stay hidden", async ({ browser }) => {
  skipWithoutPolls();
  const anna = await owner();
  const marina = await member(anna, `Марина ${run}а`, "marinaa");
  const oleg = await member(anna, `Олег ${run}а`, "olega");
  const chat = await api<{ id: string }>(marina, "/chats", {
    body: {
      kind: "group",
      visibility: "private",
      name: `Анонимно ${run}`,
      member_ids: [oleg.id],
    },
  });
  const question = `Как вам новая разминка ${run}?`;
  await api(marina, `/chats/${chat.id}/polls`, {
    body: {
      client_msg_id: crypto.randomUUID(),
      question,
      options: ["Нравится", "Не нравится"],
      multiple: false,
      anonymous: true,
    },
  });
  const voter = await livePage(browser);
  await signIn(voter, oleg);
  await openChat(voter, chat.id, question);
  const card = pollCard(voter, question);
  await expect(card).toContainText("Анонимно · голос нельзя изменить");
  await card.getByRole("radio", { name: "Не нравится" }).click();
  await expect(card.getByRole("img", { name: "Не нравится: 100 %" })).toBeVisible();
  await expect(card.getByRole("img", { name: "Ваш выбор" })).toHaveCount(1);
  await expect(card.getByRole("button", { name: "Отменить голос" })).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Кто голосовал" })).toHaveCount(0);

  const author = await livePage(browser);
  await signIn(author, marina);
  await openChat(author, chat.id, question);
  const mine = pollCard(author, question);
  await expect(mine).toContainText("1 из 2 ответили");
  await expect(mine.getByRole("radio", { name: "Не нравится: 100 %" })).toBeVisible();
  await expect(mine.getByRole("button", { name: "Кто голосовал" })).toHaveCount(0);
  await expect(mine.locator(".poll-option__faces")).toHaveCount(0);
  for (const page of [author, voter]) await page.context().close();
});
