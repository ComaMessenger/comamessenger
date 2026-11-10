import { expect, test, type Page } from "@playwright/test";

/*
 * Agent platform on a mock API: catalog, one-page builder (every block),
 * check in dry run, publishing and activity. Data is fictional.
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

const hall = chatOf("00000000-0000-4000-8000-0000000000a1", "Зал 1");
const instructors = chatOf(
  "00000000-0000-4000-8000-0000000000a2",
  "Инструкторы",
);
const rules = chatOf(
  "00000000-0000-4000-8000-0000000000a3",
  "Вопросы по регламентам",
);

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

const webhookID = "00000000-0000-4000-8000-0000000000f1";
const mcpConnection = {
  id: "00000000-0000-4000-8000-0000000000f2",
  name: "accounting",
  description: "Учётная система центра",
  endpoint_url: "mcp.example.test",
  enabled: true,
  allow_private_network: false,
  agent_use_allowed: true,
  writes_require_confirmation: false,
  assignable_tools: ["get_slots", "assign_instructor"],
  headers_configured: true,
  secret_hint: "",
  timeout_ms: 10000,
  max_output_bytes: 262144,
  tools: [
    { name: "get_slots", description: "Свободные слоты", read_only: true },
    {
      name: "assign_instructor",
      description: "Назначить инструктора на слот",
      read_only: false,
    },
  ],
  tools_refreshed_at: "2026-11-10T08:00:00Z",
  health_status: "healthy",
  last_tested_at: "2026-11-10T08:00:00Z",
  last_error_code: "",
  agent_count: 0,
  created_at: "2026-11-01T00:00:00Z",
  updated_at: "2026-11-01T00:00:00Z",
};

const collections = [
  {
    id: "00000000-0000-4000-8000-0000000000d1",
    name: "Регламенты центра",
    description: "",
    access: "organization",
    chat_ids: [],
    embedding_connection_id: null,
    document_count: 2,
    can_manage: true,
    created_by: owner.id,
    created_at: "2026-11-01T00:00:00Z",
    updated_at: "2026-11-01T00:00:00Z",
  },
  {
    id: "00000000-0000-4000-8000-0000000000d2",
    name: "Расписание залов",
    description: "",
    access: "chats",
    chat_ids: [],
    embedding_connection_id: null,
    document_count: 1,
    can_manage: true,
    created_by: owner.id,
    created_at: "2026-11-01T00:00:00Z",
    updated_at: "2026-11-01T00:00:00Z",
  },
];

const ids = {
  help: "00000000-0000-4000-8000-0000000000b1",
  control: "00000000-0000-4000-8000-0000000000b2",
  digest: "00000000-0000-4000-8000-0000000000b3",
};

type MockAgent = Record<string, unknown> & {
  id: string;
  chat_ids: string[];
  allowed_scopes: string[];
};

function agentOf(patch: Partial<MockAgent> & { id: string }): MockAgent {
  return {
    org_id: orgID,
    owner_actor_id: owner.id,
    display_name: "Агент",
    handle: "agent_x",
    kind: "builtin",
    recipe: "custom",
    recipe_version: 1,
    description: "",
    enabled: true,
    allowed_scopes: ["messages:read", "messages:write", "runtime:execute"],
    llm_connection_id: connection.id,
    provider: "openai",
    model: "gpt-5-mini",
    endpoint_url: "",
    external_data_sharing_approved: true,
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
    avatar_version: 0,
    readiness: { state: "active", ready: true, blockers: [] },
    operational_status: "active",
    draft_version: null,
    published_version: 2,
    has_unpublished_changes: false,
    published_at: "2026-11-05T09:00:00Z",
    created_at: "2026-11-01T00:00:00Z",
    updated_at: "2026-11-05T09:00:00Z",
    ...patch,
  };
}

function seedAgents(): MockAgent[] {
  return [
    agentOf({
      id: ids.help,
      display_name: "Справка",
      handle: "help",
      recipe: "qa",
      description:
        "Отвечай на вопросы по регламентам центра и всегда называй документ-источник.",
      allowed_scopes: [
        "messages:read",
        "messages:write",
        "search:read",
        "files:read",
        "knowledge:read",
        "runtime:execute",
      ],
      chat_ids: [rules.id],
      knowledge_collection_ids: [collections[0]!.id],
    }),
    agentOf({
      id: ids.control,
      display_name: "Контроль",
      handle: "control",
      description:
        "Следит, чтобы все отметились под важным сообщением, и напоминает тем, кто не отметился.",
      allowed_scopes: [
        "messages:read",
        "messages:write",
        "messages:interactive",
        "followups:write",
        "members:read",
        "runtime:execute",
      ],
      chat_ids: [instructors.id],
    }),
    agentOf({
      id: ids.digest,
      display_name: "Сводки",
      handle: "digest",
      recipe: "summarizer",
      description: "",
      enabled: false,
      chat_ids: [hall.id],
      external_data_sharing_approved: false,
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
    }),
  ];
}

function triggersOf(agentID: string) {
  const base = {
    org_id: orgID,
    agent_id: agentID,
    enabled: true,
    timezone: "Europe/Moscow",
    missed_runs_policy: "skip",
    created_at: "2026-11-01T00:00:00Z",
    updated_at: "2026-11-01T00:00:00Z",
  };
  if (agentID === ids.help)
    return [{ ...base, id: "trigger-help", type: "mention", config: {} }];
  if (agentID === ids.digest)
    return [
      {
        ...base,
        id: "trigger-digest-command",
        type: "command",
        config: { command: "summarize" },
      },
    ];
  return [
    {
      ...base,
      id: "trigger-control",
      type: "keyword",
      config: { pattern: "(отметьтесь|важно)", case_sensitive: false },
    },
  ];
}

// A fixed clock and zone keep times and «today» stable in snapshots.
const now = new Date("2026-11-10T09:00:00Z");
const today = now;
test.use({ timezoneId: "Europe/Moscow" });
test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(now);
});
const at = (hours: number, minutes = 0) =>
  new Date(
    Date.UTC(
      today.getUTCFullYear(),
      today.getUTCMonth(),
      today.getUTCDate(),
      hours,
      minutes,
    ),
  ).toISOString();

function runOf(patch: Record<string, unknown>) {
  return {
    org_id: orgID,
    agent_version: 2,
    dry_run: false,
    agent_config: {},
    correlation_id: "00000000-0000-4000-8000-0000000000f0",
    chain_depth: 0,
    status: "completed",
    provider: "openai",
    model: "gpt-5-mini",
    input: {},
    result_summary: {},
    input_tokens: 1200,
    output_tokens: 180,
    cost: "0.0042",
    currency: "USD",
    error_code: "",
    attempt: 1,
    max_attempts: 1,
    ...patch,
  };
}

export type AgentMock = {
  patches: Array<{ id: string; body: Record<string, unknown> }>;
  published: string[];
  createdTriggers: Array<Record<string, unknown>>;
  invocations: Array<Record<string, unknown>>;
  decisions: string[];
  workspaceRunQueries: string[];
  publishBodies: unknown[];
  runPolls: () => number;
};

async function mockAgents(
  page: Page,
  options: {
    empty?: boolean;
    theme?: "light" | "dark";
    noCollections?: boolean;
    userPatch?: Record<string, unknown>;
    /** The server answers the first publish with these loosened actions. */
    loosened?: string[];
  } = {},
): Promise<AgentMock> {
  let agents = options.empty ? [] : seedAgents();
  const triggers = new Map<string, Array<Record<string, unknown>>>(
    agents.map((agent) => [agent.id, triggersOf(agent.id)]),
  );
  let approvals = options.empty
    ? []
    : [
        {
          id: "00000000-0000-4000-8000-0000000000e1",
          agent_id: ids.control,
          run_id: "00000000-0000-4000-8000-0000000000e9",
          tool_call_id: "00000000-0000-4000-8000-0000000000e8",
          correlation_id: "00000000-0000-4000-8000-0000000000e7",
          tool_name: "post_message",
          required_scope: "messages:write",
          arguments: {
            chat_id: hall.id,
            client_msg_id: "00000000-0000-4000-8000-0000000000e6",
            body: "Напоминаю: отметьтесь под сообщением о порядке входа.",
          },
          status: "pending",
          requested_at: at(9, 30),
          expires_at: at(21, 0),
        },
      ];
  let polls = 0;
  const state: AgentMock = {
    patches: [],
    published: [],
    createdTriggers: [],
    invocations: [],
    decisions: [],
    workspaceRunQueries: [],
    publishBodies: [],
    runPolls: () => polls,
  };
  await page.addInitScript((theme) => {
    localStorage.setItem("coma-locale", "ru");
    localStorage.setItem("coma-theme", theme);
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
  }, options.theme ?? "light");

  const runsOf = (agentID: string) =>
    agentID === ids.help
      ? [
          runOf({
            id: "00000000-0000-4000-8000-000000000501",
            agent_id: agentID,
            chat_id: rules.id,
            input: { trigger_type: "mention" },
            created_at: at(9, 12),
            started_at: at(9, 12),
            finished_at: at(9, 12),
          }),
        ]
      : agentID === ids.control
        ? [
            runOf({
              id: "00000000-0000-4000-8000-000000000502",
              agent_id: agentID,
              chat_id: instructors.id,
              input: { trigger_type: "followup" },
              created_at: at(10, 0),
            }),
            runOf({
              id: "00000000-0000-4000-8000-000000000503",
              agent_id: agentID,
              chat_id: instructors.id,
              status: "failed",
              error_code: "budget_exceeded",
              input: { trigger_type: "keyword" },
              created_at: at(8, 30),
            }),
          ]
        : [];

  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const method = request.method();
    const url = new URL(request.url());
    const path = url.pathname.replace(/^\/api\/v1/, "");
    let status = 200;
    let body: unknown = undefined;
    const json = () => request.postDataJSON() as Record<string, unknown>;
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
        user: { ...owner, ...options.userPatch },
      };
    else if (path === "/me") body = { ...owner, ...options.userPatch };
    else if (path === "/preferences")
      body = {
        theme: options.theme ?? "light",
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
    else if (path === "/push/config") body = { enabled: false, public_key: "" };
    else if (path === "/chats") body = { chats: [hall, instructors, rules] };
    else if (path === "/drafts") body = { drafts: [] };
    else if (path === "/unread") body = { chats: [], threads: [] };
    else if (path === "/threads") body = { threads: [], next_before_seq: null };
    else if (path === "/agent-connections") body = [connection];
    else if (path === "/agent-runs" && method === "GET") {
      state.workspaceRunQueries.push(url.search);
      body = {
        runs: agents
          .flatMap((agent) => runsOf(agent.id))
          .filter(
            (run) =>
              !url.searchParams.get("agent_id") ||
              run.agent_id === url.searchParams.get("agent_id"),
          )
          .sort((left, right) =>
            right.created_at.localeCompare(left.created_at),
          ),
      };
    } else if (path === "/integrations/webhooks")
      body = [
        {
          id: webhookID,
          name: "Учётная система",
          description: "",
          enabled: true,
          agent_use_allowed: true,
          secret_hint: "",
          rate_limit_per_minute: 60,
          max_body_bytes: 65536,
          last_received_at: null,
          rejected_count: 0,
          last_rejected_at: null,
          last_rejected_code: "",
          trigger_count: 0,
          created_by: owner.id,
          created_at: "2026-11-09T08:00:00Z",
          updated_at: "2026-11-09T08:00:00Z",
        },
      ];
    else if (path === "/integrations/mcp-connections") body = [mcpConnection];
    else if (path === "/knowledge/collections")
      body = options.noCollections ? [] : collections;
    else if (/^\/knowledge\/collections\/[^/]+\/documents$/.test(path))
      body = [
        {
          id: "00000000-0000-4000-8000-0000000000d9",
          collection_id: path.split("/")[3],
          kind: "file",
          title: "Порядок замены инструктора.pdf",
          file_id: null,
          file_name: "Порядок замены инструктора.pdf",
          file_mime: "application/pdf",
          file_size: 1024,
          status: "ready",
          error_code: "",
          embedding_status: "none",
          chunk_count: 4,
          content_version: 1,
          indexed_at: "2026-11-09T08:10:00Z",
          created_by: owner.id,
          created_at: "2026-11-09T08:00:00Z",
          updated_at: "2026-11-09T08:10:00Z",
        },
      ];
    else if (/^\/knowledge\/runs\/[^/]+\/fragments$/.test(path))
      body = {
        fragments: [
          {
            tool_call_id: "00000000-0000-4000-8000-000000000101",
            chunk_id: "00000000-0000-4000-8000-000000000102",
            document_id: "00000000-0000-4000-8000-0000000000d9",
            collection_id: collections[0]!.id,
            document_title: "Порядок замены инструктора",
            section: "Замена в день занятия",
            position: 2,
            rank: 1,
            available: true,
          },
        ],
      };
    else if (path === "/agents" && method === "GET") body = agents;
    else if (path === "/agents" && method === "POST") {
      const input = json();
      const created = agentOf({
        ...(input as Partial<MockAgent>),
        id: "00000000-0000-4000-8000-0000000000b9",
        operational_status: "draft",
        published_version: null,
        draft_version: 1,
        has_unpublished_changes: true,
        published_at: null,
        readiness: { state: "needs_setup", ready: false, blockers: [] },
      } as MockAgent);
      agents = [...agents, created];
      triggers.set(created.id, []);
      status = 201;
      body = created;
    } else if (path === "/agents/tool-confirmations") body = approvals;
    else if (
      /^\/agents\/tool-confirmations\/[^/]+\/(approve|deny)$/.test(path)
    ) {
      const [, , , confirmationID, decision] = path.split("/");
      state.decisions.push(`${decision}:${confirmationID}`);
      body = {
        ...approvals[0],
        status: decision === "approve" ? "completed" : "denied",
      };
      approvals = approvals.filter((item) => item.id !== confirmationID);
    } else if (path === "/agents/response-collections")
      body = options.empty
        ? []
        : [
            {
              id: "00000000-0000-4000-8000-000000000201",
              agent_id: ids.control,
              chat_id: instructors.id,
              message_id: "00000000-0000-4000-8000-000000000202",
              response: "reaction",
              status: "open",
              expected_count: 9,
              responded_count: 6,
              reminders_sent: 1,
              deadline_at: at(15, 0),
              next_reminder_at: at(12, 0),
              note: "Порядок входа в зал",
              cancel_reason: "",
              created_at: at(7, 0),
              closed_at: null,
            },
          ];
    else if (path === "/agents/followups")
      body = options.empty
        ? []
        : [
            {
              id: "00000000-0000-4000-8000-000000000301",
              agent_id: ids.control,
              chat_id: instructors.id,
              due_at: at(13, 45),
              note: "Проверить, кто так и не отметился",
              status: "pending",
              reason: "",
              run_id: null,
              created_at: at(8, 0),
              finished_at: null,
            },
          ];
    else if (path === "/agents/product-metrics")
      body = {
        agents_total: agents.length,
        agents_published: 2,
        test_runs_total: 3,
        test_runs_failed: 0,
        average_seconds_to_first_test: 120,
        average_seconds_to_first_publish: 300,
      };
    else if (agentMatch) {
      const [, agentID, rest = ""] = agentMatch;
      const agent = agents.find((item) => item.id === agentID);
      if (!agent) status = 404;
      else if (rest === "" && method === "PATCH") {
        const input = json();
        state.patches.push({ id: agent.id, body: input });
        const updated = {
          ...agent,
          ...input,
          has_unpublished_changes: true,
          readiness: {
            state: "ready",
            ready: input.external_data_sharing_approved !== false,
            blockers:
              input.external_data_sharing_approved === false
                ? ["external_data_approval_required"]
                : [],
          },
        } as MockAgent;
        agents = agents.map((item) => (item.id === agent.id ? updated : item));
        body = updated;
      } else if (rest === "" && method === "GET") body = agent;
      else if (
        rest === "/publish" &&
        options.loosened &&
        !(request.postDataJSON() as { acknowledge_loosened?: boolean } | null)
          ?.acknowledge_loosened
      ) {
        status = 409;
        body = {
          code: "agent_confirmation_loosened",
          message: "loosened",
          request_id: "test",
          details: { loosened: options.loosened },
        };
      } else if (rest === "/publish") {
        state.published.push(agent.id);
        state.publishBodies.push(request.postDataJSON());
        const updated = {
          ...agent,
          enabled: true,
          operational_status: "active",
          published_version: Number(agent.published_version ?? 0) + 1,
          draft_version: null,
          has_unpublished_changes: false,
          published_at: now.toISOString(),
          readiness: { state: "active", ready: true, blockers: [] },
        } as MockAgent;
        agents = agents.map((item) => (item.id === agent.id ? updated : item));
        body = updated;
      } else if (rest === "/versions")
        body = agent.published_version
          ? [
              {
                id: "00000000-0000-4000-8000-000000000401",
                agent_id: agent.id,
                version: agent.published_version,
                created_by: owner.id,
                created_at: "2026-11-05T09:00:00Z",
                published_at: "2026-11-05T09:00:00Z",
              },
            ]
          : [];
      else if (rest === "/triggers" && method === "GET")
        body = triggers.get(agent.id) ?? [];
      else if (rest === "/triggers" && method === "POST") {
        const input = json();
        state.createdTriggers.push(input);
        const created = {
          ...input,
          id: `trigger-${state.createdTriggers.length}`,
          org_id: orgID,
          agent_id: agent.id,
          created_at: "2026-11-10T00:00:00Z",
          updated_at: "2026-11-10T00:00:00Z",
        };
        triggers.set(agent.id, [...(triggers.get(agent.id) ?? []), created]);
        status = 201;
        body = created;
      } else if (rest === "/runs") body = { runs: runsOf(agent.id) };
      else if (rest === "/invoke") {
        const input = json();
        state.invocations.push(input);
        status = 202;
        body = runOf({
          id: "00000000-0000-4000-8000-000000000601",
          agent_id: agent.id,
          dry_run: true,
          chat_id: input.chat_id,
          status: "queued",
          input: input.input,
          created_at: now.toISOString(),
        });
      } else if (rest === "/keys") body = [];
      else status = 404;
    } else if (path === "/agent-runs/00000000-0000-4000-8000-000000000601") {
      polls += 1;
      body = runOf({
        id: "00000000-0000-4000-8000-000000000601",
        agent_id: ids.help,
        dry_run: true,
        chat_id: rules.id,
        status: polls >= 1 ? "completed" : "running",
        input: { sandbox: true, publish: false },
        result_summary:
          polls >= 1
            ? {
                preview:
                  "Замену оформляет администратор зала: заполните заявку и согласуйте её с заступающим инструктором.\nИсточник: «Порядок замены инструктора», раздел «Замена в день занятия».",
              }
            : {},
        created_at: at(11, 0),
        started_at: at(11, 0),
        finished_at: new Date(Date.parse(at(11, 0)) + 4_000).toISOString(),
      });
    } else if (/^\/agent-runs\/[^/]+\/tool-calls$/.test(path))
      body = {
        tool_calls: [
          {
            id: "00000000-0000-4000-8000-000000000701",
            tool_name: "get_chat_messages",
            mode: "read",
            status: "completed",
            dry_run: false,
            error_code: "",
            started_at: at(11, 0),
            finished_at: at(11, 0),
          },
          {
            id: "00000000-0000-4000-8000-000000000702",
            tool_name: "search_knowledge",
            mode: "read",
            status: "completed",
            dry_run: false,
            error_code: "",
            started_at: at(11, 0),
            finished_at: at(11, 0),
          },
          {
            id: "00000000-0000-4000-8000-000000000703",
            tool_name: "post_card",
            mode: "write",
            status: "completed",
            dry_run: true,
            error_code: "",
            started_at: at(11, 0),
            finished_at: at(11, 0),
          },
        ],
      };
    else status = 404;
    if (status === 404 && process.env.AGENT_MOCK_DEBUG)
      console.log("unmocked", method, path);

    await route.fulfill({
      status,
      contentType: "application/json",
      body:
        body === undefined
          ? status === 404
            ? JSON.stringify({ code: "not_found", message: "not found" })
            : ""
          : JSON.stringify(body),
    });
  });
  return state;
}

