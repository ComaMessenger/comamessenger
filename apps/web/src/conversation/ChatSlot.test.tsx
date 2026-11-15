import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMessengerStore,
  type ChatTaskPage,
  type Message,
  type MessageTask,
  type MessengerAPI,
  type ScheduledMessage,
  type User,
} from "@comamessenger/core";
import i18n from "../i18n";
import {
  MessengerContext,
  type MessengerContextValue,
} from "../shell/MessengerContext";
import { ToastProvider } from "../shell/ToastProvider";
import { ChatSlot } from "./ChatSlot";

const me = "00000000-0000-4000-8000-000000000001";
const oleg = "00000000-0000-4000-8000-000000000002";
const chatID = "00000000-0000-4000-8000-000000000020";

function task(
  id: string,
  title: string,
  assignee: string,
  dueInHours: number | null,
  seq: number,
): Message {
  const value: MessageTask = {
    title,
    description: "",
    status: "open",
    canceled_reason: null,
    status_changed_at: null,
    status_changed_by: null,
    assignee: {
      kind: "person",
      actor_id: assignee,
      label: "",
      candidate_ids: [],
      in_chat: true,
    },
    due_at:
      dueInHours === null
        ? null
        : new Date(Date.now() + dueInHours * 3600_000).toISOString(),
    remind_before_due: false,
    items: [],
    items_done: 0,
    source: null,
    last_nudge_at: null,
    nudge_count: 0,
    version: 1,
  };
  return {
    id,
    chat_id: chatID,
    actor_id: oleg,
    type: "task",
    body: title,
    created_seq: seq,
    created_at: new Date().toISOString(),
    task: value,
  } as unknown as Message;
}

function setup(options: {
  features: string[];
  tasks?: Message[];
  pins?: { id: string; body: string }[];
  scheduled?: number;
}) {
  const store = createMessengerStore();
  store.getState().setFeatures(options.features);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const tasks = options.tasks ?? [];
  const page: ChatTaskPage = {
    items: tasks,
    counts: {
      open: tasks.length,
      mine: tasks.filter((item) => item.task?.assignee.actor_id === me).length,
      mine_hot: 0,
    },
    next_cursor: null,
  };
  const scheduled = Array.from({ length: options.scheduled ?? 0 }, (_, n) => ({
    id: `s${n}`,
    chat_id: chatID,
    body: `Отложенное ${n + 1}`,
    send_at: new Date(Date.now() + (n + 2) * 86_400_000).toISOString(),
    status: "pending",
  })) as unknown as ScheduledMessage[];
  const api = {
    chatTasks: vi.fn(async () => page),
    pins: vi.fn(async () =>
      (options.pins ?? []).map((pin) => ({
        message_id: pin.id,
        pinned_by: oleg,
        pinned_at: "2026-11-10T07:00:00Z",
      })),
    ),
    messageContext: vi.fn(async (id: string) => ({
      messages: [
        {
          id,
          body: options.pins?.find((pin) => pin.id === id)?.body ?? "",
          files: [],
        },
      ],
    })),
    scheduledMessages: vi.fn(async () => scheduled),
  } as unknown as MessengerAPI;
  const navigate = vi.fn();
  const onJump = vi.fn();
  const value = {
    api,
    user: { id: me, display_name: "Анна", permissions: [] } as unknown as User,
    store,
    navigate,
    scheduleReload: vi.fn(),
  } as unknown as MessengerContextValue;
  render(
    <QueryClientProvider client={client}>
      <MessengerContext.Provider value={value}>
        <ToastProvider>
          <ChatSlot
            chatID={chatID}
            members={[]}
            messages={[]}
            viewer={{ actorID: me, chatRole: "member" }}
            canCreateTask
            onJump={onJump}
            onNewTask={vi.fn()}
          />
        </ToastProvider>
      </MessengerContext.Provider>
    </QueryClientProvider>,
  );
  return { navigate, onJump };
}

afterEach(cleanup);

describe("ChatSlot", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("ru");
  });

  it("shows what burns on the reader first, red, with «Готово» in the line", async () => {
    setup({
      features: ["message_tasks"],
      tasks: [
        task("t1", "Повесить расписание", me, 2, 1),
        task("t2", "Забрать ключи", oleg, 30, 2),
      ],
      pins: [{ id: "p1", body: "Ключи от раздевалки — на стойке" }],
      scheduled: 1,
    });
    expect(await screen.findByText("Повесить расписание")).toBeInTheDocument();
    const slot = document.querySelector(".chat-slot")!;
    expect(slot.getAttribute("data-slot-kind")).toBe("hot");
    expect(slot.classList).toContain("chat-slot--danger");
    expect(
      screen.getByRole("checkbox", { name: "Готово: Повесить расписание" }),
    ).toBeInTheDocument();
    const chips = screen.getByRole("group", { name: "Что показать под шапкой" });
    expect(
      [...chips.querySelectorAll("button")].map((chip) =>
        chip.getAttribute("aria-label"),
      ),
    ).toEqual([
      "Горит на вас: 1",
      "Закреплённое: 1",
      "Задачи: 2",
      "Отложено: 1",
    ]);
    // The tasks icon carries the dot: the reader answers for one of them.
    expect(
      screen.getByRole("button", { name: "Задачи: 2" }).querySelector(".chat-slot__dot"),
    ).not.toBeNull();
  });

  it("switches the kind by its icon and walks the pinned ones", async () => {
    const { onJump } = setup({
      features: ["message_tasks"],
      pins: [
        { id: "p1", body: "Первое закреплённое" },
        { id: "p2", body: "Второе закреплённое" },
      ],
      tasks: [task("t2", "Забрать ключи", oleg, null, 2)],
    });
    expect(await screen.findByText("Первое закреплённое")).toBeInTheDocument();
    expect(screen.getByText("Закреплённое 1 из 2")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Первое закреплённое"));
    expect(onJump).toHaveBeenCalledWith("p1");
    expect(await screen.findByText("Второе закреплённое")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Задачи: 1" }));
    expect(screen.getByText("Задачи · 1")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Забрать ключи"));
    expect(
      await screen.findByRole("dialog", { name: "Задачи чата" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Остальные · 1")).toBeInTheDocument();
  });

  it("has no task kinds without message_tasks and hides when empty", async () => {
    setup({ features: [], tasks: [task("t1", "Задача", me, 2, 1)], scheduled: 2 });
    expect(await screen.findByText("Отложенное 1")).toBeInTheDocument();
    expect(document.querySelector(".chat-slot")?.getAttribute("data-slot-kind")).toBe(
      "scheduled",
    );
    // One kind: no icons on the right.
    expect(screen.queryByRole("group", { name: "Что показать под шапкой" })).toBeNull();
    cleanup();
    setup({ features: ["message_tasks"] });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(document.querySelector(".chat-slot")).toBeNull();
  });
});
