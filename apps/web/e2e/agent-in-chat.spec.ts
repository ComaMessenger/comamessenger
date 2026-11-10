import { expect, test, type Page } from "@playwright/test";

// Fictional rehabilitation-centre data for the phase 5.3 chat scenarios.
test.use({ timezoneId: "UTC" });

const org = "00000000-0000-4000-8000-000000000510";
const chatID = "00000000-0000-4000-8000-000000000520";
const people = {
  marina: { id: "00000000-0000-4000-8000-000000000501", name: "Марина Орлова", handle: "marina", role: "admin" },
  vera: { id: "00000000-0000-4000-8000-000000000502", name: "Вера Лисина", handle: "vera", role: "member" },
  igor: { id: "00000000-0000-4000-8000-000000000503", name: "Игорь Сомов", handle: "igor", role: "member" },
  oleg: { id: "00000000-0000-4000-8000-000000000504", name: "Олег Тарасов", handle: "oleg", role: "member" },
} as const;
const agents = {
  control: { id: "00000000-0000-4000-8000-000000000531", name: "Контроль", handle: "control" },
  slots: { id: "00000000-0000-4000-8000-000000000532", name: "Слоты", handle: "slots" },
  handover: { id: "00000000-0000-4000-8000-000000000533", name: "Передача", handle: "handover" },
  help: { id: "00000000-0000-4000-8000-000000000534", name: "Справка", handle: "help" },
  forms: { id: "00000000-0000-4000-8000-000000000535", name: "Оформитель", handle: "forms" },
} as const;
type PersonKey = keyof typeof people;

const ids = {
  control: "00000000-0000-4000-8000-000000000541",
  poll: "00000000-0000-4000-8000-000000000542",
  slots: "00000000-0000-4000-8000-000000000543",
  handover: "00000000-0000-4000-8000-000000000544",
  answer: "00000000-0000-4000-8000-000000000545",
  notFound: "00000000-0000-4000-8000-000000000546",
  confirmation: "00000000-0000-4000-8000-000000000547",
  future: "00000000-0000-4000-8000-000000000548",
  quoted: "00000000-0000-4000-8000-000000000549",
  document: "00000000-0000-4000-8000-000000000550",
  confirmationID: "00000000-0000-4000-8000-000000000551",
};

function message(
  id: string,
  actorID: string,
  seq: number,
  time: string,
  body: string,
  blocks?: Record<string, unknown>,
) {
  return {
    id,
    chat_id: chatID,
    actor_id: actorID,
    client_msg_id: id.replace(/0005/, "0006"),
    type: "text",
    body,
    body_format: "plain",
    version: 1,
    created_seq: seq,
    created_at: `2026-11-12T${time}:00Z`,
    mentioned_actor_ids: [],
    files: [],
    thread_reply_count: 0,
    ...(blocks ? { blocks } : {}),
  };
}

const action = (patch: Record<string, unknown>) => ({
  style: "secondary",
  limit: "per_actor",
  closed: false,
  responses: [],
  ...patch,
});

