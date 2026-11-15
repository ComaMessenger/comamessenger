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
 * «Отсутствую» on a real server (phase 6.7 wave 4, package A): Anna goes on
 * a trip with an auto-reply and Marina as the substitute; Oleg sees it in
 * their direct chat, gets the auto-reply once, is warned when mentioning
 * Anna in a group and finds her under «Отсутствуют». Needs the A server
 * package on the stand: set COMA_LIVE_AWAY=1 next to COMA_LIVE_API.
 */
const skipWithoutAway = () => {
  skipWithoutServer();
  test.skip(!process.env.COMA_LIVE_AWAY, "COMA_LIVE_AWAY is not set: no away status on the stand");
};
test.skip(() => test.info().project.name === "phone", "Live run on desktop");
test.describe.configure({ mode: "serial" });

async function openStatus(page: Page, name: string) {
  await page.goto("/chats");
  await page.getByRole("button", { name: new RegExp(name) }).first().click();
  await page
    .getByRole("menu", { name: "Меню профиля" })
    .getByRole("menuitem")
    .filter({ hasText: /Установить статус…|На выезде/ })
    .click();
  const dialog = page.getByRole("dialog", { name: "Статус" });
  await expect(dialog).toBeVisible();
  return dialog;
}

test("a trip with an auto-reply and a substitute, seen by a colleague, then cleared", async ({
  browser,
}) => {
  skipWithoutAway();
  const boss = await owner();
  // Real Russian names: the slot and the hints decline them («Вместо Анны»).
  const anna = await member(boss, "Анна Белова", "annaw", `Инструктор ${run}`);
  const marina = await member(boss, "Марина Соколова", "marinaw");
  const oleg = await member(boss, "Олег Чернов", "olegw");
  const group = await api<{ id: string }>(oleg, "/chats", {
    body: {
      kind: "group",
      visibility: "private",
      name: `Бассейн ${run}`,
      member_ids: [anna.id, marina.id],
    },
  });
  const direct = await api<{ id: string }>(oleg, "/chats", {
    body: {
      kind: "direct",
      visibility: "private",
      name: "",
      topic: "",
      member_ids: [anna.id],
    },
  });

  // Anna: Status → «Отсутствую», a trip until tomorrow, Marina instead.
  const away = await livePage(browser);
  await signIn(away, anna);
  const dialog = await openStatus(away, anna.name);
  await dialog.getByRole("radio", { name: /На выезде/ }).click();
  await dialog.getByRole("radio", { name: "завтра", exact: true }).click();
  await dialog.getByRole("button", { name: /Выбрать…/ }).click();
  await away.getByRole("option", { name: /Марина Соколова/ }).click();
  const text = dialog.getByLabel("Текст автоответа");
  await expect(text).toHaveValue(/На выезде|на выезде/);
  await expect(text).toHaveValue(/Марине Соколовой/);
  const reply = await text.inputValue();
  await dialog.getByRole("button", { name: "Сохранить" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(away.getByText("Статус установлен — его видят коллеги")).toBeVisible();

  // Oleg: the direct chat says she is away, the slot offers Marina.
  const peer = await livePage(browser);
  await signIn(peer, oleg);
  await peer.goto(`/chat/${direct.id}`);
  await expect(
    peer.locator(".conversation-head [data-testid=conversation-status]"),
  ).toContainText("🚗 на выезде до");
  const slot = peer.locator(".chat-slot");
  await expect(slot).toHaveAttribute("data-slot-kind", "away");
  await expect(slot).toContainText("Вместо Анны — Марина Соколова");

  // One auto-reply per period, marked, however many messages come.
  const field = peer.locator(".composer textarea");
  await field.fill(`Подменишь в среду в бассейне? ${run}`);
  await field.press("Enter");
  const tag = peer.locator(".message-feed .auto-reply-tag");
  await expect(tag).toHaveCount(1, { timeout: 15_000 });
  await expect(peer.locator(".message--auto-reply")).toContainText(reply.trim());
  await field.fill(`Ой, забыл, что ты на выезде ${run}`);
  await field.press("Enter");
  await expect(
    peer.locator(".message-feed").getByText(`Ой, забыл, что ты на выезде ${run}`),
  ).toBeVisible();
  await peer.waitForTimeout(3000);
  await expect(tag).toHaveCount(1);

  // A mention in the group warns and offers the substitute.
  await peer.goto(`/chat/${group.id}`);
  const groupField = peer.locator(".composer textarea");
  await groupField.click();
  await groupField.pressSequentially("@Анна");
  const menu = peer.getByRole("menu", { name: "Участники" });
  await expect(menu.getByRole("menuitem", { name: /Анна Белова/ })).toContainText(
    "на выезде до",
  );
  await menu.getByRole("menuitem", { name: /Анна Белова/ }).click();
  const hint = peer.locator(".away-hint");
  await expect(hint).toContainText("Анна на выезде до");
  await expect(hint.getByRole("button", { name: "Упомянуть Марину" })).toBeVisible();

  // «Люди → Отсутствуют» has her with the caption.
  await peer.goto("/members");
  const list = peer.locator(".directory-list");
  await list.getByRole("button", { name: "Отсутствуют" }).click();
  const row = list.locator(".directory-row--member", { hasText: `Инструктор ${run}` });
  await expect(row).toContainText(`Инструктор ${run} · на выезде до`);

  // «Снять»: colleagues see her as before, live.
  await peer.goto(`/chat/${direct.id}`);
  await expect(peer.locator(".chat-slot")).toHaveAttribute("data-slot-kind", "away");
  const again = await openStatus(away, anna.name);
  await again.getByRole("button", { name: "Снять" }).click();
  await expect(again).toHaveCount(0);
  await expect(
    peer.locator(".conversation-head [data-testid=conversation-status]"),
  ).not.toContainText("на выезде", { timeout: 15_000 });
  await expect(peer.locator('.chat-slot[data-slot-kind="away"]')).toHaveCount(0);
  for (const page of [away, peer]) await page.context().close();
});
