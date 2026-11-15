#!/usr/bin/env node
// Data of away.yaml and away-peer.yaml (phase 6.7, «Отсутствую»):
//   1. three colleagues of the test account — Анна Иванова, Марина
//      Соколова, Олег Чернов (made by invitation the first time);
//   2. Анна is on vacation from now for a week: an auto-reply in direct
//      chats, Марина substitutes, notifications off. Олег is on a trip until
//      tomorrow and the test account substitutes him («Вы замещаете Олега»).
//      Both are set again on every run, so the auto-reply goes once more;
//   3. the direct chat of the account with Анна, and the group «Отсутствие ·
//      инструкторы» with the four of them;
//   4. the account's own away status and custom status cleared, so away.yaml
//      starts from «Установить статус».
//
//   COMA_API=http://localhost:8080 COMA_EMAIL=… COMA_PASSWORD=… \
//     node apps/mobile/e2e/seed-away.mjs
export const groupName = "Отсутствие · инструкторы";
export const colleagues = [
  {
    email: "anna.away@example.test",
    password: "coma-away-anna-1",
    name: "Анна Иванова",
    handle: "anna_away",
  },
  {
    email: "marina.away@example.test",
    password: "coma-away-marina-1",
    name: "Марина Соколова",
    handle: "marina_away",
  },
  {
    email: "oleg.away@example.test",
    password: "coma-away-oleg-1",
    name: "Олег Чернов",
    handle: "oleg_away",
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
const [anna, marina, oleg] = people;

// The account starts without a status of its own.
await call("/api/v1/me/away", { method: "DELETE" }, token);
await call("/api/v1/me/status", { method: "DELETE" }, token);

// Анна: a week of vacation from now, whole days.
const end = new Date();
end.setDate(end.getDate() + 8);
end.setHours(0, 0, 0, 0);
await call("/api/v1/me/away", { method: "DELETE" }, anna.access_token);
await call(
  "/api/v1/me/away",
  {
    method: "PUT",
    body: JSON.stringify({
      kind: "vacation",
      ends_at: end.toISOString(),
      autoreply: {
        enabled: true,
        text: "Я в отпуске, вернусь через неделю. По срочным вопросам — к Марине Соколовой.",
      },
      substitute_id: marina.user.id,
      mute_push: true,
    }),
  },
  anna.access_token,
);
// Олег: on a trip until tomorrow, the account substitutes.
const tomorrow = new Date();
tomorrow.setDate(tomorrow.getDate() + 2);
tomorrow.setHours(0, 0, 0, 0);
await call("/api/v1/me/away", { method: "DELETE" }, oleg.access_token);
await call(
  "/api/v1/me/away",
  {
    method: "PUT",
    body: JSON.stringify({
      kind: "trip",
      ends_at: tomorrow.toISOString(),
      autoreply: { enabled: false, text: "" },
      substitute_id: owner.user.id,
      mute_push: false,
    }),
  },
  oleg.access_token,
);

const { chats } = await call("/api/v1/chats", {}, token);
let direct = chats.find(
  (item) => item.kind === "direct" && item.direct_peer?.actor_id === anna.user.id,
);
if (!direct)
  direct = await call(
    "/api/v1/chats",
    {
      method: "POST",
      body: JSON.stringify({ kind: "direct", member_ids: [anna.user.id] }),
    },
    token,
  );
let group = chats.find(
  (item) => item.kind === "group" && item.name === groupName,
);
if (!group)
  group = await call(
    "/api/v1/chats",
    { method: "POST", body: JSON.stringify({ kind: "group", name: groupName }) },
    token,
  );
const { members } = await call(`/api/v1/chats/${group.id}/members`, {}, token);
for (const person of people)
  if (!members.some((member) => member.actor_id === person.user.id))
    await call(
      `/api/v1/chats/${group.id}/members`,
      {
        method: "POST",
        body: JSON.stringify({ actor_id: person.user.id, role: "member" }),
      },
      token,
    );
// Марина writes in the group, so it is the latest chat.
await call(
  `/api/v1/chats/${group.id}/messages`,
  {
    method: "POST",
    body: JSON.stringify({
      client_msg_id: crypto.randomUUID(),
      body: "В среду в бассейне нужен человек на утро.",
      body_format: "plain",
    }),
  },
  marina.access_token,
);
console.log(
  `Анна away until ${end.toISOString()}, Олег until ${tomorrow.toISOString()}; direct ${direct.id}, group ${group.id}.`,
);
