import { expect, test, type Page } from "@playwright/test";

/*
 * The agent Architect on a mock API. The mock plays the server: it keeps the
 * conversation, answers with the questions of the prototype scenario
 * («Передача») and writes the draft step by step, so the passport can only
 * show what the "server" saved. Data is fictional.
 */

const orgID = "00000000-0000-4000-8000-000000000010";
const owner = {
  id: "00000000-0000-4000-8000-000000000001",
  org_id: orgID,
  organization_name: "Test space",
  role: "owner",
  email: "owner@example.com",
  display_name: "Анна",
  handle: "anna",
  title: "Администратор",
  about: "",
  timezone: "Europe/Moscow",
  status: "active",
  must_change_password: false,
  can_create_invitations: true,
  status_emoji: "",
  status_text: "",
  status_expires_at: null,
  created_at: "2026-08-19T00:00:00Z",
};

function chatOf(id: string, name: string) {
  return {
    id,
    kind: "group",
    visibility: "private",
    name,
    topic: "",
    role: "admin",
    created_at: "2026-08-19T00:00:00Z",
    display_name: name,
    avatar_seed: id,
    notify_level: "default",
    muted_until: null,
    last_activity_seq: 1,
    last_message_at: "2026-08-19T06:30:00Z",
    last_message: null,
  };
}
const hall = chatOf("00000000-0000-4000-8000-0000000000a1", "Зал 1");
const instructors = chatOf(
  "00000000-0000-4000-8000-0000000000a2",
  "Инструкторы",
);

const connection = {
  id: "00000000-0000-4000-8000-0000000000c1",
  name: "Модель пространства",
  provider: "openai",
  endpoint_url: "",
  default_model: "gpt-5-mini",
  enabled: true,
  key_hint: "sk-…a1",
  health_status: "healthy",
  last_tested_at: "2026-11-10T08:00:00Z",
  last_error_code: "",
  created_at: "2026-11-01T00:00:00Z",
  updated_at: "2026-11-01T00:00:00Z",
};
const schedule = {
  id: "00000000-0000-4000-8000-0000000000d2",
  name: "Расписание слотов",
  description: "",
  access: "organization",
  chat_ids: [],
  embedding_connection_id: null,
  document_count: 1,
  can_manage: true,
  created_by: owner.id,
  created_at: "2026-11-01T00:00:00Z",
  updated_at: "2026-11-01T00:00:00Z",
};

const draftID = "00000000-0000-4000-8000-0000000000b9";
const sessionID = "00000000-0000-4000-8000-0000000000f1";
const existingID = "00000000-0000-4000-8000-0000000000b2";
const now = new Date("2026-11-10T09:00:00Z");

type Json = Record<string, unknown>;

function agentOf(patch: Json): Json {
  return {
    org_id: orgID,
    owner_actor_id: owner.id,
    display_name: "Агент",
    handle: "agent_x",
    kind: "builtin",
    recipe: "custom",
    recipe_version: 1,
    description: "",
    enabled: false,
    allowed_scopes: ["messages:read", "runtime:execute"],
    llm_connection_id: connection.id,
    provider: "openai",
    model: "gpt-5-mini",
    endpoint_url: "",
    external_data_sharing_approved: false,
    daily_cost_limit: null,
    monthly_cost_limit: null,
    max_output_tokens: 2048,
    max_tool_iterations: 8,
    max_chain_depth: 3,
    per_chat_concurrency: 1,
    rate_limit_per_minute: 60,
    provider_rate_limit_per_minute: 300,
    execution_timeout_seconds: 600,
    chat_ids: [],
    knowledge_collection_ids: [],
    mcp_bindings: [],
    avatar_version: 0,
    readiness: {
      state: "needs_setup",
      ready: false,
      blockers: ["external_data_approval_required"],
    },
    operational_status: "draft",
    draft_version: 1,
    published_version: null,
    has_unpublished_changes: true,
    published_at: null,
    created_at: "2026-11-10T09:00:00Z",
    updated_at: "2026-11-10T09:00:00Z",
    ...patch,
  };
}

const message = (
  role: "user" | "assistant",
  text: string,
  kind = "text",
  options: string[] = [],
  assumptions: string[] = [],
) => ({
  id: `m-${Math.random().toString(36).slice(2)}`,
  role,
  kind,
  text,
  options,
  assumptions,
  created_at: now.toISOString(),
});

/** The prototype scenario, played by the mock server one answer at a time. */
const script: Array<
  (agent: Json | undefined) => {
    reply: ReturnType<typeof message>;
    agent?: Json;
    triggers?: Json[];
    examples?: Json[];
  }
