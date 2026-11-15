import type { Page } from "@playwright/test";

/*
 * A small stateful server for requests («Запрос») and reminders («Напомнить
 * мне»): the contract of phase 6.4 wave 1 in memory, so the web screens can
 * be checked and photographed without a backend. The live server is checked
 * by requests.live.spec.ts.
 */

// Wednesday 11 November 2026, 10:15 in Moscow.
export const now = new Date("2026-11-11T10:15:00+03:00");

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

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

export const ids = {
  mats: id(30),
  planning: id(31),
  saturday: id(32),
  journal: id(33),
  printouts: id(35),
};

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
      read: [people.oleg.actor_id, people.marina.actor_id, people.igor.actor_id],
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
  return { texts, requests, reminders };
}

export async function mockWorkplace(
  page: Page,
  options: {
    theme?: "light" | "dark";
    /** HelloFrame.features; both by default. */
    features?: string[];
    data?: ReturnType<typeof fixtures>;
  } = {},
) {
  const { theme = "light" } = options;
  const features = options.features ?? ["message_requests", "message_reminders"];
  const data = options.data ?? fixtures();
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const me = anna.id;
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
      can_remind: author && open && waiting > 0 && !r.next_remind_at && r.reminds < 5,
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
  const messageOf = (record: TextRecord | RequestRecord) => {
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
    [...data.texts, ...data.requests]
      .filter((item) => item.chat_id === chat)
      .sort((left, right) => left.created_seq - right.created_seq)
      .map(messageOf);
  const savedAuthor = (actorID: string) => {
    const author = authorOf(actorID);
    return {
      actor_id: author.actor_id,
      display_name: author.display_name,
      type: author.type,
      avatar_version: 0,
    };
  };
  const savedChat = { id: chatID, kind: "group", display_name: "Инструкторы · зал" };
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
        },
      ],
      threads: [],
      requests_waiting_total: waiting.length,
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
    if (/request|reminder/.test(path)) calls.push({ method, path, body: input });
    let status = 200;
    let body: unknown = {};
    const requestMatch = /^\/requests\/([^/]+)(?:\/(answer|answers|remind|close))?$/.exec(path);
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
        user: anna,
      };
    else if (path === "/me") body = anna;
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
        chats: [chat(chatID, "Инструкторы · зал", 5), chat(otherChatID, "Общий", 1)],
      };
    else if (path === "/unread") body = unread();
    else if (path === "/drafts") body = { drafts: [] };
    else if (path === "/agents") body = [];
    else if (path === "/scheduled-messages") body = { scheduled_messages: [] };
    else if (path === `/chats/${chatID}/members`) body = { members: allMembers };
    else if (path === `/chats/${otherChatID}/members`)
      body = { members: [people.anna, people.marina] };
    else if (/^\/chats\/[^/]+\/pins$/.test(path)) body = { pins: [] };
    else if (/^\/chats\/[^/]+\/agents$/.test(path)) body = { agents: [] };
    else if (path === `/chats/${chatID}/messages`)
      body = { messages: feed(chatID), next_before_seq: null };
    else if (path === `/chats/${otherChatID}/messages`)
      body = { messages: [], next_before_seq: null };
    else if (/^\/chats\/[^/]+\/read$/.test(path))
      body = { chat_id: chatID, last_read_seq: 5, last_read_at: nowISO };
    else if (/^\/messages\/[^/]+\/context$/.test(path)) {
      const target = path.split("/")[2];
      const record = [...data.texts, ...data.requests].find(
        (item) => item.id === target,
      );
      body = { messages: record ? feed(record.chat_id) : [] };
    } else if (/^\/messages\/[^/]+\/reactions$/.test(path)) body = { reactions: [] };
    else if (path.startsWith("/saved-messages/ids")) body = { message_ids: [] };
    else if (path === "/saved-messages/chats") body = { chats: [] };
    else if (path.startsWith("/saved-messages"))
      body = { items: [], next_cursor: null };
    else if (path === `/chats/${chatID}/requests` && method === "POST") {
      const recipients =
        (input?.audience as { kind: string; actor_ids?: string[] }).kind === "chat"
          ? allMembers
              .filter((item) => item.type === "user" && item.actor_id !== me)
              .map((item) => item.actor_id)
          : ((input?.audience as { actor_ids: string[] }).actor_ids ?? []);
      const answerSpec = input?.answer as { preset: RequestRecord["preset"]; options?: string[] };
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
            recipients.length === 1 ? authorOf(recipients[0]!).display_name : "",
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
              (r) => r.status === "open" && r.answers[me] && r.recipients.includes(me),
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
