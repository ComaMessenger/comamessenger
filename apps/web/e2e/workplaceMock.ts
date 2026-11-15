import type { Page } from "@playwright/test";
import { createPollServer, type PollRecord } from "./pollsMock";

/*
 * A small stateful server for requests («Запрос») and reminders («Напомнить
 * мне»): the contract of phase 6.4 wave 1 in memory, so the web screens can
 * be checked and photographed without a backend. The live server is checked
 * by requests.live.spec.ts.
 */

// Wednesday 11 November 2026, 10:15 in Moscow.
export const now = new Date("2026-11-11T10:15:00+03:00");

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export const anna = {
  id: id(1),
  org_id: id(10),
  organization_name: "Реабцентр «Опора»",
  role: "member",
  email: "anna@example.com",
  display_name: "Анна Иванова",
  handle: "anna",
  title: "Инструктор ЛФК",
  about: "",
  timezone: "Europe/Moscow",
  status: "active",
  must_change_password: false,
  can_create_invitations: false,
  status_emoji: "",
  status_text: "",
  status_expires_at: null,
  created_at: "2026-08-19T00:00:00Z",
};

const member = (
  actorID: string,
  name: string,
  handle: string,
  title: string,
  type: "user" | "agent" = "user",
) => ({
  actor_id: actorID,
  display_name: name,
  handle,
  title,
  role: "member",
  joined_at: "2026-08-19T00:00:00Z",
  type,
  avatar_version: 0,
});

export const people = {
  anna: member(anna.id, anna.display_name, "anna", anna.title),
  oleg: member(id(2), "Олег Чернов", "oleg", "Инструктор ЛФК"),
  marina: member(id(3), "Марина Соколова", "marina", "Администратор"),
  igor: member(id(4), "Игорь Лаптев", "igor", "Старший инструктор"),
  agent: member(id(5), "Справка", "spravka", "", "agent"),
};

export const chatID = id(20);
export const otherChatID = id(21);

const chat = (chatId: string, name: string, seq: number) => ({
  id: chatId,
  kind: "group",
  visibility: "private",
  name,
  topic: "",
  role: "member",
  created_at: "2026-08-19T00:00:00Z",
  display_name: name,
  avatar_seed: name,
  notify_level: "default",
  muted_until: null,
  last_activity_seq: seq,
  last_message_at: "2026-11-11T06:40:00Z",
  last_message: {
    id: id(35),
    actor_id: people.oleg.actor_id,
    actor_display_name: people.oleg.display_name,
    body: "Буду, захвачу распечатки расписания.",
    created_seq: seq,
    created_at: "2026-11-11T06:40:00Z",
    deleted: false,
  },
});

type Answer = {
  option: number;
  comment: string;
  answered_at: string;
  late: boolean;
  version: number;
};

export type RequestRecord = {
  id: string;
  chat_id: string;
  author: string;
  body: string;
  created_seq: number;
  created_at: string;
  edited_at?: string;
  audience: { kind: "chat" | "people"; label: string };
  recipients: string[];
  preset: "ack" | "yes_no" | "attend" | "done" | "custom";
  options?: string[];
  allow_comment: boolean;
  due_at: string | null;
  auto_remind_at: string | null;
  status: "open" | "closed";
  closed_reason: string | null;
  answers: Record<string, Answer>;
  read: string[];
  version: number;
  next_remind_at: string | null;
  reminds: number;
};

type TextRecord = {
  id: string;
  chat_id: string;
  author: string;
  body: string;
  created_seq: number;
  created_at: string;
};

export type ReminderRecord = {
  id: string;
  message_id: string | null;
  chat_id: string;
  note: string;
  remind_at: string;
  state: "pending" | "fired";
  fired_at: string | null;
  late: boolean;
  version: number;
};

const answer = (option: number, at: string, comment = ""): Answer => ({
  option,
  comment,
  answered_at: at,
  late: false,
  version: 1,
});

export type TaskItemRecord = {
  id: string;
  text: string;
  assignee_id: string | null;
  done_at: string | null;
  done_by: string | null;
};

export type TaskRecord = {
  id: string;
  chat_id: string;
  author: string;
  title: string;
  description: string;
  created_seq: number;
  created_at: string;
  assignee: {
    kind: "person" | "department" | "position";
    actor_id: string | null;
    label: string;
    candidate_ids: string[];
    department_id?: string | null;
    position_id?: string | null;
  };
  status: "open" | "in_progress" | "done" | "canceled";
  status_changed_at: string | null;
  status_changed_by: string | null;
  canceled_reason: string | null;
  due_at: string | null;
  remind_before_due: boolean;
  items: TaskItemRecord[];
  source_message_id: string | null;
  last_nudge_at: string | null;
  nudge_count: number;
  version: number;
};

export const ids = {
  mats: id(30),
  planning: id(31),
  saturday: id(32),
  journal: id(33),
  printouts: id(35),
  pool: id(40),
  hall: id(41),
  keys: id(42),
  december: id(43),
  journalTask: id(44),
  department: id(80),
  position: id(81),
};

const item = (
  n: number,
  text: string,
  assignee: string | null,
  doneBy: string | null = null,
): TaskItemRecord => ({
  id: id(100 + n),
  text,
  assignee_id: assignee,
  done_at: doneBy ? "2026-11-11T06:05:00Z" : null,
  done_by: doneBy,
});

const person = (actorID: string) => ({
  kind: "person" as const,
  actor_id: actorID,
  label: "",
  candidate_ids: [],
});

/**
 * Tasks of «Инструкторы · зал» as in the prototype: one burning on Anna,
 * one with a checklist, one on Oleg set by Anna, one done; and an overdue
 * one in «Общий».
 */