> = [
  () => ({
    reply: message(
      "assistant",
      "Понял: когда один инструктор уходит, а другой заступает, агент передаст главное. Откуда брать расписание слотов?",
      "question",
      [
        "Таблица «Расписание слотов» в базе знаний",
        "Администратор пишет его в чат",
      ],
    ),
    agent: agentOf({
      id: draftID,
      display_name: "Передача",
      handle: "agent_pass1",
      description:
        "Передаёт дела между слотами инструкторов.\n\nКогда слот заканчивается, собери от уходящего инструктора, что важно знать заступающему.",
    }),
  }),
  (agent) => ({
    reply: message(
      "assistant",
      "Как собирать то, что нужно передать?",
      "question",
      [
        "Спросить уходящего в личных сообщениях",
        "Собрать из сообщений чата зала",
        "И то, и другое",
      ],
    ),
    agent: {
      ...agent,
      knowledge_collection_ids: [schedule.id],
      allowed_scopes: ["messages:read", "knowledge:read", "runtime:execute"],
    },
  }),
  (agent) => ({
    reply: message(
      "assistant",
      "Последнее. За сколько до начала слота сообщать заступающему?",
      "question",
      ["За 15 минут", "За час", "Утром в день слота"],
    ),
    agent: {
      ...agent,
      chat_ids: [hall.id, instructors.id],
      allowed_scopes: [
        "messages:read",
        "messages:write",
        "messages:interactive",
        "search:read",
        "knowledge:read",
        "runtime:execute",
      ],
    },
  }),
  (agent) => ({
    reply: message(
      "assistant",
      "Готово, агент собран. Я подготовил проверку на трёх случаях: обычная передача, уходящий ничего не ответил, следующего слота сегодня нет.",
      "done",
      [],
      ["Слоты длятся по расписанию из таблицы, без переносов"],
    ),
    agent,
    triggers: [
      {
        id: "trigger-architect",
        org_id: orgID,
        agent_id: draftID,
        type: "schedule",
        config: {
          chat_id: instructors.id,
          hour: 8,
          minute: 45,
          days_of_week: [1, 2, 3, 4, 5],
        },
        enabled: true,
        timezone: "Europe/Moscow",
        missed_runs_policy: "skip",
        created_at: now.toISOString(),
        updated_at: now.toISOString(),
      },
    ],
    examples: [
      {
        prompt: "Слот Ивана закончился, через 15 минут заступает Мария",
        expectation: "Спросит Ивана, что передать, и напишет Марии",
        chat_id: null,
      },
      {
        prompt: "Уходящий инструктор не ответил",
        expectation: "Передаст то, что нашёл в чате зала, и скажет об этом",
        chat_id: null,
      },
      {
        prompt: "Следующего слота сегодня нет",
        expectation: "Ничего не отправит",
        chat_id: null,
      },
    ],
  }),
];

