import type { Page, Route } from "@playwright/test";

/**
 * In-memory knowledge base API layered over mockMessenger(): routes registered
 * later win, everything else falls back to the messenger mock. Fictional data
 * of a rehabilitation centre.
 */
export const knowledgeIDs = {
  rules: "00000000-0000-4000-8000-0000000000a1",
  instructors: "00000000-0000-4000-8000-0000000000a2",
  rulesPage: "00000000-0000-4000-8000-0000000000b1",
  slots: "00000000-0000-4000-8000-0000000000b2",
  scan: "00000000-0000-4000-8000-0000000000b3",
  connection: "00000000-0000-4000-8000-0000000000c1",
  blocked: "00000000-0000-4000-8000-0000000000c2",
  member: "01a01612-85e4-7145-bda3-82db7b4a3075",
};

type Collection = Record<string, unknown> & {
  id: string;
  name: string;
  access: "organization" | "chats";
  chat_ids: string[];
  embedding_connection_id: string | null;
  document_count: number;
  semantic_search: boolean;
  can_manage: boolean;
  updated_at: string;
};
type Document = Record<string, unknown> & {
  id: string;
  collection_id: string;
  kind: "file" | "page";
  title: string;
  status: "pending" | "processing" | "ready" | "failed";
  error_code: string;
  chunk_count: number;
  content_version: number;
  body?: string;
  file_name: string | null;
  file_mime: string | null;
};
type Fragment = {
  chunk_id: string;
  position: number;
  section: string;
  content: string;
};

const ownerID = "00000000-0000-4000-8000-000000000001";
const stamp = "2026-11-09T08:10:00Z";
const rulesBody = `# Правила центра

Общие положения для инструкторов и врачей.

## Отпуска

Заявление на отпуск подаётся администратору за две недели. Замену на слоты подбирает старший инструктор.

## Передача дел

Инструктор передаёт дела следующему по слоту через чат «Передача».`;