/** Builder blocks that load their own data have rendered. */
async function builderSettled(page: Page) {
  await expect(
    page.locator("#agent-block-skills .agent-external"),
  ).toBeAttached();
}

async function expectNoHorizontalScroll(page: Page) {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(page.viewportSize()!.width);
  const content = page.locator(".agent-platform__content");
  expect(
    await content.evaluate(
      (element) => element.scrollWidth - element.clientWidth,
    ),
  ).toBeLessThanOrEqual(1);
}

test("catalog shows human statuses, the approval strip and ready roles", async ({
  page,
}) => {
  await mockAgents(page);
  await page.goto("/agents");
  await expect(
    page.getByRole("heading", { name: /Ваши агенты/ }),
  ).toBeVisible();
  const help = page.locator(".agent-tile", { hasText: "Справка" });
  await expect(help.getByText("Работает", { exact: true })).toBeVisible();
  await expect(
    help.getByText(
      "Отвечай на вопросы по регламентам центра и всегда называй документ-источник.",
    ),
  ).toBeVisible();
  const control = page.locator(".agent-tile", { hasText: "Контроль" });
  await expect(control.getByText("Ждёт подтверждения")).toBeVisible();
  await expect(
    control.getByText("Следит, чтобы все отметились под важным сообщением"),
  ).toBeVisible();
  const digest = page.locator(".agent-tile", { hasText: "Сводки" });
  await expect(digest.getByText("Черновик", { exact: true })).toBeVisible();
  await expect(
    page.getByText("1 действие ждёт подтверждения.", { exact: false }),
  ).toBeVisible();
  await expect(page.getByText("Контроль: отправить сообщение")).toBeVisible();
  for (const role of [
    "Сводки",
    "Ответы по истории",
    "Адаптация",
    "Своя задача",
  ])
    await expect(page.locator(".agent-role", { hasText: role })).toBeVisible();
  await expect(page.getByText("messages:read")).toHaveCount(0);
  await expect(page.getByText("@help")).toHaveCount(0);
  await expectNoHorizontalScroll(page);
  await expect(page).toHaveScreenshot("agents-catalog.png", {
    animations: "disabled",
    fullPage: true,
  });
});