export function taskFixtures(): TaskRecord[] {
  const base = {
    description: "",
    status_changed_at: null,
    status_changed_by: null,
    canceled_reason: null,
    remind_before_due: true,
    items: [],
    source_message_id: null,
    last_nudge_at: null,
    nudge_count: 0,
    version: 1,
  };
  return [
    {
      ...base,
      id: ids.pool,
      chat_id: chatID,
      author: people.marina.actor_id,
      title: "Повесить новое расписание бассейна",
      created_seq: 6,
      created_at: "2026-11-11T06:45:00Z",
      assignee: person(anna.id),
      status: "open",
      due_at: "2026-11-11T09:00:00Z",
    },
    {
      ...base,
      id: ids.hall,
      chat_id: chatID,
      author: people.marina.actor_id,
      title: "Подготовить большой зал к слоту в пт, 9:00",
      description: "Слот Олега, после — группа на растяжку.",
      created_seq: 7,
      created_at: "2026-11-11T06:50:00Z",
      assignee: person(anna.id),
      status: "open",
      due_at: "2026-11-13T05:45:00Z",
      items: [
        item(1, "Разложить маты", people.oleg.actor_id, people.oleg.actor_id),
        item(2, "Достать инвентарь из кладовой", anna.id),
        item(3, "Проветрить зал", null),
      ],
      version: 3,
    },
    {
      ...base,
      id: ids.keys,
      chat_id: chatID,
      author: anna.id,
      title: "Забрать ключи от малого зала у охраны",
      created_seq: 8,
      created_at: "2026-11-11T06:55:00Z",
      assignee: person(people.oleg.actor_id),
      status: "in_progress",
      status_changed_at: "2026-11-11T07:00:00Z",
      status_changed_by: people.oleg.actor_id,
      due_at: "2026-11-11T14:00:00Z",
      version: 2,
    },
    {
      ...base,
      id: ids.december,
      chat_id: chatID,
      author: people.igor.actor_id,
      title: "Передать график на декабрь",
      created_seq: 9,
      created_at: "2026-11-11T07:00:00Z",
      assignee: person(anna.id),
      status: "done",
      status_changed_at: "2026-11-11T07:05:00Z",
      status_changed_by: anna.id,
      due_at: null,
      remind_before_due: false,
      version: 2,
    },
    {
      ...base,
      id: ids.journalTask,
      chat_id: otherChatID,
      author: people.marina.actor_id,
      title: "Сдать журнал инструктажа по технике безопасности",
      created_seq: 2,
      created_at: "2026-11-09T07:00:00Z",
      assignee: person(anna.id),
      status: "open",
      due_at: "2026-11-10T15:00:00Z",
      version: 1,
    },
  ];
}

export function fixtures() {
  const texts: TextRecord[] = [
    {
      id: ids.mats,
      chat_id: chatID,
      author: people.oleg.actor_id,
      body: "Маты в малом зале разложил.",
      created_seq: 1,
      created_at: "2026-11-11T06:02:00Z",
    },
    {
      id: ids.printouts,
      chat_id: chatID,
      author: people.igor.actor_id,
      body: "Буду, захвачу распечатки расписания.",
      created_seq: 5,
      created_at: "2026-11-11T06:40:00Z",
    },
  ];
  const requests: RequestRecord[] = [
    {
      id: ids.planning,
      chat_id: chatID,
      author: people.marina.actor_id,
      body: "Планёрка в понедельник в 8:30, большой зал. Будете?",
      created_seq: 2,
      created_at: "2026-11-11T06:10:00Z",
      audience: { kind: "people", label: "" },
      recipients: [anna.id, people.oleg.actor_id, people.igor.actor_id],
      preset: "attend",
      allow_comment: true,
      due_at: "2026-11-13T15:00:00Z",
      auto_remind_at: "2026-11-12T15:00:00Z",
      status: "open",
      closed_reason: null,
      answers: { [people.igor.actor_id]: answer(0, "2026-11-11T06:14:00Z") },
      read: [people.igor.actor_id],
      version: 2,
      next_remind_at: null,
      reminds: 0,
    },
    {
      id: ids.saturday,
      chat_id: chatID,
      author: anna.id,
      body: "Субботник в эту субботу, 10:00. Кто придёт?",
      created_seq: 3,
      created_at: "2026-11-11T06:20:00Z",
      audience: { kind: "chat", label: "" },
      recipients: [
        people.oleg.actor_id,
        people.marina.actor_id,
        people.igor.actor_id,
      ],
      preset: "custom",
      options: ["Приду", "Не приду", "Пока не знаю"],
      allow_comment: true,
      due_at: "2026-11-12T09:00:00Z",
      auto_remind_at: null,
      status: "open",
      closed_reason: null,
      answers: {
        [people.oleg.actor_id]: answer(0, "2026-11-11T06:25:00Z", "буду к 9"),
        [people.marina.actor_id]: answer(
          1,
          "2026-11-11T06:31:00Z",
          "дежурю в бассейне",
        ),
      },
      read: [
        people.oleg.actor_id,
        people.marina.actor_id,
        people.igor.actor_id,
      ],
      version: 3,
      next_remind_at: null,
      reminds: 0,
    },
    {
      id: ids.journal,
      chat_id: chatID,
      author: people.igor.actor_id,
      body: "Журнал осмотров за неделю заполнен?",
      created_seq: 4,
      created_at: "2026-11-11T06:30:00Z",
      audience: { kind: "people", label: "" },
      recipients: [people.oleg.actor_id, people.marina.actor_id],
      preset: "yes_no",
      allow_comment: false,
      due_at: null,
      auto_remind_at: null,
      status: "open",
      closed_reason: null,
      answers: { [people.oleg.actor_id]: answer(0, "2026-11-11T06:33:00Z") },
      read: [people.oleg.actor_id],
      version: 2,
      next_remind_at: null,
      reminds: 0,
    },
  ];
  const reminders: ReminderRecord[] = [
    {
      id: id(60),
      message_id: ids.mats,
      chat_id: chatID,
      note: "Проверить маты перед группой",
      remind_at: "2026-11-11T07:00:00Z",
      state: "fired",
      fired_at: "2026-11-11T07:00:02Z",
      late: false,
      version: 2,
    },
    {
      id: id(61),
      message_id: ids.printouts,
      chat_id: chatID,
      note: "",
      remind_at: "2026-11-12T06:00:00Z",
      state: "pending",
      fired_at: null,
      late: false,
      version: 1,
    },
  ];
  return {
    texts,
    requests,
    reminders,
    tasks: [] as TaskRecord[],
    polls: [] as PollRecord[],
    pins: [] as string[],
    scheduled: [] as Array<{
      id: string;
      chat_id: string;
      body: string;
      send_at: string;
    }>,
  };
}

