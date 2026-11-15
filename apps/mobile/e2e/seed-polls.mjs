#!/usr/bin/env node
// Data of poll.yaml and poll-voter.yaml (phase 6.7, «Опрос»):
//   1. three colleagues of the test account — Анна Иванова, Олег Чернов,
//      Игорь Лаптев (made by invitation the first time, then they sign in);
//   2. the chats «Опросы · зал» (Анна's polls) and «Опросы · планёрка»
//      (poll.yaml writes there) with the four of them;
//   3. the polls of earlier runs deleted, then two fresh polls by Анна for
//      the account to vote in: «Какой день удобнее для выездного занятия?
//      <HHMMSS>» (Вторник / Среда / Четверг, due tomorrow at 12:00 — so it
//      waits in «Ждут вас») with Олег's vote for «Среда», and the anonymous
//      «Удобно ли новое расписание бассейна? <HHMMSS>» (Да / Неудобно утро /
//      Неудобен вечер, no due date).
// «Опросы · зал» becomes the most recent chat, the first row of the list.
// scripts/vote-poll.js votes in the account's own poll as Анна and Олег.
//
//   COMA_API=http://localhost:8080 COMA_EMAIL=… COMA_PASSWORD=… \
//     node apps/mobile/e2e/seed-polls.mjs
export const chatName = "Опросы · зал";
/** poll.yaml writes its own poll here, away from Анна's cards. */
export const authorChatName = "Опросы · планёрка";
export const colleagues = [
  {
    email: "anna.polls@example.test",
    password: "coma-polls-anna-1",
    name: "Анна Иванова",
    handle: "anna_polls",
  },
  {
    email: "oleg.polls@example.test",
    password: "coma-polls-oleg-1",
    name: "Олег Чернов",
    handle: "oleg_polls",
  },
  {
    email: "igor.polls@example.test",
    password: "coma-polls-igor-1",
    name: "Игорь Лаптев",
    handle: "igor_polls",
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

const people = [];
for (const person of colleagues) people.push(await colleague(person));
const [anna, oleg] = people;

const { chats } = await call("/api/v1/chats", {}, token);

/** The group with the three colleagues, without polls of earlier runs. */
async function group(name) {
  let chat = chats.find((item) => item.kind === "group" && item.name === name);
  if (!chat)
    chat = await call(
      "/api/v1/chats",
      { method: "POST", body: JSON.stringify({ kind: "group", name }) },
      token,
    );
  const { members } = await call(`/api/v1/chats/${chat.id}/members`, {}, token);
  for (const person of people)
    if (!members.some((member) => member.actor_id === person.user.id))
      await call(
        `/api/v1/chats/${chat.id}/members`,
        {
          method: "POST",
          body: JSON.stringify({ actor_id: person.user.id, role: "member" }),
        },
        token,
      );
  // Polls of earlier runs go away (the owner may delete any message), so
  // the flows find only this run's cards.
  const { messages } = await call(
    `/api/v1/chats/${chat.id}/messages?limit=100`,
    {},
    token,
  );
  for (const message of messages)
    if (message.type === "poll" && !message.deleted_at)
      await call(`/api/v1/messages/${message.id}`, { method: "DELETE" }, token);
  return chat;
}

await group(authorChatName);
const chat = await group(chatName);

const due = new Date();
due.setDate(due.getDate() + 1);
due.setHours(12, 0, 0, 0);
const tag = new Date().toTimeString().slice(0, 8).replace(/:/g, "");
const open = await call(
  `/api/v1/chats/${chat.id}/polls`,
  {
    method: "POST",
    body: JSON.stringify({
      client_msg_id: crypto.randomUUID(),
      question: `Какой день удобнее для выездного занятия? ${tag}`,
      options: ["Вторник", "Среда", "Четверг"],
      multiple: false,
      anonymous: false,
      due_at: due.toISOString(),
    }),
  },
  anna.access_token,
);
await call(
  `/api/v1/polls/${open.id}/vote`,
  { method: "PUT", body: JSON.stringify({ options: [1] }) },
  oleg.access_token,
);
const anonymous = await call(
  `/api/v1/chats/${chat.id}/polls`,
  {
    method: "POST",
    body: JSON.stringify({
      client_msg_id: crypto.randomUUID(),
      question: `Удобно ли новое расписание бассейна? ${tag}`,
      options: ["Да, всё устраивает", "Неудобно утро", "Неудобен вечер"],
      multiple: false,
      anonymous: true,
    }),
  },
  anna.access_token,
);
console.log(
  `Polls ${open.id} and ${anonymous.id} from Анна in «${chatName}» (${chat.id}), tag ${tag}.`,
);