test("empty catalog explains what agents are for", async ({ page }) => {
  await mockAgents(page, { empty: true });
  await page.goto("/agents");
  await expect(
    page.getByRole("heading", { name: "Агенты берут на себя рутину в чатах" }),
  ).toBeVisible();
  await expect(
    page.getByText(/участник чата, который действует/),
  ).toBeVisible();
  await expect(page.getByText(/ничего не отправляется/)).toBeVisible();
  await page.locator(".agent-role", { hasText: "Ответы по истории" }).click();
  const dialog = page.getByRole("dialog", {
    name: "Новый агент: Ответы по истории",
  });
  await expect(dialog.getByLabel("Имя")).toHaveValue("Ответы по истории");
  await dialog.getByRole("button", { name: "Создать черновик" }).click();
  await expect(
    dialog.getByText("Выберите чат, в котором агент будет работать."),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Отмена" }).click();
  await expectNoHorizontalScroll(page);
  await expect(page).toHaveScreenshot("agents-catalog-empty.png", {
    animations: "disabled",
    fullPage: true,
  });
});

test("builder blocks derive permissions from plain-language choices", async ({
  page,
}) => {
  const mock = await mockAgents(page);
  await page.goto(`/agents/${ids.digest}`);
  await expect(
    page.getByRole("heading", { name: "Сводки", level: 2 }),
  ).toBeVisible();

  // Publishing explains what is missing instead of a silent disabled button.
  const publish = page.getByRole("button", { name: "Опубликовать" });
  await expect(publish).toBeDisabled();
  await expect(page.getByText("Чтобы опубликовать:")).toBeVisible();
  await expect(
    page
      .locator(".agent-builder__reasons")
      .getByText("разрешите передачу данных модели в блоке «Модель и данные»"),
  ).toBeVisible();

  // 1. Who it is
  const identity = page.locator("#agent-block-identity");
  await identity.getByLabel("Имя").fill("Итоги дня");
  await identity
    .getByLabel("Чем занимается")
    .fill(
      "Каждый вечер подводит итоги дня в зале: решения, вопросы, кто что делает.",
    );

  // 2. What it knows
  const knowledge = page.locator("#agent-block-knowledge");
  await expect(knowledge.getByText("Читает чаты")).toBeVisible();
  await knowledge.getByRole("switch", { name: "Поиск по истории" }).click();
  await knowledge
    .getByRole("button", { name: "Добавить из базы знаний" })
    .click();
  await knowledge.getByRole("checkbox", { name: /Регламенты центра/ }).click();
  await knowledge
    .getByRole("button", { name: "Показать документы" })
    .first()
    .click();
  await expect(
    knowledge.getByText("Порядок замены инструктора.pdf"),
  ).toBeVisible();
  await expect(
    knowledge.getByRole("link", { name: "Открыть базу знаний" }),
  ).toHaveAttribute("href", "/knowledge");
  await expect(
    knowledge.getByRole("link", {
      name: "Открыть «Регламенты центра» в базе знаний",
    }),
  ).toHaveAttribute("href", `/knowledge/${collections[0]!.id}`);

  // 3. What it can do: each action runs by itself or after approval.
  const skills = page.locator("#agent-block-skills");
  await skills
    .locator(".agent-line--skill", {
      hasText: "Карточки с кнопками и сбор ответов",
    })
    .getByRole("switch")
    .click();
  const cards = skills.locator(".agent-line--action", {
    hasText: "Публиковать и обновлять карточки",
  });
  await expect(cards.getByRole("radio", { name: "Сам" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  const direct = skills.locator(".agent-line--action", {
    hasText: "Писать людям в личные сообщения",
  });
  await expect(
    direct.getByRole("radio", { name: "После подтверждения" }),
  ).toHaveAttribute("aria-checked", "true");
  await direct.getByRole("radio", { name: "Сам" }).click();
  await expect(
    direct.getByText("Сделает это сам, без вашего участия"),
  ).toBeVisible();

  // External systems: only tools the connection releases, with their mode.
  await skills
    .getByRole("button", { name: /Подключить внешнюю систему/ })
    .click();
  await page.getByRole("option", { name: "accounting" }).click();
  const assign = skills.locator(".agent-line--action", {
    hasText: "assign_instructor",
  });
  await expect(assign.getByText("изменяет данные")).toBeVisible();
  await assign
    .getByRole("switch", { name: "Разрешить «assign_instructor»" })
    .click();
  await expect(
    assign.getByRole("radio", { name: "После подтверждения" }),
  ).toHaveAttribute("aria-checked", "true");
  await expect(skills.locator(".agent-external__system")).toHaveScreenshot(
    "agents-builder-skills.png",
    {
      animations: "disabled",
    },
  );

  // 5. Where it works
  const places = page.locator("#agent-block-places");
  await places.getByRole("button", { name: /Добавить чат/ }).click();
  await page.getByRole("option", { name: "Инструкторы" }).click();
  await expect(places.getByText("Инструкторы")).toBeVisible();

  // 6. Model and data: one explicit sentence about what leaves the workspace.
  const model = page.locator("#agent-block-model");
  await expect(
    model.getByText("Модель пространства", { exact: true }),
  ).toBeVisible();
  await expect(
    model.getByText(
      /Во внешнюю модель уходят только: сообщения из «Зал 1», «Инструкторы»/,
    ),
  ).toBeVisible();
  await expect(
    model.getByText(/фрагменты документов из «Регламенты центра»/),
  ).toBeVisible();
  await model
    .getByRole("switch", { name: "Разрешить передачу данных модели" })
    .click();

  // Scopes appear only in advanced settings, collapsed by default.
  await expect(page.getByText("messages:interactive")).toHaveCount(0);
  await page.getByText("Расширенные настройки").click();
  const advanced = page.locator("#agent-block-advanced");
  await expect(advanced.getByText("messages:interactive")).toBeVisible();
  await expect(advanced.getByText("knowledge:read")).toBeVisible();
  await expect(advanced.getByText("search:read")).toBeVisible();

  await expect(advanced.getByText("Что получает модель")).toBeVisible();

  await identity.getByRole("button", { name: "Официально" }).click();
  await page.getByRole("button", { name: "Сохранить черновик" }).click();
  await expect(page.getByText("Черновик сохранён")).toBeVisible();
  const saved = mock.patches.at(-1)!.body;
  expect(saved.tone).toBe("formal");
  expect(saved.write_chat_ids).toEqual(
    expect.arrayContaining([hall.id, instructors.id]),
  );
  expect(
    (saved.confirmation_policy as Record<string, string>).send_direct_message,
  ).toBe("auto");
  expect(saved.mcp_bindings).toEqual([
    expect.objectContaining({
      connection_id: mcpConnection.id,
      allowed_tools: ["assign_instructor"],
    }),
  ]);
  expect(saved.display_name).toBe("Итоги дня");
  expect(saved.chat_ids).toEqual([hall.id, instructors.id]);
  expect(saved.knowledge_collection_ids).toEqual([collections[0]!.id]);
  expect(saved.external_data_sharing_approved).toBe(true);
  expect(saved.allowed_scopes).toEqual(
    expect.arrayContaining([
      "messages:read",
      "messages:write",
      "messages:interactive",
      "search:read",
      "knowledge:read",
      "runtime:execute",
    ]),
  );
  expect(saved).not.toHaveProperty("enabled");
});

test("launch rules read as sentences with subject forms", async ({ page }) => {
  const mock = await mockAgents(page);
  await page.goto(`/agents/${ids.digest}/automations`);
  const block = page.locator("#agent-block-triggers");
  await expect(block).toBeInViewport();
  await expect(block.getByText("Когда пишут /summarize")).toBeVisible();
  await expect(block.getByText("берётся за задачу").first()).toBeVisible();
  await expect(block.getByLabel("Конфигурация")).toHaveCount(0);

  await block.getByRole("button", { name: "Добавить правило" }).click();
  for (const type of [
    "Когда его упоминают",
    "По команде",
    "По ключевым словам",
    "По расписанию",
    "При событии в чате",
    "На каждое сообщение",
    "Когда внешняя система сообщает о событии",
    "Только вручную",
  ])
    await expect(block.getByRole("button", { name: type })).toBeVisible();
  await block.getByRole("button", { name: "По расписанию" }).click();
  await block.getByLabel("Время").fill("18:30");
  await block.getByRole("button", { name: "По будням" }).click();
  await expect(
    block.getByRole("button", { name: "Часовой пояс Europe/Moscow" }),
  ).toBeVisible();
  await block.getByRole("button", { name: "Сохранить правило" }).click();
  await expect(block.getByText("По будням в 18:30")).toBeVisible();
  await expect(block.getByText("пишет в «Зал 1»")).toBeVisible();
  expect(mock.createdTriggers.at(-1)).toMatchObject({
    type: "schedule",
    timezone: "Europe/Moscow",
    config: {
      chat_id: hall.id,
      hour: 18,
      minute: 30,
      days_of_week: [1, 2, 3, 4, 5],
    },
  });

  await block.getByRole("button", { name: "Добавить правило" }).click();
  await block.getByRole("button", { name: "По ключевым словам" }).click();
  await block.getByLabel("Слова").fill("итоги, сводка");
  await block.getByRole("button", { name: "Сохранить правило" }).click();
  await expect(
    block.getByText("Когда в сообщении есть «итоги, сводка»"),
  ).toBeVisible();
  expect(mock.createdTriggers.at(-1)).toMatchObject({
    type: "keyword",
    timezone: "Europe/Moscow",
    config: { pattern: "(итоги|сводка)" },
  });

  await block.getByRole("button", { name: "Добавить правило" }).click();
  await block
    .getByRole("button", { name: "Когда внешняя система сообщает о событии" })
    .click();
  await block.getByRole("button", { name: /Вебхук/ }).click();
  await page.getByRole("option", { name: "Учётная система" }).click();
  await block.getByLabel("Только события").fill("slot.released");
  await block.getByRole("button", { name: "Сохранить правило" }).click();
  await expect(
    block.getByText("Когда «Учётная система» сообщает о slot.released"),
  ).toBeVisible();
  expect(mock.createdTriggers.at(-1)).toMatchObject({
    type: "webhook",
    config: {
      webhook_id: webhookID,
      chat_id: hall.id,
      event_types: ["slot.released"],
    },
  });

  await block.getByRole("button", { name: "Добавить правило" }).click();
  await block.getByRole("button", { name: "Только вручную" }).click();
  await block.getByRole("button", { name: "Сохранить правило" }).click();
  expect(mock.createdTriggers.at(-1)).toMatchObject({
    type: "manual",
    timezone: "Europe/Moscow",
  });
  await builderSettled(page);
  await expect(page).toHaveScreenshot("agents-builder-rules.png", {
    animations: "disabled",
  });
});

test("check shows the dry-run answer, a human trace and the verdict", async ({
  page,
}) => {
  const mock = await mockAgents(page);
  await page.setViewportSize({ width: 1280, height: 1200 });
  await page.goto(`/agents/${ids.help}/test`);
  const check = page.locator(".agent-check");
  await expect(check).toBeInViewport();
  await check.getByRole("button", { name: "Как оформить замену?" }).click();
  await expect(check.getByLabel("Сообщение агенту")).toHaveValue(
    "Как оформить замену?",
  );
  await check.getByRole("button", { name: "Показать ответ агента" }).click();
  await expect(
    check.getByText(/Замену оформляет администратор зала/),
  ).toBeVisible();
  await expect(check.getByText("Прочитал сообщения чата")).toBeVisible();
  await expect(check.getByText("Искал в базе знаний")).toBeVisible();
  await expect(
    check.getByText(
      "Нашёл в «Порядок замены инструктора», раздел «Замена в день занятия»",
    ),
  ).toBeVisible();
  await expect(
    check.getByText("Отправил бы карточку с кнопками"),
  ).toBeVisible();
  await expect(check.getByText("4 секунды")).toBeVisible();
  await expect(check.getByText(/около 0,0042\s\$/)).toBeVisible();
  await expect(
    check.getByText(
      /Так агент ответил бы в «Вопросы по регламентам»\. Ничего не отправлено\./,
    ),
  ).toBeVisible();
  expect(mock.invocations[0]).toMatchObject({
    chat_id: rules.id,
    dry_run: true,
    input: { prompt: "Как оформить замену?", sandbox: true, publish: false },
  });
  await builderSettled(page);
  // The whole page from the top: the address scrolled to the check panel,
  // and how far depends on layout timing; under the sticky bar the «nothing
  // to publish» line was hidden in some runs and not in others.
  await page.evaluate(() => {
    for (const element of document.querySelectorAll<HTMLElement>("*"))
      if (element.scrollTop > 0) element.scrollTop = 0;
    window.scrollTo(0, 0);
  });
  await expect(
    page.getByText("Опубликованная версия совпадает с черновиком"),
  ).toBeInViewport();
  await expect(page).toHaveScreenshot("agents-check.png", {
    animations: "disabled",
  });
});

test("polling of a check stops after leaving the page", async ({ page }) => {
  const mock = await mockAgents(page);
  await page.route(
    "**/api/v1/agent-runs/00000000-0000-4000-8000-000000000601",
    (route) =>
      route
        .fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            id: "00000000-0000-4000-8000-000000000601",
            org_id: orgID,
            agent_id: ids.help,
            agent_version: 2,
            dry_run: true,
            agent_config: {},
            correlation_id: "00000000-0000-4000-8000-0000000000f0",
            chain_depth: 0,
            status: "running",
            provider: "openai",
            model: "gpt-5-mini",
            input: {},
            result_summary: {},
            input_tokens: 0,
            output_tokens: 0,
            cost: "0",
            currency: "USD",
            error_code: "",
            attempt: 1,
            max_attempts: 1,
            created_at: now.toISOString(),
          }),
        })
        .then(() => {
          pending += 1;
        }),
  );
  let pending = 0;
  await page.goto(`/agents/${ids.help}`);
  const check = page.locator(".agent-check");
  await check.getByLabel("Сообщение агенту").fill("Проверка");
  await check.getByRole("button", { name: "Показать ответ агента" }).click();
  await expect(check.getByText("Агент думает…")).toBeVisible();
  await expect.poll(() => pending).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Ко всем агентам" }).click();
  await expect(
    page.getByRole("heading", { name: /Ваши агенты/ }),
  ).toBeVisible();
  const afterLeaving = pending;
  await page.waitForTimeout(2_500);
  expect(pending).toBe(afterLeaving);
  expect(mock.invocations).toHaveLength(1);
});

