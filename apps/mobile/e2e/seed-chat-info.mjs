#!/usr/bin/env node
// Data of chat-info.yaml, safe to repeat on a clean instance and after other
// flows:
//   1. a colleague of the test account, Мария Соколова (made by invitation
//      the first time, then she signs in);
//   2. the group «Сведения о чате» the account owns, with her in it;
//   3. its archive: seed-media.mjs (photos, videos), seed-voice.mjs (voice)
//      and seed-archive.mjs (links, a document) posted there, so the group
//      becomes the most recent chat, the first row of the list.
//
//   COMA_API=http://localhost:8080 COMA_EMAIL=… COMA_PASSWORD=… \
//     node apps/mobile/e2e/seed-chat-info.mjs
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const chatName = "Сведения о чате";
export const colleague = {
  email: "maria.info@example.test",
  password: "coma-info-maria-1",
  name: "Мария Соколова",
  handle: "maria_info",
};

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

const token = (
  await login(
    process.env.COMA_EMAIL ?? "lev@example.test",
    process.env.COMA_PASSWORD ?? "coma-mobile-dev-1",
  )
).access_token;

async function member(person) {
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

const maria = await member(colleague);

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
if (!members.some((item) => item.actor_id === maria.user.id))
  await call(
    `/api/v1/chats/${chat.id}/members`,
    {
      method: "POST",
      body: JSON.stringify({ actor_id: maria.user.id, role: "member" }),
    },
    token,
  );

for (const seed of ["seed-media.mjs", "seed-voice.mjs", "seed-archive.mjs"])
  execFileSync(
    process.execPath,
    [fileURLToPath(new URL(`./${seed}`, import.meta.url))],
    { stdio: "inherit", env: { ...process.env, COMA_CHAT_ID: chat.id } },
  );
console.log(`«${chatName}» (${chat.id}) is ready for chat-info.yaml.`);
