#!/usr/bin/env node
// Seeds the «Агенты» tab for agents.yaml through the public API only:
//
//   COMA_API=http://localhost:8080 COMA_EMAIL=… COMA_PASSWORD=… \
//     node apps/mobile/e2e/seed-agents.mjs
//
// A local Core has no model and no built-in runtime, so the seed acts as the
// runtime of an external agent itself (with the agent's API key): it claims
// the runs it started, calls tools and completes or fails them. That gives
// real runs with steps, cost and errors, an action waiting for approval, and
// a direct chat where the agent has answered. Re-running reuses the agents
// (by handle) and adds fresh runs.
const api = (process.env.COMA_API ?? "http://localhost:8080").replace(
  /\/$/,
  "",
);

async function call(path, init = {}, token) {
  const response = await fetch(`${api}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });
  const text = await response.text();
  if (!response.ok)
    throw new Error(
      `${init.method ?? "GET"} ${path}: ${response.status} ${text}`,
    );
  return text ? JSON.parse(text) : null;
}

const post = (path, body, token) =>
  call(path, { method: "POST", body: JSON.stringify(body ?? {}) }, token);
const patch = (path, body, token) =>
  call(path, { method: "PATCH", body: JSON.stringify(body) }, token);

const { access_token: token } = await post("/api/v1/auth/login", {
  email: process.env.COMA_EMAIL ?? "lev@example.test",
  password: process.env.COMA_PASSWORD ?? "coma-mobile-dev-1",
});
const me = await call("/api/v1/me", {}, token);
const { chats } = await call("/api/v1/chats", {}, token);
const group =
  ["Зал 1", "Дизайн-команда", "Backend"]
    .map((name) =>
      chats.find((chat) => chat.kind === "group" && chat.name === name),
    )
    .find(Boolean) ?? chats.find((chat) => chat.kind === "group");
if (!group) throw new Error("No group chat to seed agents into");

const scopes = [
  "messages:read",
  "messages:write",
  "reactions:write",
  "runtime:execute",
];
const existing = await call("/api/v1/agents", {}, token);

/** An external agent with a key; the key is created anew on every run. */
async function externalAgent({ name, handle, description, chatIDs, policy }) {
  let agent = existing.find((item) => item.handle === handle);
  if (!agent) {
    agent = await post(
      "/api/v1/agents",
      {
        display_name: name,
        handle,
        kind: "external",
        recipe: "custom",
        description,
        enabled: false,
        allowed_scopes: scopes,
        endpoint_url: "http://127.0.0.1",
        external_data_sharing_approved: false,
        rate_limit_per_minute: 300,
        provider_rate_limit_per_minute: 300,
        execution_timeout_seconds: 600,
        max_output_tokens: 2048,
        max_tool_iterations: 8,
        max_chain_depth: 3,
        per_chat_concurrency: 4,
        chat_ids: chatIDs,
        confirmation_policy: policy,
      },
      token,
    );
  }
  const key = await post(
    `/api/v1/agents/${agent.id}/keys`,
    { name: "mobile-e2e", scopes, rate_limit_per_minute: 300 },
    token,
  );
  agent = await patch(
    `/api/v1/agents/${agent.id}`,
    {
      enabled: true,
      chat_ids: [...new Set([...agent.chat_ids, ...chatIDs])],
      confirmation_policy: policy,
    },
    token,
  );
  if (agent.has_unpublished_changes || agent.published_version == null)
    agent = await post(
      `/api/v1/agents/${agent.id}/publish`,
      { acknowledge_loosened: true },
      token,
    );
  if (agent.operational_status === "paused")
    agent = await post(`/api/v1/agents/${agent.id}/resume`, {}, token);
  return { agent, secret: key.secret };
}

/** Starts a run as the signed-in person and claims it as the agent. */
async function startRun(agent, secret, chatID, input) {
  const started = await post(
    `/api/v1/agents/${agent.id}/invoke`,
    {
      chat_id: chatID,
      client_run_id: crypto.randomUUID(),
      chain_depth: 0,
      timeout_seconds: 600,
      max_attempts: 1,
      input,
    },
    token,
  );
  for (let attempt = 0; attempt < 10; attempt++) {
    const claimed = await post(
      "/api/v1/agent-runtime/runs/claim",
      { worker_id: crypto.randomUUID(), lease_seconds: 120, wait_seconds: 2 },
      secret,
    );
    if (claimed?.id === started.id) return claimed;
    if (claimed)
      await post(
        `/api/v1/agent-runtime/runs/${claimed.id}/fail`,
        { lease_token: claimed.lease_token, error_code: "run_canceled" },
        secret,
      );
  }
  throw new Error(`Run ${started.id} was not claimed`);
}

function tool(run, secret, name, args) {
  return call(
    `/api/v1/agent-tools/${name}`,
    {
      method: "POST",
      body: JSON.stringify({
        arguments: args,
        run_id: run.id,
        lease_token: run.lease_token,
        correlation_id: run.correlation_id,
        tool_call_id: crypto.randomUUID(),
      }),
    },
    secret,
  ).catch((error) => ({ error: String(error.message) }));
}

const complete = (run, secret, preview, cost) =>
  post(
    `/api/v1/agent-runtime/runs/${run.id}/complete`,
    {
      lease_token: run.lease_token,
      input_tokens: 1840,
      output_tokens: 312,
      cost,
      currency: "USD",
      price_source: "configured",
      result_summary: preview ? { preview } : {},
    },
    secret,
  );

// 1. «Сводка»: writes to the hall only after a person allows it.
const summary = await externalAgent({
  name: "Сводка",
  handle: "e2e-svodka",
  description:
    "Собирает главное за день в чате зала и публикует сводку после подтверждения.",
  chatIDs: [group.id],
  policy: { post_message: "confirm", send_direct_message: "confirm" },
});

// A finished run: read the chat, answered.
let run = await startRun(summary.agent, summary.secret, group.id, {
  trigger_type: "mention",
  prompt: "Что было сегодня?",
});
await tool(run, summary.secret, "get_chat_messages", {
  chat_id: group.id,
  limit: 20,
});
await complete(
  run,
  summary.secret,
  "За день: зал 2 закрыт на уборку до 15:00, Игорь заменит Павла в четверг.",
  "0.0123",
);

// A run waiting for approval: post_message needs a person's decision.
run = await startRun(summary.agent, summary.secret, group.id, {
  trigger_type: "schedule",
});
await tool(run, summary.secret, "get_chat_messages", {
  chat_id: group.id,
  limit: 20,
});
const waiting = await tool(run, summary.secret, "post_message", {
  chat_id: group.id,
  client_msg_id: crypto.randomUUID(),
  body: "Сводка дня: зал 2 закрыт на уборку до 15:00; в четверг Игорь Сомов заменяет Павла Нестерова на слоте 14:00–18:00.",
});
await complete(run, summary.secret, "", "0.0087");

// A failed run.
run = await startRun(summary.agent, summary.secret, group.id, {
  trigger_type: "command",
});
await post(
  `/api/v1/agent-runtime/runs/${run.id}/fail`,
  { lease_token: run.lease_token, error_code: "budget_exceeded" },
  summary.secret,
);

// 2. A direct chat with the agent, where it has answered the person.
const direct = await post(
  "/api/v1/chats",
  { kind: "direct", visibility: "private", member_ids: [summary.agent.id] },
  token,
);
await externalAgent({
  name: "Сводка",
  handle: "e2e-svodka",
  description:
    "Собирает главное за день в чате зала и публикует сводку после подтверждения.",
  chatIDs: [group.id, direct.id],
  policy: { post_message: "confirm", send_direct_message: "confirm" },
}).then(async ({ secret }) => {
  const question = await post(
    `/api/v1/chats/${direct.id}/messages`,
    {
      client_msg_id: crypto.randomUUID(),
      body: "Что нового в зале 1?",
      body_format: "plain",
    },
    token,
  ).catch(() => null);
  const reply = await startRun(summary.agent, secret, direct.id, {
    trigger_type: "every_message",
    prompt: "Что нового в зале 1?",
    ...(question ? { message_id: question.id } : {}),
  });
  await post(
    `/api/v1/agent-runtime/runs/${reply.id}/publish`,
    {
      lease_token: reply.lease_token,
      client_msg_id: crypto.randomUUID(),
      body: "В зале 1 сегодня спокойно: все инструкторы отметились, тренажёр у окна снова работает.",
      body_format: "plain",
      mentioned_actor_ids: [],
      file_ids: [],
    },
    secret,
  );
  await complete(reply, secret, "", "0.0041");
});

// 3. «Напоминалка»: published and paused.
const reminder = await externalAgent({
  name: "Напоминалка",
  handle: "e2e-napominalka",
  description: "Напоминает инструкторам о слотах на завтра.",
  chatIDs: [group.id],
  policy: {},
});
await post(`/api/v1/agents/${reminder.agent.id}/pause`, {}, token);

// 4. «Справка» from the built-in role: a draft without a model.
if (!existing.some((item) => item.handle === "e2e-spravka")) {
  const [recipe] = (
    await call("/api/v1/agents/recipes?locale=ru", {}, token)
  ).filter((item) => item.id !== "custom");
  if (recipe)
    await post(
      "/api/v1/agents",
      {
        display_name: "Справка",
        handle: "e2e-spravka",
        kind: "builtin",
        recipe: recipe.id,
        locale: "ru",
        description: recipe.instructions,
        enabled: false,
        allowed_scopes: recipe.scopes ?? ["messages:read", "runtime:execute"],
        provider: "openai",
        model: "gpt-5-mini",
        external_data_sharing_approved: false,
        chat_ids: [group.id],
      },
      token,
    ).catch((error) => console.warn(`Справка: ${error.message}`));
}

console.log(
  JSON.stringify(
    {
      owner: me.display_name,
      chat: group.name,
      direct: direct.id,
      waiting: waiting?.confirmation?.id ?? waiting?.id ?? waiting,
    },
    null,
    2,
  ),
);