function history() {
  return [
    message(ids.control, agents.control.id, 10, "07:00", "Порядок входа с понедельника [Отметились 6 из 9]", {
      version: 1,
      card: {
        title: "Порядок входа с понедельника",
        status: { label: "Отметились 6 из 9", tone: "warning" },
        fields: [
          { label: "Не отметились", value: "Олег Тарасов, Вера Лисина, Павел Нестеров" },
          { label: "Напоминание", value: "Напомнил каждому в личных сообщениях. Следующее — в пятницу в 10:00" },
        ],
      },
      actions: [
        action({ id: "who", label: "Кто отметился", allowed: { actor_ids: [people.marina.id] } }),
        action({ id: "friday", label: "Показать итог в пятницу", allowed: { actor_ids: [people.marina.id] } }),
      ],
      sources: [{ kind: "message", message_id: ids.quoted, title: "Марина Орлова, 09:30" }],
    }),
    message(ids.poll, agents.slots.id, 11, "08:15", "Нужен инструктор: чт 14:00–18:00 · зал 2", {
      version: 1,
      card: {
        title: "Нужен инструктор: чт 14:00–18:00 · зал 2",
        fields: [{ label: "Группы", value: "Две группы ЛФК" }],
      },
      actions: [
        action({
          id: "can",
          label: "Могу",
          style: "primary",
          group: "answer",
          allowed: { actor_ids: [people.igor.id, people.vera.id, people.oleg.id] },
          responses: [{ actor_id: people.igor.id, responded_at: "2026-11-12T08:20:00Z" }],
        }),
        action({
          id: "cannot",
          label: "Не могу",
          group: "answer",
          allowed: { actor_ids: [people.igor.id, people.vera.id, people.oleg.id] },
          responses: [],
        }),
      ],
    }),
    message(ids.slots, agents.slots.id, 12, "08:40", "Слот: чт 14:00–18:00 · зал 2 [2 из 3 ответили]", {
      version: 1,
      card: {
        title: "Слот: чт 14:00–18:00 · зал 2",
        status: { label: "2 из 3 ответили", tone: "warning" },
        fields: [
          { label: "Игорь Сомов", value: "Могу" },
          { label: "Вера Лисина", value: "Не могу" },
          { label: "Олег Тарасов", value: "Нет ответа · напомнил в 11:15" },
        ],
      },
      actions: [
        action({
          id: "assign",
          label: "Назначить Игоря",
          style: "primary",
          limit: "single",
          group: "decision",
          allowed: { chat_roles: ["owner", "admin"] },
        }),
        action({
          id: "wait",
          label: "Подождать Олега",
          limit: "single",
          group: "decision",
          allowed: { chat_roles: ["owner", "admin"] },
        }),
      ],
    }),
    message(ids.handover, agents.handover.id, 13, "10:45", "Вера, перед вашим слотом 14:00–18:00", {
      version: 1,
      card: {
        title: "Вера, перед вашим слотом 14:00–18:00",
        status: { label: "Не прочитано", tone: "warning" },
        fields: [
          { label: "От Игоря", value: "Группа 15:00: двое новеньких, начать с разминки на ковриках" },
          { label: "Оборудование", value: "Велотренажёр №3 не использовать" },
          { label: "Зал", value: "Течёт кондиционер, под ним ведро. Администраторы в курсе" },
        ],
      },
      actions: [
        action({
          id: "accept",
          label: "Принял слот",
          style: "primary",
          limit: "single",
          allowed: { actor_ids: [people.vera.id] },
        }),
      ],
      sources: [
        { kind: "message", message_id: ids.quoted, title: "Игорь, 13:04" },
        { kind: "document", document_id: ids.document, title: "Расписание слотов.xlsx" },
      ],
    }),
    message(
      ids.answer,
      agents.help.id,
      14,
      "11:02",
      "Замена в день занятия оформляется так: до 08:00 напишите дежурному администратору, какие занятия затронуты; он подберёт замену того же профиля.",
      {
        version: 1,
        sources: [
          {
            kind: "document",
            document_id: ids.document,
            title: "Регламент замен · п. 2.1",
            excerpt: "Заболевший инструктор сообщает дежурному администратору до 08:00.",
          },
          { kind: "message", message_id: ids.quoted, title: "Марина Орлова, 12 сентября" },
        ],
      },
    ),
    message(
      ids.notFound,
      agents.help.id,
      15,
      "11:20",
      "В доступных мне документах ответа нет, придумывать не буду. Передал вопрос Марине Орловой.",
    ),
    message(ids.confirmation, agents.forms.id, 16, "12:30", "send_direct_message [Approval required]", {
      version: 1,
      card: {
        title: "send_direct_message",
        status: { label: "Approval required", tone: "warning" },
        fields: [
          { label: "actor_id", value: people.marina.id },
          { label: "body", value: "Служебная записка: коврики — 20 шт., фитболы — 6 шт., зал 3, до 30 ноября" },
          { label: "client_msg_id", value: "00000000-0000-4000-8000-000000000599" },
        ],
      },
      actions: [
        action({
          id: "approve",
          label: "Approve",
          style: "primary",
          limit: "single",
          group: "decision",
          allowed: { permissions: ["agents.approve"] },
          binding: { kind: "tool_confirmation", confirmation_id: ids.confirmationID, decision: "approve" },
        }),
        action({
          id: "deny",
          label: "Deny",
          style: "danger",
          limit: "single",
          group: "decision",
          allowed: { permissions: ["agents.approve"] },
          binding: { kind: "tool_confirmation", confirmation_id: ids.confirmationID, decision: "deny" },
        }),
      ],
    }),
    message(ids.future, agents.forms.id, 17, "12:40", "Карточка нового формата: открыть в обновлённом приложении", {
      version: 2,
      card: { title: "Неизвестная карточка" },
    }),
  ];
}

