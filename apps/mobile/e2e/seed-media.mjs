#!/usr/bin/env node
// Posts photos and videos to a chat for media.yaml and video.yaml: one
// message with a tall photo, a wide photo, a square photo and a video (a
// mosaic), then a lone portrait video with sound, then a lone wide photo.
// The simulator cannot film, and the media viewer needs several items to
// page through. Fixtures in e2e/fixtures are made with ffmpeg test sources.
//
//   COMA_API=http://localhost:8080 COMA_EMAIL=… COMA_PASSWORD=… \
//     [COMA_CHAT_ID=…] node apps/mobile/e2e/seed-media.mjs
//
// Without COMA_CHAT_ID the most recently active chat is used, as in
// seed-voice.mjs: the first row of the chat list.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const api = (process.env.COMA_API ?? "http://localhost:8080").replace(
  /\/$/,
  "",
);
const fixture = (name) =>
  readFile(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)));

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
    email: process.env.COMA_EMAIL,
    password: process.env.COMA_PASSWORD,
  }),
});

let chatID = process.env.COMA_CHAT_ID;
if (!chatID) {
  const { chats } = await call("/api/v1/chats", {}, token);
  chats.sort((a, b) =>
    (b.last_message_at ?? b.created_at).localeCompare(
      a.last_message_at ?? a.created_at,
    ),
  );
  chatID = chats.find((chat) => chat.kind !== "channel")?.id;
  if (!chatID) throw new Error("No chat to post into.");
}

async function upload(name, mime) {
  const bytes = await fixture(name);
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
  if (created.mode !== "presigned")
    throw new Error(`Unexpected upload mode ${created.mode} for a small file.`);
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

async function post(files, body = "") {
  await call(
    `/api/v1/chats/${chatID}/messages`,
    {
      method: "POST",
      body: JSON.stringify({
        client_msg_id: crypto.randomUUID(),
        body,
        body_format: "markdown",
        file_ids: files.map((file) => file.id),
      }),
    },
    token,
  );
}

await post([
  await upload("photo-tall.jpg", "image/jpeg"),
  await upload("photo-wide.jpg", "image/jpeg"),
  await upload("photo-square.jpg", "image/jpeg"),
  await upload("video-wide.mp4", "video/mp4"),
]);
await post(
  [await upload("video-portrait.mp4", "video/mp4")],
  "Видео со звуком",
);
await post([await upload("photo-wide.jpg", "image/jpeg")]);
console.log(`Media posted to chat ${chatID}.`);