function fragmentsOf(markdown: string, prefix: string): Fragment[] {
  const sections: Fragment[] = [];
  let heading = "";
  let root = "";
  for (const block of markdown.split(/\n{2,}/)) {
    const match = /^(#{1,3})\s+(.*)$/.exec(block.trim());
    if (match) {
      if (match[1] === "#") root = match[2]!;
      heading = match[1] === "#" ? root : `${root} › ${match[2]}`;
      continue;
    }
    sections.push({
      chunk_id: `${prefix}${String(sections.length + 1).padStart(4, "0")}`,
      position: sections.length,
      section: heading,
      content: block.trim(),
    });
  }
  return sections;
}

export async function mockKnowledge(
  page: Page,
  options: { manage?: boolean; empty?: boolean } = {},
) {
  const { manage = true, empty = false } = options;
  let sequence = 0;
  const nextID = (prefix: string) =>
    `${prefix}${String((sequence += 1)).padStart(12, "0")}`;
  const collections: Collection[] = empty
    ? []
    : [
        {
          id: knowledgeIDs.rules,
          name: "Регламенты центра",
          description: "Правила для инструкторов, врачей и администраторов.",
          access: "organization",
          chat_ids: [],
          embedding_connection_id: manage ? knowledgeIDs.connection : null,
          document_count: 3,
          semantic_search: true,
          can_manage: manage,
          created_by: ownerID,
          created_at: stamp,
          updated_at: stamp,
        },
        {
          id: knowledgeIDs.instructors,
          name: "Инструкторам",
          description: "",
          access: "chats",
          chat_ids: manage ? ["00000000-0000-4000-8000-000000000020"] : [],
          embedding_connection_id: null,
          document_count: 0,
          semantic_search: false,
          can_manage: manage,
          created_by: ownerID,
          created_at: stamp,
          updated_at: stamp,
        },
      ];
  const document = (patch: Partial<Document> & Pick<Document, "id" | "kind" | "title">): Document => ({
    collection_id: knowledgeIDs.rules,
    file_id: null,
    file_name: null,
    file_mime: null,
    file_size: null,
    status: "ready",
    error_code: "",
    embedding_status: "ready",
    chunk_count: 0,
    content_version: 1,
    indexed_at: stamp,
    created_by: ownerID,
    created_at: stamp,
    updated_at: stamp,
    ...patch,
  });
  const fragments: Record<string, Fragment[]> = {
    [knowledgeIDs.rulesPage]: fragmentsOf(rulesBody, "00000000-0000-4000-8000-0000000d"),
    [knowledgeIDs.slots]: [
      {
        chunk_id: "00000000-0000-4000-8000-0000000e0001",
        position: 0,
        section: "Слоты",
        content: "Инструктор: Иванова; Слот: 09:00\nИнструктор: Петров; Слот: 11:00",
      },
    ],
  };
  const documents: Record<string, Document[]> = {
    [knowledgeIDs.rules]: empty
      ? []
      : [
          document({
            id: knowledgeIDs.rulesPage,
            kind: "page",
            title: "Правила центра",
            body: rulesBody,
            chunk_count: fragments[knowledgeIDs.rulesPage]!.length,
          }),
          document({
            id: knowledgeIDs.slots,
            kind: "file",
            title: "Расписание слотов.xlsx",
            file_id: "00000000-0000-4000-8000-0000000f0001",
            file_name: "Расписание слотов.xlsx",
            file_mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            file_size: 18_432,
            chunk_count: 1,
          }),
          document({
            id: knowledgeIDs.scan,
            kind: "file",
            title: "Скан приказа.pdf",
            file_id: "00000000-0000-4000-8000-0000000f0002",
            file_name: "Скан приказа.pdf",
            file_mime: "application/pdf",
            file_size: 512_000,
            status: "failed",
            error_code: "no_text_extracted",
            embedding_status: "none",
            indexed_at: null,
          }),
        ],
    [knowledgeIDs.instructors]: [],
  };
  const uploads = new Map<string, { name: string; mime: string; size: number }>();
  const pendingReads = new Map<string, number>();
  const members = [
    {
      actor_id: ownerID,
      email: "owner@example.com",
      display_name: "Анна",
      handle: "anna",
      title: "Главный администратор",
      role: "owner",
      status: "active",
      permissions: [] as string[],
      created_at: "2026-08-19T00:00:00Z",
      last_seen_at: "2026-08-20T00:00:00Z",
      avatar_version: 0,
    },
    {
      actor_id: knowledgeIDs.member,
      email: "lev@example.com",
      display_name: "Лев",
      handle: "lev",
      title: "Инструктор",
      role: "member",
      status: "active",
      permissions: [] as string[],
      created_at: "2026-08-19T00:00:00Z",
      last_seen_at: "2026-08-20T00:00:00Z",
      avatar_version: 0,
    },
  ];
  const requests: string[] = [];

  function allDocuments() {
    return Object.values(documents).flat();
  }
  function refreshCount(collectionID: string) {
    const collection = collections.find((item) => item.id === collectionID);
    if (collection) collection.document_count = documents[collectionID]?.length ?? 0;
  }
  // Each read moves a queued document one step: queued → processing → result.
  function advance(item: Document) {
    if (item.status !== "pending" && item.status !== "processing") return;
    const reads = (pendingReads.get(item.id) ?? 0) + 1;
    pendingReads.set(item.id, reads);
    if (reads === 2) item.status = "processing";
    if (reads < 3) return;
    if (item.file_name?.endsWith(".pdf")) {
      item.status = "failed";
      item.error_code = "no_text_extracted";
      return;
    }
    const source =
      item.kind === "page"
        ? (item.body ?? "")
        : `# ${item.title}\n\nЗамена на слот оформляется у старшего инструктора.`;
    fragments[item.id] = fragmentsOf(source, `${item.id.slice(0, 28)}`.padEnd(28, "0"));
    item.status = "ready";
    item.chunk_count = fragments[item.id]!.length;
    item.indexed_at = stamp;
  }

  async function reply(route: Route, status: number, body?: unknown) {
    await route.fulfill({
      status,
      contentType: "application/json",
      body: body === undefined ? "" : JSON.stringify(body),
    });
  }

  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace(/^.*\/api\/v1/, "");
    const method = request.method();
    if (path.startsWith("/knowledge")) requests.push(`${method} ${path}`);

    if (path === "/organization/members" && method === "GET")
      return reply(route, 200, { members });
    const member = /^\/organization\/members\/([^/]+)$/.exec(path);
    if (member && method === "PATCH") {
      const target = members.find((item) => item.actor_id === member[1]);
      const input = request.postDataJSON() as { permissions?: string[] };
      if (target && input.permissions) target.permissions = input.permissions;
      return reply(route, 200, target);
    }

    if (path === "/files/uploads" && method === "POST") {
      const input = request.postDataJSON() as { name: string; mime: string; size: number };
      const id = nextID("00000000-0000-4000-8000-");
      uploads.set(id, input);
      return reply(route, 201, {
        id,
        mode: "streaming",
        expires_at: "2026-11-11T00:00:00Z",
        file: { id, name: input.name, mime: input.mime, size: input.size, status: "pending", processing_status: "pending", created_at: stamp, uploader_id: ownerID },
      });
    }
    const content = /^\/files\/uploads\/([^/]+)\/content$/.exec(path);
    if (content && method === "PUT") {
      const upload = uploads.get(content[1]!);
      // A file called "slow" stays in flight long enough to be cancelled.
      if (upload?.name.startsWith("slow")) await new Promise((resolve) => setTimeout(resolve, 4_000));
      try {
        return await reply(route, 200, {
          id: content[1],
          name: upload?.name,
          mime: upload?.mime,
          size: upload?.size,
          status: "ready",
          processing_status: "pending",
          created_at: stamp,
          uploader_id: ownerID,
        });
      } catch {
        return; // aborted by the client
      }
    }
    if (/^\/files\/uploads\/[^/]+$/.test(path) && method === "DELETE") return reply(route, 204);

    if (!path.startsWith("/knowledge")) return route.fallback();

    if (path === "/knowledge/collections" && method === "GET") return reply(route, 200, collections);
    if (path === "/knowledge/collections" && method === "POST") {
      if (!manage) return reply(route, 403, { code: "forbidden", message: "forbidden" });
      const input = request.postDataJSON() as Partial<Collection>;
      const created: Collection = {
        id: nextID("00000000-0000-4000-8000-"),
        name: String(input.name),
        description: input.description ?? "",
        access: input.access ?? "organization",
        chat_ids: input.chat_ids ?? [],
        embedding_connection_id: input.embedding_connection_id ?? null,
        document_count: 0,
        semantic_search: input.embedding_connection_id === knowledgeIDs.connection,
        can_manage: true,
        created_by: ownerID,
        created_at: stamp,
        updated_at: stamp,
      };
      collections.push(created);
      documents[created.id] = [];
      return reply(route, 201, created);
    }
    const collectionMatch = /^\/knowledge\/collections\/([^/]+)$/.exec(path);
    if (collectionMatch) {
      const collection = collections.find((item) => item.id === collectionMatch[1]);
      if (!collection) return reply(route, 404, { code: "knowledge_not_found", message: "not found" });
      if (method === "GET") return reply(route, 200, collection);
      if (!manage) return reply(route, 403, { code: "forbidden", message: "forbidden" });
      if (method === "PATCH") {
        Object.assign(collection, request.postDataJSON());
        collection.semantic_search = collection.embedding_connection_id === knowledgeIDs.connection;
        return reply(route, 200, collection);
      }
      if (method === "DELETE") {
        collections.splice(collections.indexOf(collection), 1);
        return reply(route, 204);
      }
    }
    const documentsMatch = /^\/knowledge\/collections\/([^/]+)\/documents$/.exec(path);
    if (documentsMatch) {
      const collectionID = documentsMatch[1]!;
      const list = documents[collectionID] ?? [];
      if (method === "GET") {
        list.forEach(advance);
        return reply(route, 200, list.map(({ body: _body, ...rest }) => rest));
      }
      if (!manage) return reply(route, 403, { code: "forbidden", message: "forbidden" });
      const input = request.postDataJSON() as { kind: "file" | "page"; title?: string; file_id?: string; body?: string };
      const upload = input.file_id ? uploads.get(input.file_id) : undefined;
      const created = document({
        id: nextID("00000000-0000-4000-8000-"),
        collection_id: collectionID,
        kind: input.kind,
        title: input.title || upload?.name || "",
        body: input.body,
        file_id: input.file_id ?? null,
        file_name: upload?.name ?? null,
        file_mime: upload?.mime ?? null,
        file_size: upload?.size ?? null,
        status: "pending",
        embedding_status: "none",
        indexed_at: null,
        updated_at: new Date().toISOString(),
      });
      list.unshift(created);
      documents[collectionID] = list;
      refreshCount(collectionID);
      return reply(route, 201, created);
    }
    const fragmentsMatch = /^\/knowledge\/documents\/([^/]+)\/fragments$/.exec(path);
    if (fragmentsMatch)
      return reply(route, 200, { fragments: fragments[fragmentsMatch[1]!] ?? [], truncated: false });
    const fileMatch = /^\/knowledge\/documents\/([^/]+)\/file$/.exec(path);
    if (fileMatch)
      return route.fulfill({
        status: 200,
        contentType: "text/plain",
        body: "Инструктор;Слот\nИванова;09:00\n",
      });
    const documentMatch = /^\/knowledge\/documents\/([^/]+)$/.exec(path);
    if (documentMatch) {
      const item = allDocuments().find((value) => value.id === documentMatch[1]);
      if (!item) return reply(route, 404, { code: "knowledge_not_found", message: "not found" });
      if (method === "GET") {
        advance(item);
        return reply(route, 200, item);
      }
      if (!manage) return reply(route, 403, { code: "forbidden", message: "forbidden" });
      if (method === "PATCH") {
        const input = request.postDataJSON() as { title?: string; body?: string };
        if (input.title) item.title = input.title;
        if (input.body) {
          item.body = input.body;
          item.content_version += 1;
          item.status = "pending";
          pendingReads.delete(item.id);
        }
        return reply(route, 200, item);
      }
      if (method === "DELETE") {
        const list = documents[item.collection_id]!;
        list.splice(list.indexOf(item), 1);
        refreshCount(item.collection_id);
        return reply(route, 204);
      }
    }
    if (path === "/knowledge/embedding-connections")
      return manage
        ? reply(route, 200, [
            { id: knowledgeIDs.connection, name: "Локальная модель", provider: "openai-compatible", embedding_model: "embed-small", enabled: true, data_sharing_approved: true, available: true },
            { id: knowledgeIDs.blocked, name: "OpenAI", provider: "openai", embedding_model: "text-embedding-3-small", enabled: true, data_sharing_approved: false, available: false },
          ])
        : reply(route, 403, { code: "forbidden", message: "forbidden" });
    if (path === "/knowledge/search" && method === "POST") {
      const input = request.postDataJSON() as { query: string };
      const needle = input.query.toLocaleLowerCase().slice(0, 5);
      const hits = allDocuments().flatMap((item) => {
        const collection = collections.find((value) => value.id === item.collection_id);
        return (fragments[item.id] ?? [])
          .filter((fragment) => fragment.content.toLocaleLowerCase().includes(needle))
          .map((fragment) => ({
            ...fragment,
            collection_id: item.collection_id,
            collection_name: collection?.name ?? "",
            document_id: item.id,
            document_title: item.title,
            document_kind: item.kind,
            score: 0.5,
            match: "text",
          }));
      });
      return reply(route, 200, { fragments: hits, semantic: false });
    }
    return reply(route, 404, { code: "not_found", message: path });
  });

  return { requests, collections, documents, members };
}