const chatAgents = [
  {
    agent_id: agents.handover.id,
    display_name: agents.handover.name,
    handle: agents.handover.handle,
    description: "Что оставить следующему",
    avatar_version: 0,
    status: "active",
    scopes: ["messages:read", "messages:write", "messages:interactive", "followups:write"],
    knowledge_collection_count: 0,
    triggers: [
      { type: "command", command: "передать" },
      { type: "schedule", schedule: { hour: 13, minute: 0, days_of_week: [1, 2, 3, 4, 5], timezone: "Europe/Moscow" } },
    ],
    can_manage: true,
  },
  {
    agent_id: agents.help.id,
    display_name: agents.help.name,
    handle: agents.help.handle,
    description: "Ответ по регламентам",
    avatar_version: 0,
    status: "active",
    scopes: ["messages:read", "messages:write", "knowledge:read"],
    knowledge_collection_count: 2,
    triggers: [{ type: "mention" }, { type: "command", command: "спросить" }],
    can_manage: true,
  },
  {
    agent_id: agents.forms.id,
    display_name: agents.forms.name,
    handle: agents.forms.handle,
    description: "Документ по шаблону",
    avatar_version: 0,
    status: "paused",
    scopes: ["messages:read", "messages:write"],
    knowledge_collection_count: 0,
    triggers: [{ type: "command", command: "оформить" }],
    can_manage: true,
  },
];

