import { expect, test } from "@playwright/test";
import {
  api,
  livePage,
  member,
  owner,
  run,
  signIn,
  skipWithoutServer,
  type LiveUser,
} from "./liveApi";

// Plan check org.spec.ts on a real server: the administrator builds the
// structure in settings, a second person sees it in «Участники» through
// org.updated without reloading, the cards link up and down, a department is
// deleted with its people moved.
test.describe.configure({ mode: "serial" });
test.skip(() => test.info().project.name === "phone", "Live run on desktop");

let anna: LiveUser;
let oleg: LiveUser;
let boris: LiveUser;
let nina: LiveUser;
const rehab = `Реабилитация ${run}`;
const gym = `Зал ЛФК ${run}`;
const doctor = `Врач ${run}`;

test.beforeAll(async () => {
  if (!process.env.COMA_LIVE_API) return;
  anna = await owner();
  oleg = await member(anna, `Олег ${run}`, "oleg");
  boris = await member(anna, `Борис ${run}`, "boris");
  nina = await member(anna, `Нина ${run}`, "nina", doctor);
});

test("the structure is built in settings and reaches another person live", async ({
  browser,
}) => {
  skipWithoutServer();
  const admin = await livePage(browser);
  const viewer = await livePage(browser);
  await signIn(admin, anna);
  await signIn(viewer, oleg);

  // The second person watches «Участники».
  await viewer.goto("/members");
  await expect(viewer.getByRole("heading", { name: "Участники" })).toBeVisible();

  await admin.goto("/settings/workspace/org");
  await expect(admin.getByRole("tab", { name: "Отделы" })).toBeVisible();
  const people = admin.locator(".org-editor__people");

  // «Реабилитация» with Олег as its lead.
  await admin.getByRole("button", { name: "Отдел", exact: true }).click();
  await admin.getByRole("textbox", { name: "Название" }).fill(rehab);
  await people.getByRole("searchbox").fill(oleg.name);
  await people.locator(".org-person-row", { hasText: oleg.name }).click();
  await admin.getByRole("button", { name: /^Руководитель/ }).click();
  await admin.getByRole("option", { name: oleg.name }).click();
  await admin.getByRole("button", { name: "Создать отдел" }).click();
  await expect(admin.getByRole("heading", { name: rehab })).toBeVisible();

  // «Зал ЛФК» inside it, Борис leads.
  await admin.getByRole("button", { name: "Отдел", exact: true }).click();
  await admin.getByRole("textbox", { name: "Название" }).fill(gym);
  await admin.getByRole("button", { name: /^Входит в/ }).click();
  await admin.getByRole("option", { name: rehab, exact: true }).click();
  await people.getByRole("searchbox").fill(boris.name);
  await people.locator(".org-person-row", { hasText: boris.name }).click();
  await admin.getByRole("button", { name: /^Руководитель/ }).click();
  await admin.getByRole("option", { name: boris.name }).click();
  await admin.getByRole("button", { name: "Создать отдел" }).click();
  await expect(admin.getByRole("heading", { name: gym })).toBeVisible();

  // The viewer gets it without reloading: the view switch and the groups.
  await viewer.getByRole("radio", { name: "По отделам" }).click();
  await expect(
    viewer.getByRole("button", { name: `Открыть отдел «${gym}»` }),
  ).toBeVisible();
  const gymGroup = viewer.locator(".org-group-section", {
    has: viewer.getByRole("button", { name: `Открыть отдел «${gym}»` }),
  });
  await expect(gymGroup.locator(".directory-member__name")).toHaveText([boris.name]);
  await expect(gymGroup.locator(".org-mark")).toHaveText(["рук."]);

  // Positions from profile captions: Нина wrote «Врач …» herself.
  await admin.getByRole("tab", { name: "Должности" }).click();
  const suggestions = admin.locator(".org-suggestions");
  await suggestions
    .locator(".org-check")
    .filter({ has: admin.getByText(doctor, { exact: true }) })
    .click();
  await suggestions.getByRole("button", { name: /Создать должности · 1/ }).click();
  await expect(admin.locator(".org-positions__list")).toContainText(doctor);

  // Mass assignment of a person without a department.
  await admin.getByRole("tab", { name: /Без отдела/ }).click();
  await admin
    .locator(".org-unassigned .org-person-row", { hasText: nina.name })
    .click();
  await admin.getByRole("button", { name: /^Назначить отдел Отдел…/ }).click();
  await admin.getByRole("option", { name: rehab, exact: true }).click();
  await admin.getByRole("button", { name: "Назначить отдел", exact: true }).click();
  await expect(admin.getByText("Назначено 1 человеку")).toBeVisible();

  const rehabGroup = viewer.locator(".org-group-section", {
    has: viewer.getByRole("button", { name: `Открыть отдел «${rehab}»` }),
  });
  await expect(rehabGroup.locator(".directory-member__name")).toHaveText([
    oleg.name,
    nina.name,
  ]);

  // The tree for the viewer.
  await viewer.getByRole("radio", { name: "Структура" }).click();
  await expect(
    viewer.getByRole("treeitem", { name: new RegExp(`^${gym}, 1 чел`) }),
  ).toBeVisible();
  await expect(
    viewer.getByRole("treeitem", { name: new RegExp(`^${rehab}, 3 чел`) }),
  ).toHaveAttribute("aria-expanded", "true");

  // Cards: the department, up to its parent, to the lead and back.
  await viewer.getByRole("treeitem", { name: new RegExp(`^${gym}`) }).click();
  const card = viewer.locator(".org-card");
  await expect(card.getByRole("heading", { name: gym })).toBeVisible();
  await card.getByRole("button", { name: new RegExp(`${rehab}\\s*входит в`) }).click();
  await expect(card.getByRole("heading", { name: rehab })).toBeVisible();
  await card.getByRole("button", { name: new RegExp(oleg.name) }).first().click();
  const profile = viewer.locator(".member-profile");
  await expect(profile.getByRole("heading", { name: oleg.name })).toBeVisible();
  await expect(profile.getByRole("heading", { name: /Подчинённые · 2/ })).toBeVisible();
  await profile.getByRole("button", { name: new RegExp(`^${rehab}`) }).click();
  await expect(card.getByRole("heading", { name: rehab })).toBeVisible();

  // Nina's card: the position from the structure, her manager.
  await viewer.goto(`/members/${nina.id}`);
  await expect(profile.locator(".org-card__position")).toContainText(doctor);
  await expect(
    profile.getByRole("button", { name: new RegExp(`${oleg.name}\\s*руководитель`) }),
  ).toBeVisible();

  // Deleting «Зал ЛФК» moves Борис to «Реабилитация».
  await admin.getByRole("tab", { name: "Отделы" }).click();
  await admin.getByRole("button", { name: new RegExp(`^${gym}`) }).click();
  await admin.getByRole("button", { name: "Действия с отделом" }).click();
  await admin.getByRole("menuitem", { name: "Удалить отдел" }).click();
  const dialog = admin.getByRole("dialog", { name: `Удалить отдел «${gym}»?` });
  await expect(dialog.getByRole("button", { name: /^Куда перевести/ })).toHaveAccessibleName(
    new RegExp(rehab),
  );
  await dialog.getByRole("button", { name: "Удалить отдел" }).click();
  await expect(admin.getByText(`Отдел «${gym}» удалён`)).toBeVisible();

  await viewer.goto("/members");
  await viewer.getByRole("radio", { name: "По отделам" }).click();
  await expect(rehabGroup.locator(".directory-member__name")).toHaveText([
    oleg.name,
    boris.name,
    nina.name,
  ]);
  const structure = await api<{ departments: { name: string }[] }>(anna, "/org");
  expect(structure.departments.map((item) => item.name)).not.toContain(gym);
});

