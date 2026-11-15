import { expect, test, type Page } from "@playwright/test";
import {
  chatID,
  fixtures,
  ids,
  mockWorkplace,
  people,
  type TaskRecord,
} from "./workplaceMock";

test.use({ timezoneId: "Europe/Moscow", locale: "ru-RU" });

const shot = { animations: "disabled" as const };
const features = [
  "message_requests",
  "message_reminders",
  "message_tasks",
  "org_structure",
];
const queueID = "00000000-0000-4000-8000-000000000045";

/** A task for «Зал ЛФК» nobody has taken: Oleg and Igor are its candidates. */
function withQueue() {
  const data = fixtures();
  const queue: TaskRecord = {
    id: queueID,
    chat_id: chatID,
    author: people.marina.actor_id,
    title: "Проветрить большой зал перед группой",
    description: "",
    created_seq: 6,
    created_at: "2026-11-11T06:45:00Z",
    assignee: {
      kind: "department",
      actor_id: null,
      label: "Зал ЛФК",
      candidate_ids: [people.oleg.actor_id, people.igor.actor_id],
      department_id: ids.department,
    },
    status: "open",
    status_changed_at: null,
    status_changed_by: null,
    canceled_reason: null,
    due_at: "2026-11-12T09:00:00Z",
    remind_before_due: true,
    items: [],
    source_message_id: null,
    last_nudge_at: null,
    nudge_count: 0,
    version: 1,
  };
  data.tasks = [queue];
  return data;
}

async function openChat(page: Page) {
  await page.goto(`/chat/${chatID}`);
  await expect(
    page.locator(".message-feed").getByText("Маты в малом зале разложил."),
  ).toBeVisible();
}

const queueCard = (page: Page) => page.locator(`#message-${queueID} .task-card`);

for (const theme of ["light", "dark"] as const) {
  test(`the first candidate takes the queue task (${theme})`, async ({ page }) => {
    const api = await mockWorkplace(page, {
      theme,
      features,
      data: withQueue(),
      me: "oleg",
    });
    await page.goto("/important?tab=waiting&kind=tasks");
    const row = page.locator(".task-row", {
      hasText: "Проветрить большой зал перед группой",
    });
    await expect(row).toContainText("Отдел «Зал ЛФК»");
    await row.locator(".task-row__body").click();
    await expect(page).toHaveURL(new RegExp(`/chat/${chatID}\\?message=${queueID}`));

    const card = queueCard(page);
    await expect(card).toContainText(
      "Отдел «Зал ЛФК» · возьмёт первый из 2 человек",
    );
    await card.scrollIntoViewIfNeeded();
    await expect(page).toHaveScreenshot(`task-queue-${theme}.png`, shot);
    await card.getByRole("button", { name: "Взять себе" }).click();
    await expect(card).toContainText("Вы · отвечает");
    await expect(card.getByRole("button", { name: "Взять себе" })).toHaveCount(0);
    await expect(card.getByRole("button", { name: "Готово" })).toBeVisible();
    expect(
      api.calls.filter((call) => call.method === "POST").map((call) => call.path),
    ).toEqual([`/tasks/${queueID}/take`]);
  });
}

test("the second candidate loses the task from «Ждут вас» once it is taken", async ({
  page,
}) => {
  const api = await mockWorkplace(page, {
    features,
    data: withQueue(),
    me: "igor",
  });
  await page.goto("/important?tab=waiting&kind=tasks");
  const row = page.locator(".task-row", {
    hasText: "Проветрить большой зал перед группой",
  });
  await expect(row).toBeVisible();

  // Oleg takes it on his device: the event reaches Igor.
  const record = api.data.tasks[0]!;
  record.assignee = { ...record.assignee, actor_id: people.oleg.actor_id };
  record.version = 2;
  await api.emit({
    op: "event",
    seq: 40,
    type: "task.updated",
    occurred_at: "2026-11-11T07:16:00Z",
    actor_id: people.oleg.actor_id,
    chat_id: chatID,
    subject_id: queueID,
    data: { message_id: queueID, chat_id: chatID, task: api.taskMessage(record).task },
  });
  await expect(row).toHaveCount(0);
  await expect(page.getByText("На вас нет задач")).toBeVisible();
});

test("a late «Взять себе» shows who took it", async ({ page }) => {
  const api = await mockWorkplace(page, {
    features,
    data: withQueue(),
    me: "igor",
  });
  await openChat(page);
  const card = queueCard(page);
  await card.scrollIntoViewIfNeeded();
  // Oleg was first, and the event has not arrived yet.
  const record = api.data.tasks[0]!;
  record.assignee = { ...record.assignee, actor_id: people.oleg.actor_id };
  record.version = 2;
  await card.getByRole("button", { name: "Взять себе" }).click();
  await expect(page.getByText("Задачу уже взял другой человек")).toBeVisible();
  // details.task of the 409 puts the current task in.
  await expect(card).toContainText("Олег Чернов · отвечает");
  await expect(card.getByRole("button", { name: "Взять себе" })).toHaveCount(0);
});

test("a task goes to a department queue with the right to address groups", async ({
  page,
}) => {
  const api = await mockWorkplace(page, {
    features,
    data: withQueue(),
    me: "marina",
    permissions: ["requests.address_groups"],
  });
  await openChat(page);
  await page.getByRole("button", { name: "Добавить", exact: true }).click();
  await page
    .getByRole("menu", { name: "Добавить" })
    .getByRole("menuitem", { name: /Задача/ })
    .click();
  const dialog = page.getByRole("dialog", { name: "Новая задача" });
  await dialog.getByLabel("Что сделать").fill("Разложить новые маты");
  await dialog.getByRole("radio", { name: "Отдел" }).click();
  await dialog.getByRole("combobox").selectOption(ids.department);
  await expect(
    dialog.getByText("Увидят 2 человека в этом чате, возьмёт первый"),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Создать задачу" }).click();
  await expect(dialog).toHaveCount(0);
  expect(
    api.calls.find((call) => call.method === "POST")?.body,
  ).toMatchObject({
    title: "Разложить новые маты",
    assignee: { kind: "department", department_id: ids.department },
  });
  await expect(
    page.getByText("Задача в очереди — её увидят все, кто может взять"),
  ).toBeVisible();
});

test("without the right the form offers people only", async ({ page }) => {
  await mockWorkplace(page, { features, data: withQueue(), me: "marina" });
  await openChat(page);
  await page.getByRole("button", { name: "Добавить", exact: true }).click();
  await page
    .getByRole("menu", { name: "Добавить" })
    .getByRole("menuitem", { name: /Задача/ })
    .click();
  const dialog = page.getByRole("dialog", { name: "Новая задача" });
  await expect(dialog.getByRole("radio", { name: "Отдел" })).toHaveCount(0);
  await expect(dialog.getByRole("radiogroup", { name: "Ответственный" })).toBeVisible();
});