async function mockAgentChat(page: Page, viewerKey: PersonKey) {
  const viewer = people[viewerKey];
  const user = {
    id: viewer.id,
    org_id: org,
    organization_name: "Реабилитационный центр",
    role: viewerKey === "marina" ? "owner" : "member",
    permissions: [],
    email: `${viewer.handle}@example.test`,
    display_name: viewer.name,
    handle: viewer.handle,
    title: "",
    about: "",
    timezone: "UTC",
    status: "active",
    must_change_password: false,
    can_create_invitations: false,
    status_emoji: "",
    status_text: "",
    status_expires_at: null,
    created_at: "2026-11-01T00:00:00Z",
    avatar_version: 0,
  };
  const messages = history();
  const presses: string[] = [];
  let agentList = structuredClone(chatAgents);
  const chat = {
    id: chatID,
    kind: "group",
    visibility: "private",
    name: "Инструкторы",
    topic: "",
    role: viewerKey === "marina" ? "admin" : "member",
    created_at: "2026-11-01T00:00:00Z",
    display_name: "Инструкторы",
    avatar_seed: "instructors",
    avatar_version: 0,
    notify_level: "default",
    muted_until: null,
    last_activity_seq: 17,
    last_message_at: "2026-11-12T12:40:00Z",
    last_message: {
      id: ids.future,
      actor_id: agents.forms.id,
      actor_display_name: agents.forms.name,
      body: "Карточка",
      created_seq: 17,
      created_at: "2026-11-12T12:40:00Z",
      deleted: false,
    },
  };
  const member = (
    id: string,
    name: string,
    handle: string,
    type: "user" | "agent",
    role = "member",
  ) => ({
    actor_id: id,
    type,
    display_name: name,
    handle,
    title: "",
    role,
    joined_at: "2026-11-01T00:00:00Z",
    status_emoji: "",
    status_text: "",
    status_expires_at: null,
    avatar_version: 0,
  });
  const members = [
    ...Object.values(people).map((person) => member(person.id, person.name, person.handle, "user", person.role)),
    ...Object.values(agents).map((agent) => member(agent.id, agent.name, agent.handle, "agent")),
  ];

  await page.addInitScript(() => {
    localStorage.setItem("coma-locale", "ru");
    localStorage.setItem("coma-theme", "light");
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
                  connection_id: "00000000-0000-4000-8000-000000000599",
                  current_seq: 17,
                  min_retained_seq: 0,
                  heartbeat_interval_ms: 25000,
                  ack_interval_ms: 1000,
                  ack_batch_size: 50,
                  max_unacked_events: 128,
                }),
              }),
            0,
          );
      }
      close() {}
    }
    Object.assign(window, {
      WebSocket: FakeSocket,
      __emitComaEvent: (frame: unknown) => FakeSocket.latest?.onmessage?.({ data: JSON.stringify(frame) }),
    });
  });

  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    let status = 200;
    let body: unknown = {};
    const pressed = /\/messages\/([^/]+)\/actions\/([^/]+)$/.exec(path);
    if (path.endsWith("/bootstrap/status")) body = { bootstrapped: true };
    else if (path.endsWith("/branding"))
      body = { workspace_name: user.organization_name, accent_color: "#174586", version: 1 };
    else if (path.endsWith("/auth/refresh"))
      body = { access_token: "test", access_expires_at: "2027-01-01T00:00:00Z", user };
    else if (path.endsWith("/me")) body = user;
    else if (path.endsWith(`/chats/${chatID}/agents`)) body = { agents: agentList };
    else if (path.endsWith("/agents")) body = [];
    else if (path.endsWith("/chats")) body = { chats: [chat] };
    else if (path.endsWith("/preferences/chat-folders") || path.endsWith("/preferences/pinned-chats")) body = [];
    else if (path.endsWith("/preferences"))
      body = {
        theme: "light",
        locale: "ru",
        in_app_enabled: false,
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
    else if (path.endsWith("/unread"))
      body = { chats: [{ chat_id: chatID, last_read_seq: 17, unread_count: 0, mention_count: 0 }], threads: [] };
    else if (path.endsWith("/drafts")) body = { drafts: [] };
    else if (path.endsWith("/threads")) body = { threads: [], next_before_seq: null };
    else if (path.endsWith(`/chats/${chatID}/members`)) body = { members };
    else if (path.endsWith(`/chats/${chatID}/pins`)) body = { pins: [] };
    else if (path.endsWith(`/chats/${chatID}/notification-preferences`))
      body = { notify_level: "default", muted_until: null };
    else if (path.endsWith(`/chats/${chatID}/messages`) && request.method() === "GET")
      body = { messages, next_before_seq: null };
    else if (path.endsWith(`/chats/${chatID}/read`))
      body = { chat_id: chatID, last_read_seq: 17, last_read_at: "2026-11-12T12:40:00Z" };
    else if (/\/agents\/[^/]+\/pause$/.test(path)) {
      const agentID = path.split("/").at(-2);
      agentList = agentList.map((item) => (item.agent_id === agentID ? { ...item, status: "paused" } : item));
      body = {};
    } else if (pressed) {
      const [, messageID, actionID] = pressed;
      presses.push(`${messageID}/${actionID}`);
      const target = messages.find((item) => item.id === messageID)!;
      const blocks = target.blocks as { actions: Array<Record<string, unknown>> };
      const current = blocks.actions.find((item) => item.id === actionID)!;
      const responses = current.responses as Array<{ actor_id: string; responded_at: string }>;
      const replayed = responses.some((item) => item.actor_id === viewer.id);
      const response = { actor_id: viewer.id, responded_at: "2026-11-12T10:52:00Z" };
      if (!replayed) {
        responses.push(response);
        if (current.limit === "single")
          for (const sibling of blocks.actions)
            if (sibling === current || (current.group && sibling.group === current.group)) sibling.closed = true;
        target.version += 1;
      }
      // A slow server makes a double click observable.
      await new Promise((resolve) => setTimeout(resolve, 150));
      body = { message: target, action_id: actionID, response, replayed };
    } else if (/\/messages\/[^/]+\/reactions$/.test(path)) body = { reactions: [] };
    else if (/\/messages\/[^/]+\/context$/.test(path))
      body = { messages, target_id: path.split("/").at(-2), has_earlier: false, has_later: false };
    else if (path.endsWith("/knowledge/collections/00000000-0000-4000-8000-000000000560"))
      body = {
        id: "00000000-0000-4000-8000-000000000560",
        name: "Регламенты центра",
        description: "",
        access: "organization",
        chat_ids: [],
        embedding_connection_id: null,
        document_count: 1,
        semantic_search: false,
        can_manage: false,
        created_by: people.marina.id,
        created_at: "2026-11-01T00:00:00Z",
        updated_at: "2026-11-01T00:00:00Z",
      };
    else if (path.endsWith(`/knowledge/documents/${ids.document}/fragments`))
      body = {
        fragments: [
          { chunk_id: "00000000-0000-4000-8000-000000000571", position: 0, section: "Регламент замен", content: "Регламент действует для всех инструкторов центра." },
          {
            chunk_id: "00000000-0000-4000-8000-000000000572",
            position: 1,
            section: "Регламент замен › 2.1. Замена в день занятия",
            content: "Заболевший инструктор сообщает дежурному администратору до 08:00. Администратор подбирает замену того же профиля.",
          },
        ],
        truncated: false,
      };
    else if (path.endsWith(`/knowledge/documents/${ids.document}`))
      body = {
        id: ids.document,
        collection_id: "00000000-0000-4000-8000-000000000560",
        kind: "page",
        title: "Регламент замен",
        file_id: null,
        file_name: null,
        file_mime: null,
        file_size: null,
        body: "## 2.1. Замена в день занятия\n\nЗаболевший инструктор сообщает дежурному администратору до 08:00.",
        status: "ready",
        error_code: "",
        embedding_status: "none",
        chunk_count: 3,
        content_version: 1,
        indexed_at: "2026-11-01T00:00:00Z",
        created_by: people.marina.id,
        created_at: "2026-11-01T00:00:00Z",
        updated_at: "2026-11-01T00:00:00Z",
      };
    else status = 404;
    await route.fulfill({
      status,
      contentType: "application/json",
      body: status === 404 ? JSON.stringify({ code: "not_found", message: "not found" }) : JSON.stringify(body),
    });
  });
  return { presses };
}

