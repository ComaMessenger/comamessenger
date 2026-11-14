#!/usr/bin/env node
// Data of walkthrough.yaml in its own chat «Обход интерфейса», so the flow
// does not depend on what other runs and seeds left in shared chats. Every
// run appends a fresh set to the end of the chat (older sets stay above and
// do not get in the way):
//   1. «Обход: вопрос для цитаты»;
//   2. a reply to it that quotes it — «Обход: ответ с цитатой»;
//   3. a photo (e2e/fixtures/photo-square.jpg);
//   4. «Тред обхода <HHMMSS>: что выпускаем в пятницу» with two thread
//      replies and 👍; the tag makes the root of this run the only match
//      (scripts/walkthrough-root.js reads it for the flow).
// The chat becomes the most recent one, the first row of the chat list.
//
//   COMA_API=http://localhost:8080 COMA_EMAIL=… COMA_PASSWORD=… \
//     node apps/mobile/e2e/seed-walkthrough.mjs
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const chatName = "Обход интерфейса";

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

const { access_token: token } = await call("/api/v1/auth/login", {
  method: "POST",
  body: JSON.stringify({
    email: process.env.COMA_EMAIL ?? "lev@example.test",
    password: process.env.COMA_PASSWORD ?? "coma-mobile-dev-1",
  }),
});

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

async function upload(name, mime) {
  const bytes = await readFile(
    fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)),
  );
  const created = await call(
    "/api/v1/files/uploads",
    {
      method: "POST",
      body: JSON.stringify({ name, mime, size: bytes.length }),
    },
    token,
  );
  if (created.mode === "streaming") {
    const response = await fetch(
      `${api}${created.upload_url ?? `/api/v1/files/uploads/${created.id}/content`}`,
      {
        method: "PUT",
        headers: { "Content-Type": mime, Authorization: `Bearer ${token}` },
        body: bytes,
      },
    );
    if (!response.ok) throw new Error(`streaming PUT: ${response.status}`);
    return response.json();
  }
  const put = await fetch(created.upload_url, {
    method: "PUT",
    headers: { "Content-Type": mime },
    body: bytes,
  });
  if (!put.ok) throw new Error(`presigned PUT: ${put.status}`);
  return call(
    `/api/v1/files/uploads/${created.id}/complete`,
    { method: "POST", body: "{}" },
    token,
  );
}

const post = (body, extra = {}) =>
  call(
    `/api/v1/chats/${chat.id}/messages`,
    {
      method: "POST",
      body: JSON.stringify({
        client_msg_id: crypto.randomUUID(),
        body,
        body_format: "markdown",
        ...extra,
      }),
    },
    token,
  );

const question = await post("Обход: вопрос для цитаты");
await post("Обход: ответ с цитатой", { reply_to_id: question.id });
const photo = await upload("photo-square.jpg", "image/jpeg");
await post("", { file_ids: [photo.id] });
const tag = new Date().toTimeString().slice(0, 8).replace(/:/g, "");
const root = await post(`Тред обхода ${tag}: что выпускаем в пятницу`);
await post("Сборка 1.4 и заметки к выпуску.", { thread_root_id: root.id });
await post("Проверю на телефоне до обеда.", { thread_root_id: root.id });
await call(
  `/api/v1/messages/${root.id}/reactions/${encodeURIComponent("👍")}`,
  { method: "PUT" },
  token,
);
console.log(`Walkthrough data posted to «${chatName}» (${chat.id}).`);
