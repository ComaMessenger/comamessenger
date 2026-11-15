import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  APIError,
  taskDraftFromMessage,
  toLocalInputValue,
  type ChatMember,
  type CreateTaskRequest,
  type Message,
  type OrgStructure,
} from "@comamessenger/core";
import i18n from "../i18n";
import { TaskDialog } from "./TaskDialog";

const self = "00000000-0000-4000-8000-000000000001";
const member = (n: number, name: string, type: "user" | "agent" = "user") =>
  ({
    actor_id: `00000000-0000-4000-8000-00000000000${n}`,
    display_name: name,
    handle: name.toLowerCase(),
    title: "",
    role: "member",
    joined_at: "2026-08-19T00:00:00Z",
    type,
  }) as ChatMember;
const members = [
  member(1, "Анна"),
  member(2, "Олег"),
  member(3, "Марина"),
  member(5, "Справка", "agent"),
];
const oleg = members[1]!.actor_id;
const marina = members[2]!.actor_id;

function setup(
  options: {
    initial?: Parameters<typeof TaskDialog>[0]["initial"];
    segments?: Parameters<typeof TaskDialog>[0]["segments"];
    structure?: OrgStructure | null;
    fail?: unknown;
  } = {},
) {
  const createTask = vi.fn(
    async (_chatID: string, input: CreateTaskRequest) => {
      if (options.fail) throw options.fail;
      return { id: "m1", client_msg_id: input.client_msg_id } as unknown as Message;
    },
  );
  const onSent = vi.fn();
  render(
    <TaskDialog
      chatID="c1"
      userID={self}
      members={members}
      initial={options.initial}
      segments={options.segments}
      structure={options.structure}
      recentIDs={[marina]}
      createTask={createTask}
      onSent={onSent}
      onClose={() => undefined}
    />,
  );
  return { createTask, onSent };
}

afterEach(cleanup);

describe("TaskDialog", () => {
  beforeEach(async () => {
    sessionStorage.clear();
    await i18n.changeLanguage("ru");
  });

  it("offers «Я», who wrote last and the rest, never an agent", () => {
    setup();
    const chips = screen
      .getByRole("radiogroup", { name: "Ответственный" })
      .querySelectorAll("button");
    expect([...chips].map((chip) => chip.lastChild?.textContent)).toEqual([
      "Я",
      "Марина",
      "Олег",
    ]);
  });

  it("checks the form in the order of its fields", async () => {
    const { createTask } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Создать задачу" }));
    expect(await screen.findByText("Напишите, что сделать")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Что сделать"), {
      target: { value: "Повесить расписание" },
    });
    expect(await screen.findByText("Выберите ответственного")).toBeInTheDocument();
    expect(createTask).not.toHaveBeenCalled();
  });

  it("sends the person, the due date, items with their people and the reminder", async () => {
    const due = new Date(Date.now() + 3 * 24 * 3600_000);
    due.setSeconds(0, 0);
    const { createTask, onSent } = setup();
    fireEvent.change(screen.getByLabelText("Что сделать"), {
      target: { value: "  Подготовить зал  " },
    });
    fireEvent.click(screen.getByRole("radio", { name: /Олег/ }));
    fireEvent.click(screen.getByRole("radio", { name: "Другая дата" }));
    fireEvent.change(screen.getByLabelText("Дата и время"), {
      target: { value: toLocalInputValue(due) },
    });
    fireEvent.click(screen.getByRole("button", { name: "Пункт" }));
    fireEvent.change(screen.getByLabelText("Пункт 1"), {
      target: { value: "Разложить маты" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Исполнитель пункта" }));
    fireEvent.click(await screen.findByRole("option", { name: /Марина/ }));
    fireEvent.click(screen.getByRole("button", { name: "Пункт" }));
    fireEvent.click(screen.getByRole("button", { name: "Создать задачу" }));
    await waitFor(() => expect(onSent).toHaveBeenCalled());
    const input = createTask.mock.calls[0]![1];
    expect(input).toMatchObject({
      title: "Подготовить зал",
      description: "",
      assignee: { kind: "person", actor_id: oleg },
      due_at: due.toISOString(),
      remind_before_due: true,
      // The blank second row is left out.
      items: [{ text: "Разложить маты", assignee_id: marina }],
    });
  });

  it("retries with the same client id and shows the server's refusal", async () => {
    const { createTask } = setup({
      fail: new APIError(422, "task_assignee_invalid", "no"),
    });
    fireEvent.change(screen.getByLabelText("Что сделать"), {
      target: { value: "Задача" },
    });
    fireEvent.click(screen.getByRole("radio", { name: /Я$/ }));
    fireEvent.click(screen.getByRole("button", { name: "Создать задачу" }));
    expect(
      await screen.findByText(
        "Этого человека нельзя назначить: он не в чате или неактивен",
      ),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Создать задачу" }));
    await waitFor(() => expect(createTask).toHaveBeenCalledTimes(2));
    expect(createTask.mock.calls[0]![1].client_msg_id).toBe(
      createTask.mock.calls[1]![1].client_msg_id,
    );
  });

  it("comes prefilled from a message and links back to it", async () => {
    const { createTask } = setup({
      initial: taskDraftFromMessage({
        id: "src",
        body: "**Проверить** аптечку в большом зале, докупить бинты",
      }),
    });
    expect(screen.getByLabelText("Что сделать")).toHaveValue(
      "Проверить аптечку в большом зале, докупить бинты",
    );
    fireEvent.click(screen.getByRole("radio", { name: /Марина/ }));
    fireEvent.click(screen.getByRole("button", { name: "Создать задачу" }));
    await waitFor(() => expect(createTask).toHaveBeenCalled());
    expect(createTask.mock.calls[0]![1]).toMatchObject({
      source_message_id: "src",
      assignee: { kind: "person", actor_id: marina },
    });
    expect(createTask.mock.calls[0]![1].due_at).toBeUndefined();
  });

  it("puts the task on a department queue when the right allows it", async () => {
    const structure = {
      version: 1,
      departments: [
        {
          id: "d1",
          name: "Зал ЛФК",
          parent_id: null,
          lead_actor_id: null,
          sort_key: null,
          chat_id: null,
          version: 1,
        },
      ],
      positions: [],
      people: [
        {
          actor_id: oleg,
          primary_department_id: "d1",
          additional_department_ids: [],
          position_id: null,
        },
        {
          actor_id: marina,
          primary_department_id: null,
          additional_department_ids: ["d1"],
          position_id: null,
        },
      ],
    } as unknown as OrgStructure;
    const { createTask } = setup({
      segments: ["person", "department", "position"],
      structure,
    });
    fireEvent.change(screen.getByLabelText("Что сделать"), {
      target: { value: "Проветрить зал" },
    });
    fireEvent.click(screen.getByRole("radio", { name: "Отдел" }));
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "d1" } });
    expect(
      screen.getByText("Увидят 2 человека в этом чате, возьмёт первый"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Создать задачу" }));
    await waitFor(() => expect(createTask).toHaveBeenCalled());
    expect(createTask.mock.calls[0]![1].assignee).toEqual({
      kind: "department",
      department_id: "d1",
    });
  });
});