const card = (page: Page, id: string) => page.locator(`#message-${id}`);

async function openChat(page: Page) {
  await page.goto(`/chat/${chatID}`);
  await expect(page.locator(".conversation-head h1")).toHaveText("Инструкторы");
}

async function reveal(page: Page, id: string) {
  const row = card(page, id);
  await row.scrollIntoViewIfNeeded();
  await expect(row).toBeVisible();
  return row;
}

test("Контроль: отчёт об отметившихся читается как карточка", async ({ page }) => {
  await mockAgentChat(page, "marina");
  await openChat(page);
  const row = await reveal(page, ids.control);
  await expect(row.getByText("Отметились 6 из 9")).toBeVisible();
  await expect(row.getByText("Олег Тарасов, Вера Лисина, Павел Нестеров")).toBeVisible();
  // The server fallback body is replaced by the card.
  await expect(row.getByText("Порядок входа с понедельника [Отметились 6 из 9]")).toHaveCount(0);
  await expect(row.getByRole("button", { name: "Кто отметился" })).toBeEnabled();
  await expect(row.locator(".agent-blocks")).toHaveScreenshot("agent-control-report.png", { animations: "disabled" });
});

test("Слоты: опрос виден администратору, решение принимает он", async ({ page }) => {
  const mock = await mockAgentChat(page, "marina");
  await openChat(page);
  const poll = await reveal(page, ids.poll);
  // The poll is addressed to instructors: the administrator sees it, cannot answer.
  await expect(poll.getByRole("button", { name: "Могу", exact: true })).toBeDisabled();
  await expect(poll.getByText("Эту кнопку может нажать только тот, кому адресована карточка")).toBeVisible();

  const slots = await reveal(page, ids.slots);
  await expect(slots.getByText("Нет ответа · напомнил в 11:15")).toBeVisible();
  const assign = slots.getByRole("button", { name: "Назначить Игоря" });
  await assign.dblclick();
  await expect(slots.getByText("Марина Орлова · 10:52")).toBeVisible();
  await expect(slots.getByRole("button", { name: "Подождать Олега" })).toHaveCount(0);
  expect(mock.presses).toEqual([`${ids.slots}/assign`]);
  await expect(slots.locator(".agent-blocks")).toHaveScreenshot("agent-slots-decided.png", { animations: "disabled" });
});

