#!/usr/bin/env node
// Data of the org flows (org-people, org-tree, org-admin, org-mention): a
// small rehabilitation centre, rebuilt from scratch on every run so the
// flows do not depend on what earlier runs changed.
//
//   Реабилитация (lead: the account of the flows)
//     Зал ЛФК (lead Ирина Лебедева; Олег Чернов, Анна Иванова;
//              Пётр Морозов «совм.»)
//     Бассейн (lead Пётр Морозов)
//   Медицинская служба (lead Дарья Романова)
//   «Бассейн» has a chat; Анна Иванова joins it as «совм.» afterwards.
//   Нина Ковалёва — без отдела. Positions «Инструктор», «Врач».
//
// The departments and positions of the seed (and «E2E …» ones the admin flow
// leaves after a failed run) are deleted and created again; other
// departments are left alone. People are invited once and kept. The group
// «Планёрка ЛФК» (the account, Ирина, Олег, Нина, Пётр) gets a fresh
// message and becomes the first row of the chat list.
//
//   COMA_API=http://localhost:8080 COMA_EMAIL=… COMA_PASSWORD=… \
//     node apps/mobile/e2e/seed-org.mjs

const api = (process.env.COMA_API ?? "http://localhost:8080").replace(
  /\/$/,
  "",
);
const password = "coma-org-e2e-1";

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

const login = async (email, secret) =>
  (
    await call("/api/v1/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password: secret }),
    })
  ).access_token;

const token = await login(
  process.env.COMA_EMAIL ?? "lev@example.test",
  process.env.COMA_PASSWORD ?? "coma-mobile-dev-1",
);
const me = await call("/api/v1/me", {}, token);

const staff = [
  { handle: "irina.l", name: "Ирина Лебедева", title: "Старший инструктор ЛФК" },
  { handle: "oleg.ch", name: "Олег Чернов", title: "Инструктор" },
  { handle: "anna.iv", name: "Анна Иванова", title: "Инструктор" },
  { handle: "petr.m", name: "Пётр Морозов", title: "Инструктор по плаванию" },
  { handle: "daria.r", name: "Дарья Романова", title: "Врач ЛФК" },
  { handle: "nina.k", name: "Нина Ковалёва", title: "Массажист" },
];

async function allActors() {
  const actors = [];
  let after = "";
  for (let page = 0; page < 50; page += 1) {
    const query = after ? `?after_id=${encodeURIComponent(after)}` : "";
    const result = await call(`/api/v1/actors${query}`, {}, token);
    actors.push(...result.actors);
    if (!result.next_after_id) break;
    after = result.next_after_id;
  }
  return actors;
}

let actors = await allActors();
const ids = {};
for (const person of staff) {
  let actor = actors.find((item) => item.handle === person.handle);
  if (!actor) {
    const email = `${person.handle}@example.test`;
    const invitation = await call(
      "/api/v1/invitations",
      { method: "POST", body: JSON.stringify({ email, role: "member" }) },
      token,
    );
    const accepted = await call(
      `/api/v1/invitations/${invitation.accept_url.split("/").pop()}/accept`,
      {
        method: "POST",
        body: JSON.stringify({
          display_name: person.name,
          handle: person.handle,
          password,
        }),
      },
    );
    const own = await login(email, password);
    await call(
      "/api/v1/me",
      { method: "PATCH", body: JSON.stringify({ title: person.title }) },
      own,
    );
    actor = { actor_id: accepted.user.id };
  }
  ids[person.handle] = actor.actor_id;
}

// --- The structure, rebuilt -------------------------------------------------
const departmentNames = [
  "Реабилитация",
  "Зал ЛФК",
  "Бассейн",
  "Медицинская служба",
];
const positionNames = ["Инструктор", "Врач"];

let structure = await call("/api/v1/org", {}, token);
const depth = (department) => {
  let level = 0;
  let parent = department.parent_id;
  while (parent && level < 10) {
    parent = structure.departments.find((item) => item.id === parent)?.parent_id;
    level += 1;
  }
  return level;
};
const doomed = structure.departments
  .filter(
    (item) =>
      departmentNames.includes(item.name) || /^E2E\b/.test(item.name),
  )
  .sort((left, right) => depth(right) - depth(left));
for (const department of doomed)
  await call(
    `/api/v1/org/departments/${department.id}?members_to=none`,
    { method: "DELETE" },
    token,
  );
