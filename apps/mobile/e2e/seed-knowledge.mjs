#!/usr/bin/env node
// Fills the knowledge base for knowledge.yaml: a collection open to everyone
// with a Markdown page, a text file, a PDF with a text layer and a PDF scan
// without text (its indexing fails on purpose), and a collection shared with
// one chat. Earlier copies (same names) are removed first, so it can run again.
//
//   COMA_API=http://localhost:8080 COMA_EMAIL=… COMA_PASSWORD=… \
//     node apps/mobile/e2e/seed-knowledge.mjs
const api = (process.env.COMA_API ?? "http://localhost:8080").replace(/\/$/, "");
const names = ["Регламенты центра", "Инструкторам зала"];

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
    email: process.env.COMA_EMAIL ?? "lev@example.test",
    password: process.env.COMA_PASSWORD ?? "coma-mobile-dev-1",
  }),
});

async function upload(name, mime, bytes) {
  const created = await call(
    "/api/v1/files/uploads",
    { method: "POST", body: JSON.stringify({ name, mime, size: bytes.length }) },
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

/** A one-page PDF with a real text layer and a correct cross-reference table. */
function textPDF(lines) {
  const stream = [
    "BT /F1 14 Tf 40 760 Td 18 TL",
    ...lines.map((line) => `(${line.replace(/[()\\]/g, "\\$&")}) '`),
    "ET",
  ].join("\n");
  const objects = [
    "<</Type/Catalog/Pages 2 0 R>>",
    "<</Type/Pages/Kids[3 0 R]/Count 1>>",
    "<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>",
    "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>",
    `<</Length ${Buffer.byteLength(stream)}>>\nstream\n${stream}\nendstream`,
  ];
  let body = "%PDF-1.4\n";
  const offsets = objects.map((object, index) => {
    const offset = Buffer.byteLength(body);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body);
}

for (const collection of await call("/api/v1/knowledge/collections", {}, token))
  if (names.includes(collection.name))
    await call(`/api/v1/knowledge/collections/${collection.id}`, { method: "DELETE" }, token);

const rules = await call(
  "/api/v1/knowledge/collections",
  {
    method: "POST",
    body: JSON.stringify({
      name: names[0],
      description: "Отпуска, пропуска и замены: то, на что опирается агент «Справка».",
      access: "organization",
    }),
  },
  token,
);

async function add(collectionID, document) {
  return call(
    `/api/v1/knowledge/collections/${collectionID}/documents`,
    { method: "POST", body: JSON.stringify(document) },
    token,
  );
}

await add(rules.id, {
  kind: "page",
  title: "Отпуск инструкторов",
  body: [
    "# Как оформить отпуск",
    "Заявление на отпуск подаётся **за две недели** старшему администратору.",
    "",
    "## Замена",
    "- Найдите замену на свои слоты",
    "- Передайте ключи от зала следующему инструктору",
    "",
    "## Больничный",
    "Заболевший инструктор сообщает дежурному администратору до 08:00.",
  ].join("\n"),
});
const passes = await upload(
  "Пропуска.txt",
  "text/plain",
  Buffer.from(
    "Пропуск выдаёт администратор на ресепшене.\n\nВременный пропуск действует один день. Потерянный пропуск восстанавливают за 300 рублей.\n",
  ),
);
await add(rules.id, { kind: "file", file_id: passes.id });
const policy = await upload(
  "Vacation policy.pdf",
  "application/pdf",
  textPDF([
    "Vacation policy",
    "Instructors request a vacation two weeks in advance.",
    "A vacation longer than ten days needs the director.",
  ]),
);
await add(rules.id, { kind: "file", file_id: policy.id, title: "Политика отпусков (EN)" });
const scan = await upload(
  "Скан приказа.pdf",
  "application/pdf",
  Buffer.from(
    "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n",
  ),
);
await add(rules.id, { kind: "file", file_id: scan.id });

const { chats } = await call("/api/v1/chats", {}, token);
const group = chats.find((chat) => chat.kind !== "direct");
const hall = await call(
  "/api/v1/knowledge/collections",
  {
    method: "POST",
    body: JSON.stringify({
      name: names[1],
      description: "Памятки для тех, кто ведёт занятия в зале.",
      access: group ? "chats" : "organization",
      chat_ids: group ? [group.id] : [],
    }),
  },
  token,
);
await add(hall.id, {
  kind: "page",
  title: "Передача смены",
  body: "# Передача\nКлючи от зала и журнал передаются следующему инструктору лично.",
});

// Wait for indexing so the screens show final statuses.
for (let attempt = 0; attempt < 30; attempt += 1) {
  const documents = [
    ...(await call(`/api/v1/knowledge/collections/${rules.id}/documents`, {}, token)),
    ...(await call(`/api/v1/knowledge/collections/${hall.id}/documents`, {}, token)),
  ];
  if (documents.every((document) => document.status === "ready" || document.status === "failed")) {
    console.log(documents.map((document) => `${document.title}: ${document.status} ${document.error_code}`).join("\n"));
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
console.log(`Knowledge seeded: ${rules.id}, ${hall.id}.`);