test("publishing saves the draft and the agent starts working", async ({
  page,
}) => {
  const mock = await mockAgents(page);
  await page.goto(`/agents/${ids.digest}`);
  await page
    .locator("#agent-block-model")
    .getByRole("switch", { name: "Разрешить передачу данных модели" })
    .click();
  await expect(page.getByText("Есть несохранённые правки")).toBeVisible();
  const publish = page.getByRole("button", { name: "Опубликовать" });
  await expect(publish).toBeEnabled();
  await publish.click();
  await expect(page.getByText("Версия опубликована")).toBeVisible();
  expect(mock.patches).toHaveLength(1);
  expect(mock.published).toEqual([ids.digest]);
  const bar = page.locator(".agent-builder__bar");
  await expect(bar.getByText("Работает", { exact: true })).toBeVisible();
  await expect(bar.getByText(/Опубликована версия 1/)).toBeVisible();
  await expect(
    bar.getByRole("button", { name: "Поставить на паузу" }),
  ).toBeVisible();
  await expect(publish).toBeDisabled();
  await expect(
    page.getByText(
      "Опубликованная версия совпадает с черновиком — публиковать нечего.",
    ),
  ).toBeVisible();
});

test("publishing asks to confirm actions that stop waiting for a person", async ({
  page,
}) => {
  const mock = await mockAgents(page, {
    loosened: ["send_direct_message", "mcp:accounting/assign_instructor"],
  });
  await page.goto(`/agents/${ids.digest}`);
  await page
    .locator("#agent-block-model")
    .getByRole("switch", { name: "Разрешить передачу данных модели" })
    .click();
  await page.getByRole("button", { name: "Опубликовать" }).click();
  const dialog = page.getByRole("dialog", {
    name: "Эти действия пойдут без подтверждения",
  });
  await expect(
    dialog.getByText("Писать людям в личные сообщения"),
  ).toBeVisible();
  await expect(
    dialog.getByText("«assign_instructor» во внешней системе «accounting»"),
  ).toBeVisible();
  expect(mock.published).toEqual([]);
  await dialog.getByRole("button", { name: "Понятно, опубликовать" }).click();
  await expect(page.getByText("Версия опубликована")).toBeVisible();
  expect(mock.publishBodies.at(-1)).toEqual({ acknowledge_loosened: true });
});