test("Передача: заступающий принимает слот одной кнопкой", async ({ page }) => {
  const mock = await mockAgentChat(page, "vera");
  await openChat(page);
  const row = await reveal(page, ids.handover);
  await expect(row.getByText("Велотренажёр №3 не использовать")).toBeVisible();
  const accept = row.getByRole("button", { name: "Принял слот" });
  await accept.click();
  await accept.click({ force: true }).catch(() => undefined);
  await expect(row.getByText("Вера Лисина · 10:52")).toBeVisible();
  expect(mock.presses).toEqual([`${ids.handover}/accept`]);
  // Vera, an instructor, can answer the slot poll; the administrator decision stays closed to her.
  const poll = await reveal(page, ids.poll);
  await poll.getByRole("button", { name: "Не могу" }).click();
  await expect(poll.getByText("Вы ответили", { exact: true })).toBeVisible();
  await expect(poll.getByRole("button", { name: "Могу", exact: true })).toBeDisabled();
  const slots = await reveal(page, ids.slots);
  await expect(slots.getByRole("button", { name: "Назначить Игоря" })).toBeDisabled();
  await expect(row.locator(".agent-blocks")).toHaveScreenshot("agent-handover-accepted.png", { animations: "disabled" });
});

test("Справка: ответ с источниками и честное «не нашёл»", async ({ page }) => {
  await mockAgentChat(page, "marina");
  await openChat(page);
  const answer = await reveal(page, ids.answer);
  await expect(answer.getByText(/Замена в день занятия оформляется так/)).toBeVisible();
  const sources = answer.getByRole("list", { name: "Источники" });
  await expect(sources.getByRole("button")).toHaveCount(2);
  await expect(answer.locator(".agent-blocks")).toHaveScreenshot("agent-answer-sources.png", { animations: "disabled" });
  // The cited document opens on its knowledge base page, quoted fragment in focus.
  await sources.getByRole("button", { name: "Регламент замен · п. 2.1" }).click();
  await expect(page).toHaveURL(new RegExp(`/knowledge/00000000-0000-4000-8000-000000000560/${ids.document}\\?quote=`));
  const quoted = page.locator(".knowledge-fragment--focus");
  await expect(quoted).toContainText("На этот фрагмент сослался агент");
  await expect(quoted).toContainText("2.1. Замена в день занятия");
  await expect(quoted.locator("mark")).toHaveText("Заболевший инструктор сообщает дежурному администратору до 08:00.");
  await page.goBack();
  await expect(page.locator(".conversation-head h1")).toHaveText("Инструкторы");
  // Without read access to the collection the reader gets an explanation.
  await page.route(`**/api/v1/knowledge/documents/${ids.document}`, (route) =>
    route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ code: "knowledge_not_found", message: "not found" }) }),
  );
  const again = await reveal(page, ids.answer);
  await again.getByRole("list", { name: "Источники" }).getByRole("button", { name: "Регламент замен · п. 2.1" }).click();
  await expect(page.getByText("Документ недоступен: он удалён или у вас нет к нему доступа")).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/chat/${chatID}`));
  const notFound = await reveal(page, ids.notFound);
  await expect(notFound.getByText(/ответа нет, придумывать не буду/)).toBeVisible();
  await expect(notFound.locator(".agent-sources")).toHaveCount(0);
  // An unknown blocks version falls back to the text body.
  const future = await reveal(page, ids.future);
  await expect(future.getByText("Карточка нового формата: открыть в обновлённом приложении")).toBeVisible();
  await expect(future.locator(".agent-blocks")).toHaveCount(0);
});

test("подтверждение действия агента локализовано и решается в чате", async ({ page }) => {
  const mock = await mockAgentChat(page, "marina");
  await openChat(page);
  const row = await reveal(page, ids.confirmation);
  await expect(row.getByText("Оформитель просит разрешения")).toBeVisible();
  await expect(row.getByText("Хочет написать человеку в личные сообщения")).toBeVisible();
  await expect(row.getByText("Ждёт решения")).toBeVisible();
  await expect(row.getByText("Кому")).toBeVisible();
  await expect(row.getByText(/Approval required|Approve|send_direct_message|client_msg_id/)).toHaveCount(0);
  await expect(row.getByText("00000000-0000-4000-8000-000000000599")).toHaveCount(0);
  await expect(row.locator(".agent-blocks")).toHaveScreenshot("agent-confirmation.png", { animations: "disabled" });
  await row.getByRole("button", { name: "Разрешить" }).click();
  await expect(row.getByText("Марина Орлова · 10:52")).toBeVisible();
  await expect(row.getByRole("button", { name: "Отклонить" })).toHaveCount(0);
  expect(mock.presses).toEqual([`${ids.confirmation}/approve`]);
});

test("меню команд по «/» показывает команды агентов чата", async ({ page }) => {
  await mockAgentChat(page, "marina");
  await openChat(page);
  const input = page.getByRole("combobox", { name: "Сообщение или / для команд агентов" });
  await input.click();
  await input.fill("/");
  const menu = page.getByRole("listbox", { name: "Команды агентов" });
  await expect(menu.getByRole("option")).toHaveCount(2);
  await expect(menu.getByRole("option").first()).toContainText("/передать");
  await expect(menu.getByRole("option").first()).toContainText("Передача · Что оставить следующему");
  // The paused agent's command is not offered.
  await expect(menu.getByText("/оформить")).toHaveCount(0);
  await expect(page.locator(".command-menu")).toHaveScreenshot("agent-command-menu.png", { animations: "disabled" });
  await input.press("ArrowDown");
  await expect(menu.getByRole("option", { selected: true })).toContainText("/спросить");
  await input.press("Enter");
  await expect(input).toHaveValue("/спросить ");
  await expect(menu).toHaveCount(0);
  await input.fill("/спр");
  await expect(page.getByRole("listbox", { name: "Команды агентов" }).getByRole("option")).toHaveCount(1);
  await input.press("Escape");
  await expect(page.getByRole("listbox", { name: "Команды агентов" })).toHaveCount(0);
  await expect(input).toHaveValue("/спр");
});

test("панель «Агенты в этом чате» объясняет агентов и ставит на паузу", async ({ page }) => {
  await mockAgentChat(page, "marina");
  await openChat(page);
  await page.getByRole("button", { name: "О чате" }).click();
  const dialog = page.getByRole("dialog");
  const panel = dialog.locator(".chat-agents");
  await panel.scrollIntoViewIfNeeded();
  await expect(panel.getByText("Агенты в этом чате")).toBeVisible();
  const handover = panel.locator(".chat-agents__item").filter({ hasText: "Передача" });
  await expect(handover.getByText(/по команде \/передать; по расписанию: пн, вт, ср, чт, пт в 13:00/i)).toBeVisible();
  await expect(handover.getByText("публикует карточки с кнопками и опрашивает людей", { exact: false })).toBeVisible();
  const help = panel.locator(".chat-agents__item").filter({ hasText: "Справка" });
  await expect(help.getByText(/базу знаний: 2 коллекции/)).toBeVisible();
  await expect(panel.locator(".chat-agents__item").filter({ hasText: "Оформитель" }).getByText("На паузе")).toBeVisible();
  await expect(panel.getByText(/messages:read|knowledge:read/)).toHaveCount(0);
  await expect(handover).toHaveScreenshot("agent-chat-panel.png", { animations: "disabled" });
  await handover.getByRole("button", { name: "Приостановить" }).click();
  await expect(page.getByText("Передача на паузе")).toBeVisible();
  await expect(handover.getByText("На паузе")).toBeVisible();
  await expect(handover.getByRole("button", { name: "Возобновить" })).toBeVisible();
});
