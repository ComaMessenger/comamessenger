#!/usr/bin/env node
// Posts two voice messages in a row to a chat, so voice.yaml can check
// playback, speed and autoplay of the next one: a simulator cannot record.
// Uses the reference recording of the server tests (1.4 s of AAC in m4a).
//
//   COMA_API=http://localhost:8080 COMA_EMAIL=… COMA_PASSWORD=… \
//     [COMA_CHAT_ID=…] node apps/mobile/e2e/seed-voice.mjs
//
// Without COMA_CHAT_ID the most recently active chat is used: it is the
// first row of the chat list (unless other chats are pinned above it).
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const api = (process.env.COMA_API ?? "http://localhost:8080").replace(/\/$/, "");
const recording = await readFile(
  fileURLToPath(
    new URL("../../../core/internal/files/testdata/voice.m4a", import.meta.url),
  ),
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
    throw new Error(`${init.method ?? "GET"} ${path}: ${response.status} ${text}`);
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

const waveform = Array.from({ length: 64 }, (_, index) =>
  Math.round(40 + 180 * Math.abs(Math.sin(index / 5))),
);

async function postVoice() {
  const upload = await call(
    "/api/v1/files/uploads",
    {
      method: "POST",
      body: JSON.stringify({
        name: "voice.m4a",
        mime: "audio/mp4",
        size: recording.length,
        voice: { duration_ms: 1400, waveform },
      }),
    },
    token,
  );
  let file;
  if (upload.mode === "streaming") {
    const response = await fetch(
      `${api}${upload.upload_url ?? `/api/v1/files/uploads/${upload.id}/content`}`,
      {
        method: "PUT",
        headers: { "Content-Type": "audio/mp4", Authorization: `Bearer ${token}` },
        body: recording,
      },
    );
    if (!response.ok) throw new Error(`streaming PUT: ${response.status}`);
    file = await response.json();
  } else {
    const put = await fetch(upload.upload_url, {
      method: "PUT",
      headers: { "Content-Type": "audio/mp4" },
      body: recording,
    });
    if (!put.ok) throw new Error(`presigned PUT: ${put.status}`);
    file = await call(
      `/api/v1/files/uploads/${upload.id}/complete`,
      { method: "POST", body: "{}" },
      token,
    );
  }
  await call(
    `/api/v1/chats/${chatID}/messages`,
    {
      method: "POST",
      body: JSON.stringify({
        client_msg_id: crypto.randomUUID(),
        body: "",
        body_format: "plain",
        file_ids: [file.id],
      }),
    },
    token,
  );
}

await postVoice();
await postVoice();
console.log(`Two voice messages posted to chat ${chatID}.`);
