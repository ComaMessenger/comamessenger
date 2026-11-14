#!/usr/bin/env node
// Data of agent-links.yaml: an answer of an agent that cites the knowledge
// base, so the run details and the message in the chat have a source that
// opens the fragment. Run seed-knowledge.mjs first (the «Регламенты центра»
// collection with the page «Отпуск инструкторов»), then:
//
//   COMA_API=http://localhost:8080 COMA_EMAIL=… COMA_PASSWORD=… \
//     node apps/mobile/e2e/seed-agent-links.mjs
//
// As seed-agents.mjs, the seed is the runtime of an external agent
// «Справочная» (with its API key): it claims the run it started, searches the
// knowledge base (full-text search needs no model) and posts a card with the
// found fragment as its source. Every run replaces the answer in the chat
// (earlier ones are deleted) and adds a fresh run; the agent is reused by
// its handle.
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

const chatName = process.env.COMA_CHAT ?? "Backend";
const { chats } = await call("/api/v1/chats", {}, token);
const chat = chats.find(
  (item) => item.kind === "group" && item.name === chatName,
);
if (!chat) throw new Error(`No group chat «${chatName}»`);

const collection = (
  await call("/api/v1/knowledge/collections", {}, token)
).find((item) => item.name === "Регламенты центра");
if (!collection)
  throw new Error("No «Регламенты центра»: run seed-knowledge.mjs first");

const scopes = [
  "messages:read",
  "messages:write",
  "messages:interactive",
  "knowledge:read",
  "runtime:execute",
];
const handle = "e2e-spravochnaya";
let agent = (await call("/api/v1/agents", {}, token)).find(
  (item) => item.handle === handle,
);
if (!agent)
  agent = await post(
    "/api/v1/agents",
    {
      display_name: "Справочная",
      handle,
      kind: "external",
      recipe: "custom",
      description: "Отвечает по регламентам центра и ссылается на них.",
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
      chat_ids: [chat.id],
      knowledge_collection_ids: [collection.id],
      confirmation_policy: {},
    },
    token,
  );
const key = await post(
  `/api/v1/agents/${agent.id}/keys`,
  { name: "mobile-e2e", scopes, rate_limit_per_minute: 300 },
  token,
);
agent = await patch(
  `/api/v1/agents/${agent.id}`,
  {
    enabled: true,
    chat_ids: [...new Set([...agent.chat_ids, chat.id])],
    knowledge_collection_ids: [collection.id],
    confirmation_policy: {},
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

// Earlier answers of the agent are removed, so the chat shows one source
// (a deleted message keeps no card); a deletion the server refuses is left.
const { messages } = await call(
  `/api/v1/chats/${chat.id}/messages?limit=100`,
  {},
  token,
);
for (const message of messages)
  if (message.actor_id === agent.id && !message.deleted_at)
    await call(
      `/api/v1/messages/${message.id}`,
      { method: "DELETE" },
      token,
    ).catch(() => undefined);

const prompt = "Как оформить отпуск?";
const started = await post(
  `/api/v1/agents/${agent.id}/invoke`,
  {
    chat_id: chat.id,
    client_run_id: crypto.randomUUID(),
    chain_depth: 0,
    timeout_seconds: 600,
    max_attempts: 1,
    input: { trigger_type: "mention", prompt },
  },
  token,
);
let run = null;
for (let attempt = 0; attempt < 10 && !run; attempt++) {
  const claimed = await post(
    "/api/v1/agent-runtime/runs/claim",
    { worker_id: crypto.randomUUID(), lease_seconds: 120, wait_seconds: 2 },
    key.secret,
  );
  if (claimed?.id === started.id) run = claimed;
  else if (claimed)
    await post(
      `/api/v1/agent-runtime/runs/${claimed.id}/fail`,
      { lease_token: claimed.lease_token, error_code: "run_canceled" },
      key.secret,
    );
}
if (!run) throw new Error(`Run ${started.id} was not claimed`);

const tool = (name, args) =>
  call(
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
    key.secret,
  );

const found = await tool("search_knowledge", { query: "отпуск", limit: 5 });
const fragments = found.result?.fragments ?? found.fragments ?? [];
const fragment =
  fragments.find((item) => item.document_title === "Отпуск инструкторов") ??
  fragments[0];
if (!fragment)
  throw new Error(`search_knowledge found nothing: ${JSON.stringify(found)}`);

const answer =
  "Заявление на отпуск подаётся за две недели старшему администратору.";
await tool("post_card", {
  chat_id: chat.id,
  client_msg_id: crypto.randomUUID(),
  body: answer,
  blocks: {
    version: 1,
    card: { title: "Как оформить отпуск" },
    sources: [
      {
        kind: "document",
        document_id: fragment.document_id,
        chunk_id: fragment.chunk_id,
        title: fragment.document_title,
        excerpt: answer,
      },
    ],
  },
});
await post(
  `/api/v1/agent-runtime/runs/${run.id}/complete`,
  {
    lease_token: run.lease_token,
    input_tokens: 920,
    output_tokens: 64,
    cost: "0.0019",
    currency: "USD",
    price_source: "configured",
    result_summary: { preview: answer },
  },
  key.secret,
);
console.log(
  `«${agent.display_name}» answered in «${chat.name}» citing «${fragment.document_title}» (run ${run.id}).`,
);
