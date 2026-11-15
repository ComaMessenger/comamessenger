#!/usr/bin/env node
// Data of request.yaml and request-recipient.yaml (phase 6.4, «Запрос»):
//   1. two colleagues of the test account, Анна Иванова and Олег Чернов
//      (made by invitation the first time, then they sign in);
//   2. the chat «Планёрка · запросы» with the three of them;
//   3. the requests of earlier runs deleted, then a fresh request from Анна to the test account and Олег — «Журнал
//      осмотров за неделю заполнен? <HHMMSS>», «Да / Нет», due tomorrow at
//      12:00 — so the account has something waiting for its answer.
// The chat becomes the most recent one, the first row of the chat list.
// scripts/answer-request.js answers the account's own request as Анна.
//
//   COMA_API=http://localhost:8080 COMA_EMAIL=… COMA_PASSWORD=… \
//     node apps/mobile/e2e/seed-requests.mjs
export const chatName = "Планёрка · запросы";
export const colleagues = [
  {
    email: "anna.requests@example.test",
    password: "coma-requests-anna-1",
    name: "Анна Иванова",
    handle: "anna_requests",
  },
  {
    email: "oleg.requests@example.test",
    password: "coma-requests-oleg-1",
    name: "Олег Чернов",
    handle: "oleg_requests",
  },
];

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
  if (!response.ok) {
    const error = new Error(
      `${init.method ?? "GET"} ${path}: ${response.status} ${text}`,
    );
    error.status = response.status;
    throw error;
  }
  return text ? JSON.parse(text) : null;
}

const login = (email, password) =>
  call("/api/v1/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });

const owner = await login(
  process.env.COMA_EMAIL ?? "lev@example.test",
  process.env.COMA_PASSWORD ?? "coma-mobile-dev-1",
);
const token = owner.access_token;

async function colleague(person) {
  try {
    return await login(person.email, person.password);
  } catch (error) {
    if (error.status !== 401 && error.status !== 400 && error.status !== 422)
      throw error;
  }
  const invitation = await call(
    "/api/v1/invitations",
    {
      method: "POST",
      body: JSON.stringify({ email: person.email, role: "member" }),
    },
    token,
  );
  await call(
    `/api/v1/invitations/${invitation.accept_url.split("/").pop()}/accept`,
    {
      method: "POST",
      body: JSON.stringify({
        display_name: person.name,
        handle: person.handle,
        password: person.password,
      }),
    },
  );
  return login(person.email, person.password);
}

const [anna, oleg] = [
  await colleague(colleagues[0]),
  await colleague(colleagues[1]),
];

const { chats } = await call("/api/v1/chats", {}, token);
let chat = chats.find(
  (item) => item.kind === "group" && item.name === chatName,
);
if (!chat)
  chat = await call(
    "/api/v1/chats",
    { method: "POST", body: JSON.stringify({ kind: "group", name: chatName }) },
    token,
  );
const { members } = await call(`/api/v1/chats/${chat.id}/members`, {}, token);
for (const person of [anna, oleg])
  if (!members.some((member) => member.actor_id === person.user.id))
    await call(
      `/api/v1/chats/${chat.id}/members`,
      {
        method: "POST",
        body: JSON.stringify({ actor_id: person.user.id, role: "member" }),
      },
      token,
    );

// Requests of earlier runs go away (the owner may delete any message), so
// the flows find only this run's cards.
const { messages } = await call(
  `/api/v1/chats/${chat.id}/messages?limit=100`,
  {},
  token,
);
for (const message of messages)
  if (message.type === "request" && !message.deleted_at)
    await call(`/api/v1/messages/${message.id}`, { method: "DELETE" }, token);

const due = new Date();
due.setDate(due.getDate() + 1);
due.setHours(12, 0, 0, 0);
const tag = new Date().toTimeString().slice(0, 8).replace(/:/g, "");
const request = await call(
  `/api/v1/chats/${chat.id}/requests`,
  {
    method: "POST",
    body: JSON.stringify({
      client_msg_id: crypto.randomUUID(),
      body: `Журнал осмотров за неделю заполнен? ${tag}`,
      body_format: "plain",
      audience: { kind: "people", actor_ids: [owner.user.id, oleg.user.id] },
      answer: { preset: "yes_no" },
      allow_comment: true,
      due_at: due.toISOString(),
      auto_remind: false,
    }),
  },
  anna.access_token,
);
console.log(
  `Request ${request.id} from Анна in «${chatName}» (${chat.id}), tag ${tag}.`,
);