test("switching agents never carries state from one agent to another", async ({
  page,
}) => {
  await mockAgents(page);
  await page.goto(`/agents/${ids.help}`);
  await page
    .locator(".agent-check")
    .getByLabel("Сообщение агенту")
    .fill("Секретный вопрос");
  const triggers = page.locator("#agent-block-triggers");
  await triggers.getByRole("button", { name: "Добавить правило" }).click();
  await triggers.getByRole("button", { name: "По команде" }).click();
  await triggers.getByLabel("Команда").fill("help");
  await page
    .locator("#agent-block-identity")
    .getByLabel("Имя")
    .fill("Справка 2");

  await page.goto(`/agents/${ids.control}`);
  await expect(
    page.getByRole("heading", { name: "Контроль", level: 2 }),
  ).toBeVisible();
  await expect(
    page.locator(".agent-check").getByLabel("Сообщение агенту"),
  ).toHaveValue("");
  await expect(
    page.locator("#agent-block-triggers").getByLabel("Команда"),
  ).toHaveCount(0);
  await expect(
    page.locator("#agent-block-identity").getByLabel("Имя"),
  ).toHaveValue("Контроль");
});

test("old card addresses open the matching place of the builder", async ({
  page,
}) => {
  await mockAgents(page);
  await page.goto(`/agents/${ids.help}/settings`);
  await expect(page.locator("#agent-block-advanced")).toHaveAttribute(
    "open",
    "",
  );
  await expect(page.getByText("Работает сейчас")).toBeVisible();
  await page.goto(`/agents/${ids.help}/knowledge`);
  await expect(page.locator("#agent-block-knowledge")).toBeInViewport();
  await page.goto(`/agents/${ids.control}/activity`);
  await expect(
    page.getByRole("heading", { name: "Активность агентов" }),
  ).toBeVisible();
  await expect(page.locator(".agent-feed")).toContainText("Контроль");
  await expect(page.locator(".agent-feed")).not.toContainText("Справка");
});

