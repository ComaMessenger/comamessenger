import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatMember, MessageTask } from "@comamessenger/core";
import i18n from "../i18n";
import { TaskCard, type TaskCardActions } from "./TaskCard";

const anna = "00000000-0000-4000-8000-000000000001";
const oleg = "00000000-0000-4000-8000-000000000002";
const marina = "00000000-0000-4000-8000-000000000003";
const igor = "00000000-0000-4000-8000-000000000004";
// Wednesday 11 November 2026, 10:15 local time.
const now = new Date(2026, 10, 11, 10, 15);

const member = (id: string, name: string): ChatMember =>
  ({
    actor_id: id,
    display_name: name,
    handle: name,
    title: "",
    role: "member",
    joined_at: "2026-08-19T00:00:00Z",
    type: "user",
    avatar_version: 0,
  }) as ChatMember;
const members = [
  member(anna, "Анна Иванова"),
  member(oleg, "Олег Чернов"),
  member(marina, "Марина Соколова"),
  member(igor, "Игорь Лаптев"),
];

function task(patch: Partial<MessageTask> = {}): MessageTask {
  return {
    title: "Подготовить большой зал",
    description: "Слот Олега, после — растяжка.",
    status: "open",
    canceled_reason: null,
    status_changed_at: null,
    status_changed_by: null,
    assignee: {
      kind: "person",
      actor_id: anna,
      label: "",
      candidate_ids: [],
      in_chat: true,
    },
    due_at: new Date(2026, 10, 13, 9, 0).toISOString(),
    remind_before_due: true,
    items: [
      {
        id: "i1",
        text: "Разложить маты",
        assignee_id: oleg,
        assignee_in_chat: true,
        done_at: now.toISOString(),
        done_by: oleg,
      },
      {
        id: "i2",
        text: "Достать инвентарь",
        assignee_id: igor,
        assignee_in_chat: true,
        done_at: null,
        done_by: null,
      },
    ],
    items_done: 1,
    source: null,
    last_nudge_at: null,
    nudge_count: 0,
    version: 3,
    ...patch,
  };
}

function actions(): TaskCardActions & {
  setStatus: ReturnType<typeof vi.fn>;
  take: ReturnType<typeof vi.fn>;
  checkItem: ReturnType<typeof vi.fn>;
  nudge: ReturnType<typeof vi.fn>;
} {
  return {
    setStatus: vi.fn(async () => true),
    take: vi.fn(async () => true),
    checkItem: vi.fn(async () => true),
    nudge: vi.fn(async () => true),
    busy: null,
  };
}

function show(
  value: MessageTask,
  viewer: string,
  options: { author?: string; role?: string; act?: TaskCardActions } = {},
) {
  const act = options.act ?? actions();
  render(
    <TaskCard
      message={{
        id: "m1",
        chat_id: "c1",
        actor_id: options.author ?? marina,
        created_at: now.toISOString(),
        task: value,
      }}
      members={members}
      viewer={{ actorID: viewer, chatRole: options.role ?? "member" }}
      actions={act}
      now={now}
    />,
  );
  return act;
}