async function mockArchitect(
  page: Page,
  options: { noConnection?: boolean; existing?: boolean } = {},
) {
  const sent: string[] = [];
  let agents: Json[] = options.existing
    ? [
        agentOf({
          id: existingID,
          display_name: "Контроль",
          handle: "control",
          description: "Следит, чтобы все отметились под важным сообщением.",
          enabled: true,
          external_data_sharing_approved: true,
          chat_ids: [instructors.id],
          allowed_scopes: [
            "messages:read",
            "messages:write",
            "messages:interactive",
            "runtime:execute",
          ],
          operational_status: "active",
          published_version: 2,
          draft_version: null,
          has_unpublished_changes: false,
          published_at: "2026-11-05T09:00:00Z",
          readiness: { state: "active", ready: true, blockers: [] },
        }),
      ]
    : [];
  let triggers: Json[] = [];
  let step = 0;
  const session = {
    id: sessionID,
    agent_id: null as string | null,
    status: "active",
    locale: "ru",
    questions_asked: 0,
    max_questions: 4,
    messages: [] as Json[],
    test_examples: [] as Json[],
    assumptions: [] as string[],
    connection: {
      id: connection.id,
      name: connection.name,
      model: "gpt-5-mini",
      available: true,
    },
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cost: "0.00000000",
      currency: "USD",
    },
    thinking: false,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    expires_at: "2026-11-11T09:00:00Z",
  };

  await page.addInitScript(() => {
    localStorage.setItem("coma-locale", "ru");
    localStorage.setItem("coma-theme", "light");
    class FakeSocket {
      static OPEN = 1;
      readyState = 1;
      onopen: null | (() => void) = null;
      onmessage: null | ((event: { data: string }) => void) = null;
      onclose: null | ((event: { code: number }) => void) = null;
      constructor() {
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
                  current_seq: 1,
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
    Object.assign(window, { WebSocket: FakeSocket });
  });

  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const method = request.method();
    const path = new URL(request.url()).pathname.replace(/^\/api\/v1/, "");
    let status = 200;
    let body: unknown = undefined;
    const agentMatch = path.match(/^\/agents\/([^/]+)(\/.*)?$/);

    if (path === "/bootstrap/status") body = { bootstrapped: true };
    else if (path === "/branding")
      body = {
        workspace_name: "Test space",
        accent_color: "#174586",
        version: 1,
        password_recovery_available: false,
        email_delivery_available: false,
      };
    else if (path === "/auth/refresh")
      body = {
        access_token: "test",
        access_expires_at: "2099-01-01T00:00:00Z",
        user: owner,
      };
    else if (path === "/me") body = owner;
    else if (path === "/preferences")
      body = {
        theme: "light",
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
    else if (
      path === "/preferences/chat-folders" ||
      path === "/preferences/pinned-chats"
    )
      body = [];
    else if (path === "/push/config") body = { enabled: false, public_key: "" };
    else if (path === "/chats") body = { chats: [hall, instructors] };
    else if (path === "/drafts") body = { drafts: [] };
    else if (path === "/unread") body = { chats: [], threads: [] };
    else if (path === "/threads") body = { threads: [], next_before_seq: null };
    else if (path === "/agent-connections")
      body = options.noConnection ? [] : [connection];
    else if (path === "/knowledge/collections") body = [schedule];
    else if (path === "/agents/tool-confirmations") body = [];
    else if (path === "/agents" && method === "GET") body = agents;
    else if (path === "/agents/architect/sessions" && method === "POST") {
      const input = request.postDataJSON() as { agent_id?: string | null };
      if (options.noConnection) {
        status = 409;
        body = {
          code: "architect_connection_required",
          message: "Connect a language model to the workspace first.",
          request_id: "r1",
        };
      } else {
        if (session.messages.length === 0) {
          session.agent_id = input.agent_id ?? null;
          session.messages.push(
            input.agent_id
              ? message(
                  "assistant",
                  "Что изменить в этом агенте? Опишите словами — я поправлю черновик, а опубликуете вы сами, когда проверите.",
                )
              : message(
                  "assistant",
                  "Здравствуйте! Опишите своими словами, какую работу вы хотите отдать агенту. Можно так, как объясняли бы новому сотруднику.",
                  "question",
                  [
                    "Передавать дела между слотами инструкторов",
                    "Искать инструктора на свободный слот",
                    "Следить, чтобы все отметились под сообщением",
                  ],
                ),
          );
          status = 201;
        }
        body = session;
      }
    } else if (path === `/agents/architect/sessions/${sessionID}/messages`) {
      const { text } = request.postDataJSON() as { text: string };
      sent.push(text);
      session.messages.push(message("user", text));
      const next = script[step]!(agents.find((item) => item.id === draftID));
      step += 1;
      if (next.reply.kind === "question") session.questions_asked += 1;
      if (next.agent) {
        agents = [...agents.filter((item) => item.id !== draftID), next.agent];
        session.agent_id = draftID;
      }
      if (next.triggers) triggers = next.triggers;
      if (next.examples) session.test_examples = next.examples;
      session.messages.push(next.reply);
      session.usage = {
        ...session.usage,
        input_tokens: session.usage.input_tokens + 1500,
        output_tokens: session.usage.output_tokens + 200,
        cost: (0.0012 * step).toFixed(8),
      };
      body = session;
    } else if (agentMatch) {
      const [, agentID, rest = ""] = agentMatch;
      const agent = agents.find((item) => item.id === agentID);
      if (!agent) status = 404;
      else if (rest === "") body = agent;
      else if (rest === "/triggers") body = agentID === draftID ? triggers : [];
      else if (rest === "/versions" || rest === "/keys") body = [];
      else if (rest === "/runs") body = { runs: [] };
      else status = 404;
    } else status = 404;

    await route.fulfill({
      status,
      contentType: "application/json",
      body:
        body === undefined
          ? JSON.stringify({ code: "not_found", message: "not found" })
          : JSON.stringify(body),
    });
  });
  return { sent };
}

test.use({ timezoneId: "Europe/Moscow" });
test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(now);
});

async function expectNoHorizontalScroll(page: Page) {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(page.viewportSize()!.width);
}

async function openPassport(page: Page) {
  const toggle = page.getByRole("button", { name: /Паспорт агента/ });
  if ((await toggle.getAttribute("aria-expanded")) === "false")
    await toggle.click();
}