test("activity shows what agents did next to the approval queue", async ({
  page,
}) => {
  const mock = await mockAgents(page);
  await page.goto("/agents/activity");
  await expect(
    page.getByRole("heading", { name: "Активность агентов" }),
  ).toBeVisible();
  const queue = page.locator("#agent-approvals");
  await expect(queue.getByText("Отправить сообщение в «Зал 1»")).toBeVisible();
  // One paged workspace feed instead of runs read agent by agent.
  await expect.poll(() => mock.workspaceRunQueries.length).toBeGreaterThan(0);
  expect(mock.workspaceRunQueries[0]).toContain("limit=40");
  await expect(
    queue
      .locator("blockquote")
      .getByText("Напоминаю: отметьтесь под сообщением о порядке входа."),
  ).toBeVisible();
  await expect(page.getByText("ответили 6 из 9")).toBeVisible();
  await expect(
    page.getByText(/Контроль вернётся к задаче .* в «Инструкторы»/),
  ).toBeVisible();
  const feed = page.locator(".agent-feed");
  await expect(
    feed.getByText("ответил на упоминание в «Вопросы по регламентам»"),
  ).toBeVisible();
  await expect(
    feed.getByText("вернулся к задаче в «Инструкторы»"),
  ).toBeVisible();
  await expect(
    feed.getByText(/не справился: Исчерпан бюджет агента/),
  ).toBeVisible();
  await expect(page.getByText("post_message")).toHaveCount(0);
  await expectNoHorizontalScroll(page);
  await expect(page).toHaveScreenshot("agents-activity.png", {
    animations: "disabled",
    fullPage: true,
  });
  await queue.getByRole("button", { name: "Разрешить" }).click();
  await expect(queue.getByText("Все действия рассмотрены.")).toBeVisible();
  expect(mock.decisions).toEqual([
    "approve:00000000-0000-4000-8000-0000000000e1",
  ]);
});

