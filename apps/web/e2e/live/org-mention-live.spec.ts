import { expect, test } from "@playwright/test";
import {
  api,
  livePage,
  member,
  owner,
  run,
  signIn,
  skipWithoutS2,
} from "./liveApi";

// Plan check org-mention.spec.ts on a real server (needs S2): @department
// in the suggestions, sending it, the mentioned member of the department in
// the chat gets a mention count, the member outside the chat gets nothing,
// the author sees «Уведомлен 1 человек».
test.skip(() => test.info().project.name === "phone", "Live run on desktop");

test("@department notifies only its people in this chat", async ({ browser }) => {
  skipWithoutS2();
  const anna = await owner();
  const inChat = await member(anna, `Олег ${run}м`, "olegm");
  const outside = await member(anna, `Борис ${run}м`, "borism");
  const team = `Зал ${run}`;
  const created = await api<{ department: { id: string } }>(anna, "/org/departments", {
    body: {
      name: team,
      members: [
        { actor_id: inChat.id, primary: true },
        { actor_id: outside.id, primary: true },
      ],
    },
    expect: 201,
  });
  const chat = await api<{ id: string }>(anna, "/chats", {
    body: {
      kind: "group",
      visibility: "private",
      name: `Планёрка ${run}`,
      member_ids: [inChat.id],
    },
  });

  const author = await livePage(browser);
  await signIn(author, anna);
  await author.goto(`/chat/${chat.id}`);
  const composer = author.getByRole("textbox", { name: /Сообщение|Напишите/ });
  // A space ends the mention query: type the first word only.
  await composer.fill(`@${team.split(" ")[0]}`);
  const menu = author.getByRole("menu", { name: "Участники" });
  await expect(
    menu.getByRole("menuitem", {
      name: new RegExp(`@${team}\\s*1 человек из отдела в этом чате`),
    }),
  ).toBeVisible();
  await menu.getByRole("menuitem", { name: new RegExp(`@${team}`) }).click();
  await composer.pressSequentially("завтра в 8:30 планёрка");
  await composer.press("Enter");
  await expect(
    author.getByText(`Уведомлён 1 человек из отдела «${team}» · видно только вам`),
  ).toBeVisible();

  // The member in the chat has a mention; the one outside has nothing.
  const unread = await api<{
    chats: { chat_id: string; mention_count: number }[];
  }>(inChat, "/unread");
  expect(
    unread.chats.find((item) => item.chat_id === chat.id)?.mention_count,
  ).toBe(1);
  const reader = await livePage(browser);
  await signIn(reader, inChat);
  await reader.goto("/chats");
  await expect(
    reader.locator(".chat-row", { hasText: `Планёрка ${run}` }).locator(".chat-row__time--mention"),
  ).toBeVisible();
  const other = await api<{ chats: { id: string }[] }>(outside, "/chats");
  expect(other.chats.map((item) => item.id)).not.toContain(chat.id);
  const messages = await api<{
    messages: { mentioned_department_ids?: string[]; mentioned_actor_ids: string[] }[];
  }>(anna, `/chats/${chat.id}/messages`);
  const sent = messages.messages.at(-1)!;
  expect(sent.mentioned_department_ids).toEqual([created.department.id]);
  expect(sent.mentioned_actor_ids).toEqual([inChat.id]);
});