test("the Architect builds a draft from one phrase and four answers", async ({
  page,
}) => {
  const mock = await mockArchitect(page);
  await page.goto("/agents");
  await page.getByRole("button", { name: "Создать с Архитектором" }).click();
  await expect(page).toHaveURL(/\/agents\/architect$/);
  await expect(
    page.getByRole("heading", { name: "Архитектор агентов" }),
  ).toBeVisible();
  await openPassport(page);
  const passport = page.getByRole("complementary", { name: "Паспорт агента" });
  await expect(passport.getByText("Заполнено 0 из 6")).toBeVisible();

  await page
    .getByRole("button", { name: "Передавать дела между слотами инструкторов" })
    .click();
  // The draft exists now: the address keeps the conversation across reloads.
  await expect(page).toHaveURL(new RegExp(`/agents/${draftID}/architect$`));
  await expect(page.getByText("Откуда брать расписание слотов?")).toBeVisible();
  await openPassport(page);
  await expect(passport.getByText("Передача", { exact: true })).toBeVisible();
  await expect(
    passport.getByText("Подключение «Модель пространства» · gpt-5-mini"),
  ).toBeVisible();

  await page
    .getByRole("button", { name: "Таблица «Расписание слотов» в базе знаний" })
    .click();
  await expect(
    passport.getByText("База знаний: Расписание слотов"),
  ).toBeVisible();

  // Free text instead of an option.
  await page.getByLabel("Ваш ответ").fill("И то, и другое");
  await page.getByRole("button", { name: "Отправить" }).click();
  await expect(page.getByText("Остался 1 уточняющий вопрос")).toBeVisible();
  await expect(passport.getByText("Зал 1, Инструкторы")).toBeVisible();
  await expect(
    passport.getByText("Писать сообщения; Карточки с кнопками и сбор ответов"),
  ).toBeVisible();
  await expect(page).toHaveScreenshot("architect-conversation.png", {
    animations: "disabled",
    fullPage: true,
  });

  await page.getByRole("button", { name: "За 15 минут" }).click();
  await expect(page.getByText("Готово, агент собран.")).toBeVisible();
  await expect(page.getByText("Что я предположил сам")).toBeVisible();
  await expect(passport.getByText("Заполнено 6 из 6")).toBeVisible();
  await expect(passport.getByText(/8:45/)).toBeVisible();
  await expect(
    page.getByText("Слот Ивана закончился, через 15 минут заступает Мария"),
  ).toBeVisible();
  // Data sharing is a person's decision: the check waits for the builder.
  await expect(
    page
      .getByText(
        "Перед публикацией подтвердите в конструкторе, что данные можно отправлять во внешнюю модель.",
      )
      .first(),
  ).toBeVisible();
  await expect(page).toHaveScreenshot("architect-done.png", {
    animations: "disabled",
    fullPage: true,
  });
  expect(mock.sent).toEqual([
    "Передавать дела между слотами инструкторов",
    "Таблица «Расписание слотов» в базе знаний",
    "И то, и другое",
    "За 15 минут",
  ]);
  await expectNoHorizontalScroll(page);

  await page.getByRole("button", { name: "Открыть в конструкторе" }).click();
  await expect(page).toHaveURL(new RegExp(`/agents/${draftID}/test$`));
  await expect(
    page.getByRole("heading", { name: "Передача", level: 2 }),
  ).toBeVisible();
});

test("the builder opens the Architect over the agent's draft", async ({
  page,
}) => {
  await mockArchitect(page, { existing: true });
  await page.goto(`/agents/${existingID}`);
  await page
    .getByRole("button", { name: "Изменить через Архитектора" })
    .click();
  await expect(page).toHaveURL(new RegExp(`/agents/${existingID}/architect$`));
  await expect(page.getByText("Правит черновик «Контроль»")).toBeVisible();
  await expect(page.getByText("Что изменить в этом агенте?")).toBeVisible();
  await openPassport(page);
  await expect(
    page
      .getByRole("complementary", { name: "Паспорт агента" })
      .getByText("Инструкторы", { exact: true }),
  ).toBeVisible();
});

test("without a model connection the Architect sends to connections", async ({
  page,
}) => {
  await mockArchitect(page, { noConnection: true });
  await page.goto("/agents/architect");
  await expect(page.getByText("Сначала подключите модель")).toBeVisible();
  await expect(page).toHaveScreenshot("architect-no-connection.png", {
    animations: "disabled",
  });
  await page.getByRole("button", { name: "Перейти к подключениям" }).click();
  await expect(page).toHaveURL(/\/agents\/connections$/);
});
