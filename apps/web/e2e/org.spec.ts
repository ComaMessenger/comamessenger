import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import {
  chatID,
  departments,
  initialOrg,
  mockOrg,
  people,
  positions,
} from "./orgMock";

// The org structure on the web (phase 6.5 wave 2, package W2) against a
// stateful mock server: grouping in «Участники», the tree, department and
// person cards, the settings page, @department and member permissions.
test.use({ timezoneId: "Europe/Moscow", locale: "ru-RU" });

const isPhone = () => test.info().project.name === "phone";
const shot = { animations: "disabled" as const };
/** Toasts leave on their own timer; screenshots wait for them to go. */
async function noToasts(page: Page) {
  await expect(page.locator(".toast-stack")).toHaveCount(0, { timeout: 8000 });
}

async function openMembers(page: Page, view?: "По отделам" | "Структура") {
  await page.goto("/members");
  await expect(page.getByText(/6 человек · 4 отдела/)).toBeVisible();
  if (view) await page.getByRole("radio", { name: view }).click();
}

/** Moves inside the single-page app without reloading it. */
async function spaNavigate(page: Page, to: string) {
  await page.evaluate((path) => {
    window.history.pushState({}, "", path);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, to);
}

for (const theme of ["light", "dark"] as const) {
  test(`people by department, the tree and the cards (${theme})`, async ({
    page,
  }) => {
    await mockOrg(page, { theme });
    await openMembers(page, "По отделам");
    const list = page.locator(".directory-list");
    // The lead first with «рук.», additional members with «совм.».
    const gym = list.locator(".org-group-section", {
      has: page.getByRole("button", { name: "Открыть отдел «Зал ЛФК»" }),
    });
    await expect(gym.locator(".directory-member__name")).toHaveText([
      "Олег Смирнов",
      "Борис Кузнецов",
      "Кирилл Орлов",
    ]);
    await expect(gym.locator(".org-mark")).toHaveText(["рук.", "совм."]);
    // «Без отдела» last, agents apart.
    await expect(
      list.locator(".org-group-section").nth(-2).locator(".org-group strong"),
    ).toHaveText("Без отдела");
    await expect(
      list.locator(".org-group-section").last().locator(".org-group strong"),
    ).toHaveText("Агенты");
    await expect(page.locator(".directory-list")).toHaveScreenshot(
      `members-by-department-${theme}.png`,
      shot,
    );

    // A department chip narrows to it and its subdepartments.
    await page.getByRole("button", { name: "Реабилитация", exact: true }).click();
    await expect(list.locator(".org-group strong")).toHaveText([
      "Реабилитация",
      "Бассейн",
      "Зал ЛФК",
    ]);
    await page.getByRole("button", { name: "Все", exact: true }).click();

    // Search by position and department turns into a flat list.
    await page.getByRole("searchbox").fill("инструктор");
    await expect(list.locator(".directory-member__name")).toHaveText([
      "Олег Смирнов",
      "Борис Кузнецов",
    ]);
    await page.getByRole("searchbox").fill("бассейн");
    await expect(list.locator(".directory-member__name")).toHaveText([
      "Кирилл Орлов",
    ]);
    await expect(list.locator(".directory-row__meta")).toHaveText(
      "Тренер по плаванию · Реабилитация › Бассейн",
    );
    await page.getByRole("searchbox").fill("");

    // The department card from the group header.
    await page.getByRole("button", { name: "Открыть отдел «Зал ЛФК»" }).click();
    await expect(page).toHaveURL(
      new RegExp(`/members/departments/${departments.gym}$`),
    );
    const card = page.locator(".org-card");
    await expect(card.getByRole("heading", { name: "Зал ЛФК" })).toBeVisible();
    await expect(card.getByText("Реабилитация · 3 сотрудника")).toBeVisible();
    await expect(card.getByRole("heading", { name: "Сотрудники · 2" })).toBeVisible();
    await expect(card).toHaveScreenshot(`department-card-${theme}.png`, shot);
    const axe = await new AxeBuilder({ page })
      .include(".org-card")
      .disableRules(["color-contrast"])
      .analyze();
    expect(axe.violations).toEqual([]);

    // Up the structure: «Входит в», then the lead's card.
    await card.getByRole("button", { name: /Реабилитация\s*входит в/ }).click();
    await expect(card.getByRole("heading", { name: "Реабилитация" })).toBeVisible();
    await expect(card.getByRole("heading", { name: "Подотделы · 2" })).toBeVisible();
    await card.getByRole("button", { name: /Анна Петрова/ }).click();
    await expect(page).toHaveURL(new RegExp(`/members/${people.anna}$`));

    // The person card: position, departments, manager, reports.
    await spaNavigate(page, `/members/${people.cyril}`);
    const profile = page.locator(".member-profile");
    await expect(profile.getByRole("heading", { name: "Оргструктура" })).toBeVisible();
    await expect(profile.getByRole("button", { name: /Бассейн\s*рук\./ })).toBeVisible();
    await expect(profile.getByRole("button", { name: /Зал ЛФК\s*совм\./ })).toBeVisible();
    await expect(
      profile.getByRole("button", { name: /Анна Петрова\s*руководитель/ }),
    ).toBeVisible();
    await expect(profile).toHaveScreenshot(`person-card-${theme}.png`, shot);
    await spaNavigate(page, `/members/${people.anna}`);
    await expect(profile.locator(".org-card__position")).toHaveText(
      "ДолжностьВрач",
    );
    await expect(profile.getByRole("heading", { name: "Подчинённые · 3" })).toBeVisible();
    // The caption stays under the name when it differs from the position.
    await expect(profile.getByText(/Главный врач/)).toBeVisible();

    // The tree.
    await spaNavigate(page, "/members");
    await page.getByRole("radio", { name: "Структура" }).click();
    const tree = page.getByRole("tree");
    await expect(tree.getByRole("treeitem")).toHaveCount(4);
    if (!isPhone())
      await expect(page.locator(".directory-list")).toHaveScreenshot(
        `org-tree-${theme}.png`,
        shot,
      );
    await tree.getByRole("treeitem", { name: /Реабилитация/ }).focus();
    await page.keyboard.press("ArrowLeft");
    await expect(tree.getByRole("treeitem")).toHaveCount(2);
    await page.keyboard.press("ArrowRight");
    await expect(tree.getByRole("treeitem")).toHaveCount(4);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(
      new RegExp(`/members/departments/${departments.pool}$`),
    );
  });
}

test("a change on the server shows up without reloading (org.updated)", async ({
  page,
}) => {
  const api = await mockOrg(page, { viewer: people.boris, role: "member" });
  await openMembers(page, "По отделам");
  await expect(
    page.getByRole("button", { name: "Открыть отдел «Массаж»" }),
  ).toHaveCount(0);
  // Someone else created «Массаж» with Нина and Ксения in it.
  api.state.departments.push({
    id: "10000000-0000-4000-8000-000000000099",
    parent_id: departments.rehab,
    name: "Массаж",
    lead_actor_id: people.nina,
    chat_id: null,
    has_chat: false,
    chat_archived: false,
    sort_key: null,
    version: 1,
  });
  api.state.memberships.push(
    { actor: people.nina, department: "10000000-0000-4000-8000-000000000099", primary: true, at: 90 },
    { actor: people.xenia, department: "10000000-0000-4000-8000-000000000099", primary: true, at: 91 },
  );
  api.state.version += 1;
  await api.emit({
    op: "event",
    seq: 50,
    type: "org.updated",
    occurred_at: "2026-11-11T07:15:00Z",
    actor_id: people.anna,
    chat_id: null,
    subject_id: null,
    data: { version: api.state.version, reason: "department" },
  });
  await expect(
    page.getByRole("button", { name: "Открыть отдел «Массаж»" }),
  ).toBeVisible();
  await expect(page.getByText("6 человек · 5 отделов")).toBeVisible();
  // Nobody is left without a department.
  await expect(
    page.locator(".org-group strong", { hasText: "Без отдела" }),
  ).toHaveCount(0);
  // A member reads, but neither edits nor creates the chat.
  await page.getByRole("button", { name: "Открыть отдел «Массаж»" }).click();
  await expect(page.getByRole("button", { name: /Изменить/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Создать чат отдела/ })).toHaveCount(0);
});

test("the administrator builds the structure in settings", async ({ page }) => {
  test.skip(isPhone(), "Settings editing is checked on desktop");
  const api = await mockOrg(page, { org: initialOrg({ empty: true }) });
  await page.goto("/settings/workspace/org");
  await expect(page.getByText("Создайте первый отдел")).toBeVisible();

  // «Реабилитация» with Анна as the lead.
  await page.getByRole("button", { name: "Отдел", exact: true }).click();
  await page.getByRole("textbox", { name: "Название" }).fill("Реабилитация");
  const people_ = page.locator(".org-editor__people");
  await people_.locator(".org-person-row", { hasText: "Анна Петрова" }).click();
  await page.getByRole("button", { name: /^Руководитель/ }).click();
  await page.getByRole("option", { name: "Анна Петрова" }).click();
  await page.getByRole("button", { name: "Создать отдел" }).click();
  await expect(page.getByText("Отдел «Реабилитация» создан")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Реабилитация" })).toBeVisible();

  // «Зал ЛФК» inside it, Олег leads, Борис works there.
  await page.getByRole("button", { name: "Отдел", exact: true }).click();
  await page.getByRole("textbox", { name: "Название" }).fill("Зал ЛФК");
  await page.getByRole("button", { name: /^Входит в/ }).click();
  await page.getByRole("option", { name: "Реабилитация" }).click();
  await people_.locator(".org-person-row", { hasText: "Олег Смирнов" }).click();
  await people_.locator(".org-person-row", { hasText: "Борис Кузнецов" }).click();
  await page.getByRole("button", { name: /^Руководитель/ }).click();
  await page.getByRole("option", { name: "Олег Смирнов" }).click();
  await page.getByRole("button", { name: "Создать отдел" }).click();
  await expect(page.getByRole("heading", { name: "Зал ЛФК" })).toBeVisible();
  const created = api.writes.filter((write) => write.path === "/org/departments");
  expect(created[1]!.body).toEqual({
    name: "Зал ЛФК",
    parent_id: api.state.departments[0]!.id,
    lead_actor_id: people.oleg,
    members: [
      { actor_id: people.oleg, primary: true },
      { actor_id: people.boris, primary: true },
    ],
  });
  await expect(page.locator(".org-settings__tree")).toContainText(
    "Олег Смирнов · 2 чел.",
  );

  // Positions: one by hand, «Врач» from the captions with its people.
  await page.getByRole("tab", { name: "Должности" }).click();
  await page.getByRole("textbox", { name: "Новая должность" }).fill("Инструктор ЛФК");
  await page.getByRole("button", { name: "Добавить", exact: true }).click();
  await expect(page.locator(".org-positions__list")).toContainText("Инструктор ЛФК");
  const suggestions = page.locator(".org-suggestions");
  await suggestions
    .locator(".org-check")
    .filter({ has: page.getByText("Врач", { exact: true }) })
    .click();
  await suggestions.getByRole("button", { name: /Создать должности · 1/ }).click();
  await expect(page.locator(".org-positions__list")).toContainText("Врач");
  expect(api.writes.at(-1)).toMatchObject({
    path: "/org/people/assign",
    body: { actor_ids: [people.nina] },
  });
  await noToasts(page);
  await page.mouse.move(0, 0);
  await expect(page.locator(".settings-page__body")).toHaveScreenshot(
    "settings-positions.png",
    shot,
  );

  // Mass assignment of people without a department.
  await page.getByRole("tab", { name: /Без отдела · 4/ }).click();
  await page.locator(".org-check--all").click();
  await expect(page.getByText("Выбрано: 4")).toBeVisible();
  await page.getByRole("button", { name: /^Назначить отдел Отдел…/ }).click();
  await page.getByRole("option", { name: "Реабилитация", exact: true }).click();
  await page.getByRole("button", { name: "Назначить отдел", exact: true }).click();
  await expect(page.getByText("Назначено 4 людям")).toBeVisible();
  await expect(page.getByText("Все распределены по отделам")).toBeVisible();
  await expect(page.getByRole("tab", { name: "Без отдела · 0" })).toBeVisible();
});

for (const theme of ["light", "dark"] as const)
  test(`settings: editor, «Выше / Ниже» and deleting with a transfer (${theme})`, async ({
    page,
  }) => {
    test.skip(isPhone(), "Settings editing is checked on desktop");
    const api = await mockOrg(page, { theme });
    await page.goto("/settings/workspace/org");
    await page.getByRole("button", { name: /^Зал ЛФК/ }).click();
    const editor = page.locator(".org-editor");
    await expect(editor.getByRole("heading", { name: "Зал ЛФК" })).toBeVisible();
    await expect(page.locator(".settings-page__body")).toHaveScreenshot(
      `settings-departments-${theme}.png`,
      shot,
    );
    if (theme === "dark") return;

    // Order among siblings.
    await editor.getByRole("button", { name: "Действия с отделом" }).click();
    await expect(page.getByRole("menuitem", { name: "Ниже" })).toBeDisabled();
    await page.getByRole("menuitem", { name: "Выше" }).click();
    await expect(page.locator(".org-settings__item strong")).toHaveText([
      "Администрация",
      "Реабилитация",
      "Зал ЛФК",
      "Бассейн",
    ]);

    // A lead from outside joins as an additional member.
    await editor.getByRole("button", { name: /^Руководитель/ }).click();
    await page.getByRole("option", { name: "Нина Соколова · не в отделе" }).click();
    await expect(editor.getByText(/войдёт в отдел дополнительным/)).toBeVisible();
    await editor.getByRole("button", { name: "Сохранить" }).click();
    await expect(page.getByText("Изменения сохранены")).toBeVisible();
    await expect(
      editor.locator(".org-person-row", { hasText: "Нина Соколова" }),
    ).toContainText("рук.");

    // Delete, sending its people to «Администрация».
    await editor.getByRole("button", { name: "Действия с отделом" }).click();
    await page.getByRole("menuitem", { name: "Удалить отдел" }).click();
    const dialog = page.getByRole("dialog", { name: "Удалить отдел «Зал ЛФК»?" });
    await dialog.getByRole("button", { name: /^Куда перевести/ }).click();
    await page.getByRole("option", { name: "Администрация" }).click();
    await dialog.getByRole("button", { name: "Удалить отдел" }).click();
    await expect(page.getByText("Отдел «Зал ЛФК» удалён")).toBeVisible();
    expect(api.writes.at(-1)).toMatchObject({
      method: "DELETE",
      path: `/org/departments/${departments.gym}`,
    });
    await expect(page.locator(".org-settings__item strong")).toHaveText([
      "Администрация",
      "Реабилитация",
      "Бассейн",
    ]);
    await page.goto("/members");
    await page.getByRole("radio", { name: "По отделам" }).click();
    const office = page.locator(".org-group-section", {
      has: page.getByRole("button", { name: "Открыть отдел «Администрация»" }),
    });
    await expect(office.locator(".directory-member__name")).toContainText([
      "Елена Волкова",
      "Борис Кузнецов",
      "Олег Смирнов",
    ]);
  });

test("the department chat: create, then add the people missing from it", async ({
  page,
}) => {
  const api = await mockOrg(page, { viewer: people.oleg, role: "member" });
  await page.goto(`/members/departments/${departments.gym}`);
  await page.getByRole("button", { name: "Создать чат отдела" }).click();
  await expect(page).toHaveURL(/\/chat\//);
  // A new person joins the department later.
  api.state.memberships.push({
    actor: people.xenia,
    department: departments.gym,
    primary: true,
    at: 99,
  });
  api.state.version += 1;
  await page.goto(`/members/departments/${departments.gym}`);
  const missing = page.locator(".org-card__missing");
  await expect(missing).toContainText("В чате нет 1 сотрудника отдела");
  await missing.getByRole("button", { name: "Добавить" }).click();
  await expect(page.getByText("Добавлен 1 человек")).toBeVisible();
  await expect(missing).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Чат отдела" })).toBeVisible();
});

for (const theme of ["light", "dark"] as const)
  test(`@department in the composer and the author's note (${theme})`, async ({
    page,
  }) => {
    const api = await mockOrg(page, { theme });
    await page.goto(`/chat/${chatID}`);
    const composer = page.getByRole("textbox", { name: /Сообщение|Напишите/ });
    await composer.fill("@за");
    const menu = page.getByRole("menu", { name: "Участники" });
    await expect(menu.getByText("Отделы")).toBeVisible();
    await expect(
      menu.getByRole("menuitem", { name: /@Зал ЛФК\s*3 человека из отдела в этом чате/ }),
    ).toBeVisible();
    // «Администрация» has nobody in this chat: not offered.
    await composer.fill("@");
    await expect(menu.getByRole("menuitem", { name: /@Администрация/ })).toHaveCount(0);
    await expect(menu).toHaveScreenshot(`mention-menu-${theme}.png`, shot);
    await composer.fill("@за");
    await menu.getByRole("menuitem", { name: /@Зал ЛФК/ }).click();
    await composer.pressSequentially("завтра в 8:30 планёрка");
    await composer.press("Enter");
    await expect(
      page.getByText("Уведомлены 3 человека из отдела «Зал ЛФК» · видно только вам"),
    ).toBeVisible();
    expect(api.sent.at(-1)).toMatchObject({
      body: `@[Зал ЛФК](${departments.gym}) завтра в 8:30 планёрка`,
      mentioned_department_ids: [departments.gym],
      mentioned_actor_ids: [],
    });
  });

test("member permissions one by one in «Участники и доступ»", async ({ page }) => {
  test.skip(isPhone(), "Checked on desktop");
  const api = await mockOrg(page, {
    viewer: people.elena,
    role: "admin",
    permissions: ["members.manage", "org.manage"],
  });
  await page.goto("/settings/workspace/members");
  await page
    .locator(".organization-member", { hasText: "Борис Кузнецов" })
    .getByRole("button", { name: "Управление участником" })
    .click();
  const dialog = page.getByRole("dialog");
  const permissions = dialog.locator("fieldset", { hasText: "Права участника" });
  // Elena holds org.manage, not the other two: decision 15.
  await expect(permissions.getByRole("checkbox")).toHaveCount(3);
  await expect(permissions.getByRole("checkbox", { name: /Вести оргструктуру/ })).toBeEnabled();
  await expect(
    permissions.getByRole("checkbox", { name: /Обращаться к отделам и ролям/ }),
  ).toBeDisabled();
  // Controlled by the server answer: click, then wait for the new state.
  await permissions.getByRole("checkbox", { name: /Вести оргструктуру/ }).click();
  await expect(
    permissions.getByRole("checkbox", { name: /Вести оргструктуру/ }),
  ).toBeChecked();
  await expect.poll(() => api.writes.at(-1)?.body).toEqual({
    permissions: ["org.manage"],
  });
  // The org group sets the department and the position.
  const org = dialog.locator("fieldset", { hasText: "Основной отдел" });
  await org.getByRole("button", { name: /^Должность/ }).click();
  await page.getByRole("option", { name: "Врач" }).click();
  await org.getByRole("button", { name: "Сохранить" }).click();
  await expect.poll(() => api.writes.at(-1)).toMatchObject({
    method: "PUT",
    path: `/org/people/${people.boris}`,
    body: {
      primary_department_id: departments.gym,
      additional_department_ids: [],
      position_id: positions.doctor,
    },
  });
});