test("department chat: the lead creates it, a newcomer is added later", async ({
  browser,
}) => {
  skipWithoutServer();
  const team = `Бассейн ${run}`;
  const lead = await member(anna, `Кирилл ${run}`, "cyril");
  const first = await member(anna, `Ксения ${run}`, "xenia");
  const created = await api<{ department: { id: string } }>(anna, "/org/departments", {
    body: {
      name: team,
      lead_actor_id: lead.id,
      members: [
        { actor_id: lead.id, primary: true },
        { actor_id: first.id, primary: true },
      ],
    },
    expect: 201,
  });
  const departmentID = created.department.id;

  const page = await livePage(browser);
  await signIn(page, lead);
  await page.goto(`/members/departments/${departmentID}`);
  await page.getByRole("button", { name: "Создать чат отдела" }).click();
  await expect(page).toHaveURL(/\/chat\//);
  const chatID = new URL(page.url()).pathname.split("/").pop()!;
  const members = await api<{ members: { actor_id: string }[] }>(
    lead,
    `/chats/${chatID}/members`,
  );
  expect(members.members.map((item) => item.actor_id).sort()).toEqual(
    [lead.id, first.id].sort(),
  );

  // A newcomer joins the department after the chat was made.
  const newcomer = await member(anna, `Глеб ${run}`, "gleb");
  await api(anna, `/org/departments/${departmentID}/members/${newcomer.id}`, {
    method: "PUT",
    body: { primary: true },
  });
  await page.goto(`/members/departments/${departmentID}`);
  const missing = page.locator(".org-card__missing");
  await expect(missing).toContainText("В чате нет 1 сотрудника отдела");
  await missing.getByRole("button", { name: "Добавить" }).click();
  await expect(page.getByText("Добавлен 1 человек")).toBeVisible();
  await expect(missing).toHaveCount(0);
  const after = await api<{ members: { actor_id: string }[] }>(
    lead,
    `/chats/${chatID}/members`,
  );
  expect(after.members.map((item) => item.actor_id)).toContain(newcomer.id);

  // A plain member of the department sees the chat but cannot manage it.
  const viewer = await livePage(browser);
  await signIn(viewer, newcomer);
  await viewer.goto(`/members/departments/${departmentID}`);
  await expect(viewer.getByRole("button", { name: "Чат отдела" })).toBeVisible();
  await expect(viewer.getByRole("button", { name: "Действия с отделом" })).toHaveCount(0);
});
