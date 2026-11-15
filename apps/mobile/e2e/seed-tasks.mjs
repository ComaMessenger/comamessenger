#!/usr/bin/env node
// Data of the task flows (phase 6.6, «Задача» and the slot under the header):
//   1. two colleagues of the test account, Анна Иванова and Олег Чернов
//      (the same people as seed-requests.mjs);
//   2. the chat «Инструкторы · задачи» with the three of them;
//   3. tasks and pins of earlier runs deleted, then:
//      - a pinned message «Ключи от раздевалки теперь на стойке администратора»;
//      - a task from Олег on Анна with two items, one on the test account
//        («Подготовить большой зал к слоту <HHMMSS>», due tomorrow at 9:00);
//      - a task from Анна on the test account due in two hours, so it burns
//        («Повесить новое расписание бассейна <HHMMSS>»);
//      - a message from Анна to make a task from: «Нужно до среды проверить
//        аптечку в большом зале и докупить бинты.»
// The chat becomes the most recent one, the first row of the chat list.
//
//   COMA_API=http://localhost:8080 COMA_EMAIL=… COMA_PASSWORD=… \
//     node apps/mobile/e2e/seed-tasks.mjs
// With SLOT_ONLY=1 the tasks are left out: chat-slot.yaml sees the pinned
// message and its own scheduled one.
export const chatName = "Инструкторы · задачи";
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

// Tasks and pins of earlier runs go away (the owner may delete any message),
// so the flows find only this run's cards.
const pins = await call(`/api/v1/chats/${chat.id}/pins`, {}, token);
for (const pin of pins.pins ?? pins)
  await call(
    `/api/v1/messages/${pin.message_id}/pin`,
    { method: "DELETE" },
    token,
  ).catch(() => undefined);
let cursor = "";
for (let page = 0; page < 5; page++) {
  const { messages } = await call(
    `/api/v1/chats/${chat.id}/messages?limit=100${cursor}`,
    {},
    token,
  );
  for (const message of messages)
    if (message.type === "task" && !message.deleted_at)
      await call(`/api/v1/messages/${message.id}`, { method: "DELETE" }, token);
  if (messages.length < 100) break;
  cursor = `&before=${messages[0].id}`;
}

const tag = new Date().toTimeString().slice(0, 8).replace(/:/g, "");
const post = (person, body) =>
  call(
    `/api/v1/chats/${chat.id}/messages`,
    {
      method: "POST",
      body: JSON.stringify({
        client_msg_id: crypto.randomUUID(),
        body,
        body_format: "plain",
      }),
    },
    person.access_token,
  );

const pinned = await post(
  owner,
  "Ключи от раздевалки теперь на стойке администратора",
);
await call(`/api/v1/messages/${pinned.id}/pin`, { method: "PUT" }, token);

if (!process.env.SLOT_ONLY) {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  await call(
    `/api/v1/chats/${chat.id}/tasks`,
    {
      method: "POST",
      body: JSON.stringify({
        client_msg_id: crypto.randomUUID(),
        title: `Подготовить большой зал к слоту ${tag}`,
        description: "Слот Олега, после — группа на растяжку.",
        assignee: { kind: "person", actor_id: anna.user.id },
        due_at: tomorrow.toISOString(),
        remind_before_due: true,
        items: [
          { text: "Разложить маты", assignee_id: oleg.user.id },
          { text: "Достать инвентарь из кладовой", assignee_id: owner.user.id },
        ],
      }),
    },
    oleg.access_token,
  );
  const task = await call(
    `/api/v1/chats/${chat.id}/tasks`,
    {
      method: "POST",
      body: JSON.stringify({
        client_msg_id: crypto.randomUUID(),
        title: `Повесить новое расписание бассейна ${tag}`,
        assignee: { kind: "person", actor_id: owner.user.id },
        due_at: new Date(Date.now() + 2 * 60 * 60_000).toISOString(),
        remind_before_due: true,
      }),
    },
    anna.access_token,
  );
  console.log(`Task ${task.id} from Анна on the account, tag ${tag}.`);
}
await post(
  anna,
  "Нужно до среды проверить аптечку в большом зале и докупить бинты.",
);
console.log(`Chat «${chatName}» (${chat.id}) seeded, tag ${tag}.`);
