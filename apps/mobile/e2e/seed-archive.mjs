#!/usr/bin/env node
// Fills the chat archive for chat-info.yaml: links (with a markdown label, a
// Cyrillic domain and a look-alike one shown in punycode) and a document, on
// top of seed-media.mjs (photos, videos) and seed-voice.mjs (voice). Run all
// three after chat-create.yaml, so they land in the group it made:
//
//   COMA_API=http://localhost:8080 COMA_EMAIL=… COMA_PASSWORD=… \
//     [COMA_CHAT_ID=…] node apps/mobile/e2e/seed-archive.mjs
//
// Without COMA_CHAT_ID the most recently active chat is used, as in
// seed-media.mjs: the first row of the chat list.
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

async function post(body, files = []) {
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

// A small PDF made here: no fixture needed for a file card.
const pdf = Buffer.from(
  "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n",
);
const created = await call(
  "/api/v1/files/uploads",
  {
    method: "POST",
    body: JSON.stringify({
      name: "Бриф на сайт.pdf",
      mime: "application/pdf",
      size: pdf.length,
    }),
  },
  token,
);
let file;
if (created.mode === "streaming") {
  const response = await fetch(
    `${api}${created.upload_url ?? `/api/v1/files/uploads/${created.id}/content`}`,
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/pdf",
        Authorization: `Bearer ${token}`,
      },
      body: pdf,
    },
  );
  if (!response.ok) throw new Error(`streaming PUT: ${response.status}`);
  file = await response.json();
} else {
  const put = await fetch(created.upload_url, {
    method: "PUT",
    headers: { "Content-Type": "application/pdf" },
    body: pdf,
  });
  if (!put.ok) throw new Error(`presigned PUT: ${put.status}`);
  file = await call(
    `/api/v1/files/uploads/${created.id}/complete`,
    { method: "POST", body: "{}" },
    token,
  );
}

await post("Бриф на сайт — в файле, посмотрите до пятницы", [file]);
await post(
  "Макеты: [Figma, версия 3](https://www.figma.com/file/abc/Site), обсуждение — https://github.com/acme/site/pull/42.",
);
await post("Сайт клиента: https://пример.рф/бриф (кириллический домен)");
await post("Не путать с https://аррӏе.com/login — это подделка.");
console.log(`Archive seeded in chat ${chatID}.`);