test("builder fits a phone and the dark theme", async ({ page }) => {
  await mockAgents(page, { theme: "dark" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/agents/${ids.control}`);
  await expect(
    page.getByRole("heading", { name: "Контроль", level: 2 }),
  ).toBeVisible();
  await expectNoHorizontalScroll(page);
  await builderSettled(page);
  await expect(page).toHaveScreenshot("agents-builder-dark-390.png", {
    animations: "disabled",
  });
  await page.goto("/agents");
  await expect(
    page.getByRole("heading", { name: /Ваши агенты/ }),
  ).toBeVisible();
  await expectNoHorizontalScroll(page);
});

test("an empty knowledge base invites only those who may fill it", async ({
  page,
}) => {
  await mockAgents(page, { noCollections: true });
  await page.goto(`/agents/${ids.control}/knowledge`);
  const knowledge = page.locator("#agent-block-knowledge");
  await expect(
    knowledge.getByText(/В базе знаний пока нет коллекций\. Создайте первую/),
  ).toBeVisible();
  const create = knowledge.getByRole("link", { name: "Создать коллекцию" });
  await expect(create).toHaveAttribute("href", "/knowledge");
  await expect(create).toHaveAttribute("target", "_blank");
});

test("without knowledge.manage the empty base does not ask to create", async ({
  page,
}) => {
  await mockAgents(page, {
    noCollections: true,
    userPatch: {
      role: "member",
      permissions: ["agents.build", "agents.observe"],
    },
  });
  await page.goto(`/agents/${ids.control}/knowledge`);
  const knowledge = page.locator("#agent-block-knowledge");
  await expect(
    knowledge.getByText(/Их создают участники с правом управлять базой знаний/),
  ).toBeVisible();
  await expect(
    knowledge.getByRole("link", { name: "Создать коллекцию" }),
  ).toHaveCount(0);
});
