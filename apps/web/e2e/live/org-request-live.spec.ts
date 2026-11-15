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

// Plan check org-request.spec.ts on a real server (needs S2): without the
// right there are no group segments; the owner grants it in «Участники и
// доступ»; the member sends a request to a department; the card says
// «отдел «…»».
test.skip(() => test.info().project.name === "phone", "Live run on desktop");

test("a request to a department after the owner grants the right", async ({
  browser,
}) => {
  skipWithoutS2();
  const anna = await owner();
  const author = await member(anna, `Марина ${run}з`, "marinaz");
  const oleg = await member(anna, `Олег ${run}з`, "olegz");
  const team = `Зал ${run}з`;
  await api(anna, "/org/departments", {
    body: { name: team, members: [{ actor_id: oleg.id, primary: true }] },
    expect: 201,
  });
  const chat = await api<{ id: string }>(author, "/chats", {
    body: {
      kind: "group",
      visibility: "private",
      name: `Смена ${run}`,
      member_ids: [oleg.id],
    },
  });

  const page = await livePage(browser);
  await signIn(page, author);
  const openForm = async () => {
    await page.goto(`/chat/${chat.id}`);
    await page.getByRole("button", { name: "Добавить", exact: true }).click();
    await page.getByRole("menuitem", { name: /Запрос/ }).click();
    return page.getByRole("dialog", { name: "Запрос" });
  };
  let dialog = await openForm();
  await expect(dialog.getByRole("radio", { name: "Люди" })).toBeVisible();
  await expect(dialog.getByRole("radio", { name: "Отдел" })).toHaveCount(0);

  // The owner grants the right in «Участники и доступ».
  const admin = await livePage(browser);
  await signIn(admin, anna);
  await admin.goto("/settings/workspace/members");
  await admin
    .locator(".organization-member", { hasText: author.name })
    .getByRole("button", { name: "Управление участником" })
    .click();
  const right = admin
    .getByRole("dialog")
    .getByRole("checkbox", { name: /Обращаться к отделам и ролям/ });
  await right.click();
  await expect(right).toBeChecked();

  // The author's permissions come with the next sign-in.
  await page.context().clearCookies();
  await signIn(page, author);
  dialog = await openForm();
  await dialog.getByRole("textbox", { name: "Вопрос" }).fill("Ознакомьтесь с графиком");
  await dialog.getByRole("radio", { name: "Отдел" }).click();
  await dialog
    .getByRole("radiogroup", { name: "Отдел" })
    .getByRole("radio", { name: new RegExp(`^${team}`) })
    .click();
  await dialog.getByRole("button", { name: /^Отправить запрос · 1/ }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText(`отдел «${team}»`).first()).toBeVisible();
});