export async function mockWorkplace(
  page: Page,
  options: {
    theme?: "light" | "dark";
    /** HelloFrame.features; both by default. */
    features?: string[];
    data?: ReturnType<typeof fixtures>;
    /** Who is signed in; Anna by default. */
    me?: keyof typeof people;
    /** chats.moderate and requests.address_groups, for the queue form. */
    permissions?: string[];
  } = {},
) {
  const { theme = "light" } = options;
  const features = options.features ?? [
    "message_requests",
    "message_reminders",
  ];
  const data = options.data ?? fixtures();
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const me = people[options.me ?? "anna"].actor_id;
  const meUser = {
    ...anna,
    id: me,
    display_name: people[options.me ?? "anna"].display_name,
    handle: people[options.me ?? "anna"].handle,
    title: people[options.me ?? "anna"].title,
    permissions: options.permissions ?? [],
  };
  const allMembers = Object.values(people);
  const nowISO = now.toISOString();
  await page.clock.setFixedTime(now);
  await page.addInitScript(
    ({ theme: value, features: list }) => {
      localStorage.setItem("coma-locale", "ru");
      localStorage.setItem("coma-theme", value);
      class FakeSocket {
        static OPEN = 1;
        static latest: FakeSocket | null = null;
        readyState = 1;
        onopen: null | (() => void) = null;
        onmessage: null | ((event: { data: string }) => void) = null;
        onclose: null | ((event: { code: number }) => void) = null;
        constructor() {
          FakeSocket.latest = this;
          setTimeout(() => this.onopen?.(), 0);
        }
        send(raw: string) {
          const frame = JSON.parse(raw);
          if (frame.op === "auth")
            setTimeout(
              () =>
                this.onmessage?.({
                  data: JSON.stringify({
                    op: "hello",
                    request_id: frame.request_id,
                    connection_id: "00000000-0000-4000-8000-000000000099",
                    current_seq: 0,
                    min_retained_seq: 0,
                    heartbeat_interval_ms: 25000,
                    ack_interval_ms: 1000,
                    ack_batch_size: 50,
                    max_unacked_events: 128,
                    features: list,
                  }),
                }),
              0,
            );
        }
        close() {}
      }
      Object.assign(window, {
        WebSocket: FakeSocket,
        __emitComaEvent: (frame: unknown) =>
          FakeSocket.latest?.onmessage?.({ data: JSON.stringify(frame) }),
      });
    },
    { theme, features },
  );

  const optionsOf = (r: RequestRecord) =>
    r.preset === "custom"
      ? r.options!
      : r.preset === "yes_no" || r.preset === "attend"
        ? ["a", "b"]
        : ["a"];
  const requestOf = (r: RequestRecord) => {
    const answered = Object.keys(r.answers).length;
    return {
      status: r.status,
      closed_reason: r.closed_reason,
      answer:
        r.preset === "custom"
          ? { preset: r.preset, options: r.options }
          : { preset: r.preset },
      allow_comment: r.allow_comment,
      due_at: r.due_at,
      auto_remind_at: r.auto_remind_at,
      audience: {
        kind: r.audience.kind,
        label: r.audience.label,
        count: r.recipients.length,
      },
      answered_count: answered,
      waiting_count: r.recipients.length - answered,
      version: r.version,
    };
  };
  const viewerOf = (r: RequestRecord) => {
    const role =
      r.author === me
        ? "author"
        : r.recipients.includes(me)
          ? "recipient"
          : "observer";
    const mine = r.answers[me] ?? null;
    const open = r.status === "open";
    const beforeDue = !r.due_at || Date.parse(r.due_at) > now.getTime();
    const waiting = r.recipients.length - Object.keys(r.answers).length;
    const author = role === "author";
    return {
      role,
      answer: mine,
      can_answer: role === "recipient" && open,
      can_change: Boolean(mine) && open && beforeDue,
      can_view_answers: author,
      can_close: author && open,
      can_remind:
        author && open && waiting > 0 && !r.next_remind_at && r.reminds < 5,
      next_remind_at: author ? r.next_remind_at : null,
      tally: author
        ? optionsOf(r).map(
            (_label, index) =>
              Object.values(r.answers).filter((item) => item.option === index)
                .length,
          )
        : null,
    };
  };
  const authorOf = (actorID: string) =>
    allMembers.find((item) => item.actor_id === actorID)!;
  const chatMembers = (chat: string) =>
    chat === otherChatID ? [people.anna, people.marina] : allMembers;
  const inChat = (chat: string, actorID: string | null) =>
    Boolean(actorID) &&
    chatMembers(chat).some((member) => member.actor_id === actorID);
  const taskOf = (r: TaskRecord) => {
    const source = r.source_message_id
      ? [...data.texts, ...data.requests].find(
          (entry) => entry.id === r.source_message_id,
        )
      : null;
    return {
      title: r.title,
      description: r.description,
      status: r.status,
      canceled_reason: r.canceled_reason,
      status_changed_at: r.status_changed_at,
      status_changed_by: r.status_changed_by,
      assignee: {
        ...r.assignee,
        in_chat: inChat(r.chat_id, r.assignee.actor_id),
      },
      due_at: r.due_at,
      remind_before_due: r.remind_before_due,
      items: r.items.map((entry) => ({
        ...entry,
        assignee_in_chat: inChat(r.chat_id, entry.assignee_id),
      })),
      items_done: r.items.filter((entry) => entry.done_at).length,
      source: r.source_message_id
        ? {
            message_id: r.source_message_id,
            author_id: source?.author ?? anna.id,
            excerpt: source ? source.body.slice(0, 140) : "",
            deleted: !source,
          }
        : null,
      last_nudge_at: r.last_nudge_at,
      nudge_count: r.nudge_count,
      version: r.version,
    };
  };
  const taskMessage = (r: TaskRecord) => ({
    id: r.id,
    chat_id: r.chat_id,
    actor_id: r.author,
    client_msg_id: r.id.replace("4000-8000", "4000-9000"),
    type: "task",
    body: r.description ? `${r.title}\n\n${r.description}` : r.title,
    body_format: "markdown",
    version: 1,
    created_seq: r.created_seq,
    created_at: r.created_at,
    mentioned_actor_ids: [],
    files: [],
    thread_reply_count: 0,
    task: taskOf(r),
  });
  const messageOf = (record: TextRecord | RequestRecord | TaskRecord) => {
    if ("assignee" in record) return taskMessage(record);
    const request = "recipients" in record ? record : null;
    return {
      id: record.id,
      chat_id: record.chat_id,
      actor_id: record.author,
      client_msg_id: record.id.replace("4000-8000", "4000-9000"),
      type: request ? "request" : "text",
      body: record.body,
      body_format: "plain",
      version: 1,
      created_seq: record.created_seq,
      created_at: record.created_at,
      ...(request?.edited_at ? { edited_at: request.edited_at } : {}),
      mentioned_actor_ids: [],
      files: [],
      thread_reply_count: 0,
      ...(request
        ? { request: requestOf(request), request_viewer: viewerOf(request) }
        : {}),
    };
  };
  const feed = (chat: string) =>
    [...data.texts, ...data.requests, ...data.tasks, ...data.polls]
      .filter((item) => item.chat_id === chat)
      .sort((left, right) => left.created_seq - right.created_seq)
      .map((item) =>
        "question" in item ? polls.messageOf(item) : messageOf(item),
      );
  const savedAuthor = (actorID: string) => {
    const author = authorOf(actorID);
    return {
      actor_id: author.actor_id,
      display_name: author.display_name,
      type: author.type,
      avatar_version: 0,
    };
  };
  const savedChat = {
    id: chatID,
    kind: "group",
    display_name: "Инструкторы · зал",
  };
  const inboxItem = (r: RequestRecord) => ({
    message: messageOf(r),
    chat_id: r.chat_id,
    author: savedAuthor(r.author),
    chat: savedChat,
    request: requestOf(r),
    viewer: viewerOf(r),
  });
  const waitingForMe = () =>
    data.requests.filter(
      (r) => r.status === "open" && r.recipients.includes(me) && !r.answers[me],
    );
  const activeTask = (r: TaskRecord) =>
    r.status === "open" || r.status === "in_progress";
  const taskRoleOf = (r: TaskRecord, who = me) =>
    r.assignee.actor_id === who
      ? "responsible"
      : r.items.some((entry) => entry.assignee_id === who && !entry.done_at)
        ? "item"
        : r.assignee.actor_id === null && r.assignee.candidate_ids.includes(who)
          ? "candidate"
          : r.author === who
            ? "author"
            : null;
  const onMe = (r: TaskRecord) =>
    activeTask(r) &&
    ["responsible", "item", "candidate"].includes(taskRoleOf(r) ?? "") &&
    inChat(r.chat_id, me);
  const hot = (due: string | null) =>
    Boolean(due) && Date.parse(due!) - now.getTime() < 24 * 3600_000;
  const byDue = (left: TaskRecord, right: TaskRecord) =>
    (left.due_at ? Date.parse(left.due_at) : Infinity) -
      (right.due_at ? Date.parse(right.due_at) : Infinity) ||
    right.created_seq - left.created_seq;
  const tasksOn = features.includes("message_tasks");
  const taskUnread = (chat: string) => {
    if (!tasksOn) return {};
    const mine = data.tasks.filter((r) => r.chat_id === chat && onMe(r));
    const dues = mine
      .map((r) => r.due_at)
      .filter((value): value is string => Boolean(value))
      .sort();
    return {
      tasks_mine_open: mine.length,
      tasks_mine_next_due_at: dues[0] ?? null,
    };
  };
  const unread = () => {
    const waiting = waitingForMe();
    const dues = waiting
      .map((r) => r.due_at)
      .filter((value): value is string => Boolean(value))
      .sort();
    return {
      chats: [
        {
          chat_id: chatID,
          last_read_seq: 5,
          unread_count: 0,
          mention_count: 0,
          requests_waiting: waiting.length,
          requests_next_due_at: dues[0] ?? null,
          ...taskUnread(chatID),
          ...(pollsOn ? polls.chatUnread(chatID) : {}),
        },
        ...(tasksOn
          ? [
              {
                chat_id: otherChatID,
                last_read_seq: 1,
                unread_count: 0,
                mention_count: 0,
                requests_waiting: 0,
                requests_next_due_at: null,
                ...taskUnread(otherChatID),
              },
            ]
          : []),
      ],
      threads: [],
      requests_waiting_total: waiting.length,
      ...(tasksOn
        ? {
            tasks_mine_open_total: data.tasks.filter(onMe).length,
            tasks_mine_hot_total: data.tasks.filter(
              (r) => onMe(r) && hot(r.due_at),
            ).length,
          }
        : {}),
      ...(pollsOn ? polls.unread() : {}),
      reminders_fired_total: data.reminders.filter(
        (item) => item.state === "fired",
      ).length,
    };
  };
  const reminderOf = (item: ReminderRecord) => {
    const target = [...data.texts, ...data.requests].find(
      (entry) => entry.id === item.message_id,
    );
    return {
      ...item,
      access: target ? "available" : item.message_id ? "none" : "deleted",
      message: target
        ? {
            message: messageOf(target),
            author: savedAuthor(target.author),
            chat: savedChat,
          }
        : null,
    };
  };

  // «Зал ЛФК» with Oleg and Igor; «Инструктор ЛФК» held by Oleg and Anna.
  const orgStructure = {
    version: 1,
    departments: [
      {
        id: ids.department,
        name: "Зал ЛФК",
        parent_id: null,
        lead_actor_id: people.igor.actor_id,
        chat_id: null,
        has_chat: false,
        chat_archived: false,
        sort_key: null,
        version: 1,
      },
    ],
    positions: [
      { id: ids.position, name: "Инструктор ЛФК", sort_key: null, version: 1 },
    ],
    people: [
      {
        actor_id: people.oleg.actor_id,
        primary_department_id: ids.department,
        additional_department_ids: [],
        position_id: ids.position,
      },
      {
        actor_id: people.igor.actor_id,
        primary_department_id: ids.department,
        additional_department_ids: [],
        position_id: null,
      },
      {
        actor_id: anna.id,
        primary_department_id: null,
        additional_department_ids: [],
        position_id: ids.position,
      },
    ],
  };
  const savedAuthorOf = (actorID: string) => savedAuthor(actorID);
  const chatRef = (chat: string) => ({
    id: chat,
    kind: "group",
    display_name: chat === otherChatID ? "Общий" : "Инструкторы · зал",
  });
  const myTaskItem = (r: TaskRecord, role: string) => ({
    message: taskMessage(r),
    author: savedAuthorOf(r.author),
    chat: chatRef(r.chat_id),
    my_role: role,
  });
  const fail = (status: number, code: string, details: unknown = {}) => ({
    status,
    body: { code, message: code, details },
  });
  const isAdmin = false;
  const canManage = (r: TaskRecord) => r.author === me || isAdmin;
  const canWork = (r: TaskRecord) => canManage(r) || r.assignee.actor_id === me;
  const bump = (r: TaskRecord) => {
    r.version += 1;
  };
  let nextID = 200;
  const pollsOn = features.includes("message_polls");
  const polls = createPollServer({
    polls: data.polls,
    me,
    peopleOf: (chat) =>
      (chat === otherChatID ? [people.anna, people.marina] : allMembers)
        .filter((item) => item.type === "user")
        .map((item) => item.actor_id),
    nowISO,
    nextID: () => id((nextID += 1)),
    nextSeq: () => 20 + (nextID += 1),
    chatRef: (chat) => chatRef(chat),
    authorOf: (actorID) => savedAuthorOf(actorID),
  });
  const taskRoute = (
    method: string,
    path: string,
    url: URL,
    input: { [key: string]: unknown } | null,
  ): { status: number; body: unknown } => {
    if (!tasksOn) return fail(501, "not_implemented");
    const chatTasks = /^\/chats\/([^/]+)\/tasks$/.exec(path);
    if (chatTasks && method === "POST") {
      const assignee = input?.assignee as {
        kind: "person" | "department" | "position";
        actor_id?: string;
        department_id?: string;
        position_id?: string;
      };
      const items =
        (input?.items as { text: string; assignee_id?: string }[]) ?? [];
      const queue = assignee.kind !== "person";
      const created: TaskRecord = {
        id: id((nextID += 1)),
        chat_id: chatTasks[1]!,
        author: me,
        title: String(input?.title),
        description: String(input?.description ?? ""),
        created_seq: 20 + nextID,
        created_at: nowISO,
        assignee: queue
          ? {
              kind: assignee.kind,
              actor_id: null,
              label:
                assignee.kind === "department" ? "Зал ЛФК" : "Инструктор ЛФК",
              candidate_ids:
                assignee.kind === "department"
                  ? [people.oleg.actor_id, people.igor.actor_id]
                  : [people.oleg.actor_id, anna.id],
              department_id: assignee.department_id ?? null,
              position_id: assignee.position_id ?? null,
            }
          : person(assignee.actor_id!),
        status: "open",
        status_changed_at: null,
        status_changed_by: null,
        canceled_reason: null,
        due_at: (input?.due_at as string) ?? null,
        remind_before_due: Boolean(input?.remind_before_due),
        items: items.map((entry) => ({
          id: id((nextID += 1)),
          text: entry.text,
          assignee_id: entry.assignee_id ?? null,
          done_at: null,
          done_by: null,
        })),
        source_message_id: (input?.source_message_id as string) ?? null,
        last_nudge_at: null,
        nudge_count: 0,
        version: 1,
      };
      data.tasks.push(created);
      return { status: 201, body: taskMessage(created) };
    }
    if (chatTasks) {
      const state = url.searchParams.get("state") ?? "open";
      const list = data.tasks
        .filter((r) => r.chat_id === chatTasks[1])
        .filter((r) => (state === "open" ? activeTask(r) : r.status === state))
        .sort(byDue);
      const open = data.tasks.filter(
        (r) => r.chat_id === chatTasks[1] && activeTask(r),
      );
      return {
        status: 200,
        body: {
          items: list.map(taskMessage),
          counts: {
            open: open.length,
            mine: open.filter(onMe).length,
            mine_hot: open.filter((r) => onMe(r) && hot(r.due_at)).length,
          },
          next_cursor: null,
        },
      };
    }
    if (path === "/tasks/mine") {
      const role = url.searchParams.get("role") ?? "assigned";
      const state = url.searchParams.get("state") ?? "open";
      const list = data.tasks.filter((r) =>
        role === "authored"
          ? r.author === me &&
            (state === "done" ? r.status === "done" : activeTask(r))
          : state === "done"
            ? r.status === "done" &&
              (r.assignee.actor_id === me ||
                r.items.some((entry) => entry.assignee_id === me))
            : onMe(r),
      );
      return {
        status: 200,
        body: {
          items: list
            .sort(byDue)
            .map((r) =>
              myTaskItem(
                r,
                role === "authored"
                  ? "author"
                  : (taskRoleOf(r) ?? "responsible"),
              ),
            ),
          next_cursor: null,
        },
      };
    }
    if (path === "/inbox/waiting") {
      const kind = url.searchParams.get("kind") ?? "all";
      const requests =
        kind === "tasks"
          ? []
          : waitingForMe().map((r) => ({
              kind: "request",
              ...inboxItem(r),
              due_at: r.due_at,
              my_role: null,
            }));
      const pollItems =
        pollsOn && (kind === "all" || kind === "polls")
          ? polls.waitingItems()
          : [];
      const tasks =
        kind === "requests" || kind === "polls"
          ? []
          : data.tasks.filter(onMe).map((r) => ({
              kind: "task",
              message: taskMessage(r),
              chat_id: r.chat_id,
              author: savedAuthorOf(r.author),
              chat: chatRef(r.chat_id),
              due_at: r.due_at,
              request: null,
              viewer: null,
              my_role: taskRoleOf(r),
            }));
      const items = [
        ...(kind === "polls" ? [] : requests),
        ...tasks,
        ...pollItems,
      ].sort(
        (left, right) =>
          (left.due_at ? Date.parse(left.due_at) : Infinity) -
          (right.due_at ? Date.parse(right.due_at) : Infinity),
      );
      return { status: 200, body: { items, next_cursor: null } };
    }
    const match =
      /^\/tasks\/([^/]+)(?:\/(status|take|nudge|items)(?:\/([^/]+))?)?$/.exec(
        path,
      );
    const r = match ? data.tasks.find((entry) => entry.id === match[1]) : null;
    if (!match || !r) return fail(404, "task_not_found");
    const action = match[2];
    if (!action && method === "GET")
      return { status: 200, body: taskMessage(r) };
    if (!action && method === "PATCH") {
      if (!canManage(r)) return fail(403, "task_forbidden");
      if (input?.expected_version !== r.version)
        return fail(409, "task_version_conflict", { task: taskOf(r) });
      if (typeof input?.title === "string") r.title = input.title;
      if (typeof input?.description === "string")
        r.description = input.description;
      if (input && "due_at" in input)
        r.due_at = (input.due_at as string) ?? null;
      if (typeof input?.remind_before_due === "boolean")
        r.remind_before_due = input.remind_before_due;
      const next = input?.assignee as
        | { kind: string; actor_id?: string }
        | undefined;
      if (next?.kind === "person" && next.actor_id)
        r.assignee = person(next.actor_id);
      bump(r);
      return { status: 200, body: taskMessage(r) };
    }
    if (action === "status") {
      const to = input?.status as TaskRecord["status"];
      const allowed =
        to === "canceled" || (r.status === "canceled" && to === "open")
          ? canManage(r)
          : canWork(r);
      if (!allowed) return fail(403, "task_forbidden");
      if (r.status !== to) {
        r.status = to;
        r.status_changed_at = nowISO;
        r.status_changed_by = me;
        r.canceled_reason = to === "canceled" ? "author" : null;
        bump(r);
      }
      return { status: 200, body: taskMessage(r) };
    }
    if (action === "take") {
      if (r.assignee.actor_id)
        return fail(409, "task_already_taken", { task: taskOf(r) });
      if (!r.assignee.candidate_ids.includes(me))
        return fail(403, "task_forbidden");
      r.assignee = { ...r.assignee, actor_id: me };
      bump(r);
      return { status: 200, body: taskMessage(r) };
    }
    if (action === "nudge") {
      r.nudge_count += 1;
      r.last_nudge_at = nowISO;
      bump(r);
      return {
        status: 200,
        body: {
          next_nudge_at: new Date(now.getTime() + 2 * 3600_000).toISOString(),
        },
      };
    }
    if (action === "items") {
      const itemID = match[3];
      if (!itemID && method === "POST") {
        r.items.push({
          id: id((nextID += 1)),
          text: String(input?.text),
          assignee_id: (input?.assignee_id as string) ?? null,
          done_at: null,
          done_by: null,
        });
        bump(r);
        return { status: 200, body: taskOf(r) };
      }
      const entry = r.items.find((value) => value.id === itemID);
      if (!entry) return fail(404, "task_not_found");
      if (method === "DELETE") {
        r.items = r.items.filter((value) => value !== entry);
        bump(r);
        return { status: 204, body: undefined };
      }
      if (typeof input?.done === "boolean") {
        if (!canWork(r) && entry.assignee_id !== me)
          return fail(403, "task_forbidden");
        entry.done_at = input.done ? nowISO : null;
        entry.done_by = input.done ? me : null;
      }
      if (typeof input?.text === "string") entry.text = input.text;
      if (input && "assignee_id" in input)
        entry.assignee_id = (input.assignee_id as string) ?? null;
      bump(r);
      return { status: 200, body: taskOf(r) };
    }
    return fail(404, "not_found");
  };

  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace(/^\/api\/v1/, "");
    const method = request.method();
    const input = (() => {
      try {
        return request.postDataJSON() as { [key: string]: unknown };
      } catch {
        return null;
      }
    })();
    if (/request|reminder|task|inbox|poll/.test(path))
      calls.push({ method, path, body: input });
    let status = 200;
    let body: unknown = {};
    const requestMatch =
      /^\/requests\/([^/]+)(?:\/(answer|answers|remind|close))?$/.exec(path);
    const reminderMatch = /^\/messages\/([^/]+)\/reminder$/.exec(path);
    const reminderByID = /^\/reminders\/([^/]+)$/.exec(path);
    if (path === "/bootstrap/status") body = { bootstrapped: true };
    else if (path === "/branding")
      body = {
        workspace_name: anna.organization_name,
        accent_color: "#174586",
        version: 1,
        password_recovery_available: false,
        email_delivery_available: false,
      };
    else if (path === "/auth/refresh")
      body = {
        access_token: "test",
        access_expires_at: "2026-11-12T00:00:00Z",
        user: meUser,
      };
    else if (path === "/me") body = meUser;
    else if (path === "/preferences")
      body = {
        theme,
        locale: "ru",
        in_app_enabled: true,
        push_enabled: false,
        push_preview: false,
        notify_messages: "all",
        notify_threads: "all",
        notify_reactions: true,
        notify_invites: true,
        notify_system: true,
        sound_enabled: false,
        sound_id: "default",
        schedule: null,
        snoozed_until: null,
        email_digest: false,
      };
    else if (path === "/preferences/chat-folders") body = [];
    else if (path === "/preferences/pinned-chats") body = [];
    else if (path === "/chats")
      body = {
        chats: [
          chat(chatID, "Инструкторы · зал", 5),
          chat(otherChatID, "Общий", 1),
        ],
      };
    else if (path === "/unread") body = unread();
    else if (path === "/org" && features.includes("org_structure"))
      body = orgStructure;
    else if (path === "/drafts") body = { drafts: [] };
    else if (path === "/agents") body = [];
    else if (path === "/scheduled-messages")
      body = {
        scheduled_messages: data.scheduled.map((entry) => ({
          ...entry,
          thread_root_id: null,
          reply_to_id: null,
          client_msg_id: entry.id,
          body_format: "markdown",
          mentioned_actor_ids: [],
          files: [],
          silent: false,
          status: "pending",
          failure_reason: null,
          message_id: null,
          version: 1,
          created_at: "2026-11-11T06:00:00Z",
          updated_at: "2026-11-11T06:00:00Z",
        })),
      };
    else if (path === `/chats/${chatID}/members`)
      body = { members: allMembers };
    else if (path === `/chats/${otherChatID}/members`)
      body = { members: [people.anna, people.marina] };
    else if (path === `/chats/${chatID}/pins`)
      body = {
        pins: data.pins.map((messageID) => ({
          message_id: messageID,
          pinned_by: people.marina.actor_id,
          pinned_at: "2026-11-10T07:00:00Z",
        })),
      };
    else if (/^\/chats\/[^/]+\/pins$/.test(path)) body = { pins: [] };
    else if (/^\/chats\/[^/]+\/agents$/.test(path)) body = { agents: [] };
    else if (path === `/chats/${chatID}/messages`)
      body = { messages: feed(chatID), next_before_seq: null };
    else if (path === `/chats/${otherChatID}/messages`)
      body = { messages: feed(otherChatID), next_before_seq: null };
    else if (/^\/chats\/[^/]+\/read$/.test(path))
      body = { chat_id: chatID, last_read_seq: 5, last_read_at: nowISO };
    else if (/^\/messages\/[^/]+\/context$/.test(path)) {
      const target = path.split("/")[2];
      const record = [
        ...data.texts,
        ...data.requests,
        ...data.tasks,
        ...data.polls,
      ].find(
        (item) => item.id === target,
      );
      body = { messages: record ? feed(record.chat_id) : [] };
    } else if (/^\/messages\/[^/]+\/reactions$/.test(path))
      body = { reactions: [] };
    else if (path.startsWith("/saved-messages/ids")) body = { message_ids: [] };
    else if (path === "/saved-messages/chats") body = { chats: [] };
    else if (path.startsWith("/saved-messages"))
      body = { items: [], next_cursor: null };
    else if (path === `/chats/${chatID}/requests` && method === "POST") {
      const recipients =
        (input?.audience as { kind: string; actor_ids?: string[] }).kind ===
        "chat"
          ? allMembers
              .filter((item) => item.type === "user" && item.actor_id !== me)
              .map((item) => item.actor_id)
          : ((input?.audience as { actor_ids: string[] }).actor_ids ?? []);
      const answerSpec = input?.answer as {
        preset: RequestRecord["preset"];
        options?: string[];
      };
      const created: RequestRecord = {
        id: id(90 + data.requests.length),
        chat_id: chatID,
        author: me,
        body: String(input?.body),
        created_seq: 10 + data.requests.length,
        created_at: nowISO,
        audience: {
          kind: (input?.audience as { kind: "chat" | "people" }).kind,
          label:
            recipients.length === 1
              ? authorOf(recipients[0]!).display_name
              : "",
        },
        recipients,
        preset: answerSpec.preset,
        options: answerSpec.options,
        allow_comment: input?.allow_comment !== false,
        due_at: (input?.due_at as string) ?? null,
        auto_remind_at: input?.auto_remind ? "2026-11-12T15:00:00Z" : null,
        status: "open",
        closed_reason: null,
        answers: {},
        read: [],
        version: 1,
        next_remind_at: null,
        reminds: 0,
      };
      data.requests.push(created);
      status = 201;
      body = messageOf(created);
    } else if (path === "/requests/inbox") {
      const state = url.searchParams.get("state") ?? "waiting";
      const items =
        state === "waiting"
          ? waitingForMe()
          : data.requests.filter(
              (r) =>
                r.status === "open" &&
                r.answers[me] &&
                r.recipients.includes(me),
            );
      body = { items: items.map(inboxItem), next_cursor: null };
    } else if (requestMatch) {
      const r = data.requests.find((item) => item.id === requestMatch[1]);
      const action = requestMatch[2];
      if (!r) {
        status = 404;
        body = { code: "request_not_found", message: "gone" };
      } else if (!action) body = { request: requestOf(r), viewer: viewerOf(r) };
      else if (action === "answer") {
        const previous = r.answers[me];
        r.answers[me] = {
          option: Number(input?.option),
          comment:
            typeof input?.comment === "string"
              ? input.comment
              : (previous?.comment ?? ""),
          answered_at: previous?.answered_at ?? nowISO,
          late: false,
          version: (previous?.version ?? 0) + 1,
        };
        if (!previous) r.version += 1;
        body = { request: requestOf(r), viewer: viewerOf(r) };
      } else if (action === "answers") {
        const filter = url.searchParams.get("filter") ?? "waiting";
        const items = r.recipients
          .filter((actorID) =>
            filter === "waiting"
              ? !r.answers[actorID]
              : r.answers[actorID]?.option === Number(filter.split(":")[1]),
          )
          .map((actorID) => {
            const given = r.answers[actorID];
            return {
              actor_id: actorID,
              state: given ? "answered" : "waiting",
              option: given?.option ?? null,
              comment: given?.comment ?? "",
              answered_at: given?.answered_at ?? null,
              late: given?.late ?? false,
              read: r.read.includes(actorID),
            };
          });
        body = {
          items,
          counts: {
            waiting: r.recipients.length - Object.keys(r.answers).length,
            options: optionsOf(r).map(
              (_label, index) =>
                Object.values(r.answers).filter((item) => item.option === index)
                  .length,
            ),
          },
          next_cursor: null,
        };
      } else if (action === "remind") {
        r.reminds += 1;
        r.next_remind_at = new Date(now.getTime() + 2 * 3600_000).toISOString();
        body = {
          reminded: r.recipients.length - Object.keys(r.answers).length,
          next_remind_at: r.next_remind_at,
        };
      } else if (action === "close") {
        r.status = "closed";
        r.closed_reason = "author";
        r.version += 1;
        body = { request: requestOf(r), viewer: viewerOf(r) };
      }
    } else if (/^\/polls\/|^\/chats\/[^/]+\/polls$/.test(path)) {
      const result = (pollsOn ? polls.route(method, path, url, input) : null) ?? {
        status: 501,
        body: { error: { code: "not_implemented", message: "", details: {} } },
      };
      status = result.status;
      body = result.body;
    } else if (/^\/(tasks|inbox)\b|^\/chats\/[^/]+\/tasks$/.test(path)) {
      const result = taskRoute(method, path, url, input);
      status = result.status;
      body = result.body;
    } else if (path.startsWith("/reminders/ids")) {
      const chat = url.searchParams.get("chat_id");
      body = {
        reminders: data.reminders
          .filter((item) => item.chat_id === chat && item.message_id)
          .map((item) => ({
            message_id: item.message_id,
            remind_at: item.remind_at,
            state: item.state,
          })),
      };
    } else if (path === "/reminders") {
      const state = url.searchParams.get("state") ?? "pending";
      body = {
        items: data.reminders
          .filter((item) => item.state === state)
          .map(reminderOf),
        next_cursor: null,
      };
    } else if (reminderMatch || reminderByID) {
      const current = reminderMatch
        ? data.reminders.find((item) => item.message_id === reminderMatch[1])
        : data.reminders.find((item) => item.id === reminderByID![1]);
      if (method === "DELETE") {
        data.reminders = data.reminders.filter((item) => item !== current);
        status = 204;
        body = undefined;
      } else {
        const next: ReminderRecord = current
          ? {
              ...current,
              remind_at: String(input?.remind_at),
              note: typeof input?.note === "string" ? input.note : current.note,
              state: "pending",
              fired_at: null,
              version: current.version + 1,
            }
          : {
              id: id(70 + data.reminders.length),
              message_id: reminderMatch![1]!,
              chat_id: chatID,
              note: typeof input?.note === "string" ? input.note : "",
              remind_at: String(input?.remind_at),
              state: "pending",
              fired_at: null,
              late: false,
              version: 1,
            };
        data.reminders = [
          ...data.reminders.filter((item) => item !== current),
          next,
        ];
        body = reminderOf(next);
      }
    } else status = 404;
    await route.fulfill({
      status,
      contentType: "application/json",
      body: body === undefined ? "" : JSON.stringify(body),
    });
  });
  return {
    calls,
    data,
    taskMessage,
    polls,
    emit: (frame: { [key: string]: unknown }) =>
      page.evaluate(
        (value) =>
          (
            window as unknown as { __emitComaEvent(frame: unknown): void }
          ).__emitComaEvent(value),
        frame,
      ),
  };
}