describe("TaskCard", () => {
  afterEach(cleanup);

  it("gives the responsible person «Взять в работу» and «Готово»", () => {
    void i18n.changeLanguage("ru");
    const act = show(task(), anna);
    expect(screen.getByText("Задача · 1 из 2")).toBeTruthy();
    expect(screen.getByText("Открыта")).toBeTruthy();
    expect(screen.getByText("Вы · отвечает")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Взять в работу" }));
    expect(act.setStatus).toHaveBeenCalledWith("in_progress");
    fireEvent.click(screen.getByRole("button", { name: "Готово" }));
    expect(act.setStatus).toHaveBeenCalledWith("done");
    // The responsible person ticks any item.
    const box = screen.getByRole("checkbox", { name: "Достать инвентарь" });
    expect((box as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(box);
    expect(act.checkItem).toHaveBeenCalledWith("i2", true);
    expect(screen.queryByRole("button", { name: /Напомнить/ })).toBeNull();
  });

  it("marks an overdue task and its due date as burning", () => {
    void i18n.changeLanguage("ru");
    show(task({ due_at: new Date(2026, 10, 10, 18, 0).toISOString() }), anna);
    expect(screen.getByText("Просрочена")).toBeTruthy();
    expect(screen.queryByText("Открыта")).toBeNull();
    expect(document.querySelector(".task-card__due--hot")?.textContent).toBe(
      "вчера, 18:00",
    );
  });

  it("lets an item's assignee tick only their item and shows no buttons", () => {
    void i18n.changeLanguage("ru");
    show(task(), igor);
    expect(
      (screen.getByRole("checkbox", { name: "Достать инвентарь" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    expect(
      (screen.getByRole("checkbox", { name: "Разложить маты" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(screen.queryByRole("button", { name: "Готово" })).toBeNull();
  });

  it("shows a third participant the task without buttons", () => {
    void i18n.changeLanguage("ru");
    show(task(), "00000000-0000-4000-8000-000000000009");
    expect(screen.getByText("Анна Иванова · отвечает")).toBeTruthy();
    expect(screen.queryAllByRole("button", { name: /Готово|Взять|Напомнить/ })).toEqual([]);
    for (const box of screen.getAllByRole("checkbox"))
      expect((box as HTMLButtonElement).disabled).toBe(true);
  });

  it("lets the author remind the responsible person and wait out the pause", () => {
    void i18n.changeLanguage("ru");
    const act = show(task(), marina);
    fireEvent.click(screen.getByRole("button", { name: "Напомнить ответственному" }));
    expect(act.nudge).toHaveBeenCalled();
    cleanup();
    show(
      task({ last_nudge_at: new Date(2026, 10, 11, 10, 0).toISOString(), nudge_count: 1 }),
      marina,
    );
    expect(screen.queryByRole("button", { name: "Напомнить ответственному" })).toBeNull();
    expect(screen.getByText("Напомнили · снова можно сегодня, 12:00")).toBeTruthy();
  });

  it("offers «Взять себе» to a candidate of a queue only", () => {
    void i18n.changeLanguage("ru");
    const queue = task({
      assignee: {
        kind: "department",
        actor_id: null,
        label: "Зал ЛФК",
        candidate_ids: [oleg, igor],
        in_chat: false,
      },
      items: [],
      items_done: 0,
    });
    const act = show(queue, oleg);
    expect(screen.getByText(/Отдел «Зал ЛФК» · возьмёт первый из 2 человек/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Взять себе" }));
    expect(act.take).toHaveBeenCalled();
    cleanup();
    show(queue, anna);
    expect(screen.queryByRole("button", { name: "Взять себе" })).toBeNull();
  });

  it("strikes a done task out and offers «Вернуть в работу»", () => {
    void i18n.changeLanguage("ru");
    const act = show(
      task({
        status: "done",
        status_changed_at: new Date(2026, 10, 11, 9, 40).toISOString(),
        status_changed_by: anna,
      }),
      anna,
    );
    expect(document.querySelector(".task-card__title--closed")).not.toBeNull();
    expect(screen.getByText("Готово · Вы, 09:40")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Вернуть в работу" }));
    expect(act.setStatus).toHaveBeenCalledWith("open");
    expect(screen.queryByRole("checkbox", { name: "Достать инвентарь" })).not.toBeNull();
    expect(
      (screen.getByRole("checkbox", { name: "Достать инвентарь" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("suggests closing when every item is done and tells a deleted source", () => {
    void i18n.changeLanguage("ru");
    show(
      task({
        items: task().items.map((item) => ({
          ...item,
          done_at: now.toISOString(),
          done_by: anna,
        })),
        items_done: 2,
        source: { message_id: "s1", author_id: oleg, excerpt: "", deleted: true },
      }),
      anna,
    );
    expect(screen.getByText("Все пункты готовы — закрыть задачу?")).toBeTruthy();
    expect(screen.getByText("из сообщения · сообщение удалено")).toBeTruthy();
  });

  it("tells the author the responsible person left the chat", () => {
    void i18n.changeLanguage("ru");
    show(
      task({
        assignee: {
          kind: "person",
          actor_id: igor,
          label: "",
          candidate_ids: [],
          in_chat: false,
        },
      }),
      marina,
    );
    expect(screen.getByText("· не в чате", { exact: false })).toBeTruthy();
    expect(
      screen.getByText("Ответственного нет в чате — назначьте другого"),
    ).toBeTruthy();
  });

  it("lets the author cancel and restore", () => {
    void i18n.changeLanguage("ru");
    const act = show(
      task({
        status: "canceled",
        canceled_reason: "author",
        status_changed_at: now.toISOString(),
        status_changed_by: marina,
      }),
      marina,
    );
    expect(screen.getByText("Отменена")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Вернуть" }));
    expect(act.setStatus).toHaveBeenCalledWith("open");
  });
});