for (const position of structure.positions.filter(
  (item) => positionNames.includes(item.name) || /^E2E\b/.test(item.name),
))
  await call(
    `/api/v1/org/positions/${position.id}`,
    { method: "DELETE" },
    token,
  );
// Nobody of the seed keeps a department from elsewhere.
for (const id of [me.id, ...Object.values(ids)])
  await call(
    `/api/v1/org/people/${id}`,
    {
      method: "PUT",
      body: JSON.stringify({
        primary_department_id: null,
        additional_department_ids: [],
        position_id: null,
      }),
    },
    token,
  );

const department = async (name, parent, lead, members) =>
  (
    await call(
      "/api/v1/org/departments",
      {
        method: "POST",
        body: JSON.stringify({
          name,
          ...(parent ? { parent_id: parent } : {}),
          lead_actor_id: lead,
          members: members.map(([actor_id, primary]) => ({
            actor_id,
            primary,
          })),
        }),
      },
      token,
    )
  ).department.id;

const rehab = await department("Реабилитация", null, me.id, [[me.id, true]]);
const gym = await department("Зал ЛФК", rehab, ids["irina.l"], [
  [ids["irina.l"], true],
  [ids["oleg.ch"], true],
  [ids["anna.iv"], true],
]);
await department("Бассейн", rehab, ids["petr.m"], [[ids["petr.m"], true]]);
await call(
  `/api/v1/org/departments/${gym}/members/${ids["petr.m"]}`,
  { method: "PUT", body: JSON.stringify({ primary: false }) },
  token,
);
await department("Медицинская служба", null, ids["daria.r"], [
  [ids["daria.r"], true],
]);

const created = await call(
  "/api/v1/org/positions/bulk",
  { method: "POST", body: JSON.stringify({ names: positionNames }) },
  token,
);
const position = (name) =>
  created.created.find((item) => item.name === name).id;
await call(
  "/api/v1/org/people/assign",
  {
    method: "POST",
    body: JSON.stringify({
      actor_ids: ["irina.l", "oleg.ch", "anna.iv", "petr.m"].map(
        (handle) => ids[handle],
      ),
      position_id: position("Инструктор"),
    }),
  },
  token,
);
await call(
  "/api/v1/org/people/assign",
  {
    method: "POST",
    body: JSON.stringify({
      actor_ids: [ids["daria.r"]],
      position_id: position("Врач"),
    }),
  },
  token,
);

// «Бассейн» has a chat without Анна Иванова, who joins the department
// after it: its card shows «В чате нет 1 сотрудника отдела · Добавить».
const pool = (await call("/api/v1/org", {}, token)).departments.find(
  (item) => item.name === "Бассейн",
).id;
await call(`/api/v1/org/departments/${pool}/chat`, { method: "POST" }, token);
await call(
  `/api/v1/org/departments/${pool}/members/${ids["anna.iv"]}`,
  { method: "PUT", body: JSON.stringify({ primary: false }) },
  token,
);

// --- The chat of the @отдел flow -------------------------------------------
const chatName = "Планёрка ЛФК";
const { chats } = await call("/api/v1/chats", {}, token);
let chat = chats.find(
  (item) => item.kind === "group" && item.name === chatName,
);
if (!chat)
  chat = await call(
    "/api/v1/chats",
    {
      method: "POST",
      body: JSON.stringify({ kind: "group", name: chatName }),
    },
    token,
  );
const members = await call(`/api/v1/chats/${chat.id}/members`, {}, token);
const present = new Set(
  (Array.isArray(members) ? members : members.members).map(
    (item) => item.actor_id,
  ),
);
for (const handle of ["irina.l", "oleg.ch", "nina.k", "petr.m"])
  if (!present.has(ids[handle]))
    await call(
      `/api/v1/chats/${chat.id}/members`,
      { method: "POST", body: JSON.stringify({ actor_id: ids[handle] }) },
      token,
    );
await call(
  `/api/v1/chats/${chat.id}/messages`,
  {
    method: "POST",
    body: JSON.stringify({
      client_msg_id: crypto.randomUUID(),
      body: "Маты в малом зале разложил.",
      body_format: "markdown",
    }),
  },
  token,
);

structure = await call("/api/v1/org", {}, token);
console.log(
  `org seeded: ${structure.departments.length} departments, ${structure.positions.length} positions, chat ${chat.id}`,
);
