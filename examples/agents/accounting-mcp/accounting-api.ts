// A fictional accounting system ("Учёт") with an HTTP API. It stands in for
// 1C or any other system where a centre keeps its slot schedule. All data
// is invented.
import { createServer, type IncomingMessage, type Server } from "node:http";

export type Slot = {
  id: string;
  date: string;
  start: string;
  end: string;
  room: string;
  instructor_id: string | null;
};

export type Instructor = { id: string; name: string };

export type AccountingData = { slots: Slot[]; instructors: Instructor[] };

export function sampleData(): AccountingData {
  return {
    instructors: [
      { id: "i-1", name: "Анна Иванова" },
      { id: "i-2", name: "Пётр Петров" },
      { id: "i-3", name: "Мария Смирнова" },
    ],
    slots: [
      {
        id: "s-1",
        date: "2026-11-12",
        start: "09:00",
        end: "10:00",
        room: "Зал 1",
        instructor_id: "i-1",
      },
      {
        id: "s-2",
        date: "2026-11-12",
        start: "10:00",
        end: "11:00",
        room: "Зал 1",
        instructor_id: null,
      },
      {
        id: "s-3",
        date: "2026-11-12",
        start: "11:00",
        end: "12:00",
        room: "Зал 2",
        instructor_id: "i-2",
      },
      {
        id: "s-4",
        date: "2026-11-13",
        start: "09:00",
        end: "10:00",
        room: "Зал 1",
        instructor_id: null,
      },
    ],
  };
}

/** Starts the fictional accounting API. Every request needs the token. */
export function startAccountingAPI(
  token: string,
  port = 0,
  data: AccountingData = sampleData(),
): Promise<{ server: Server; url: string; data: AccountingData }> {
  const server = createServer(async (request, response) => {
    const send = (status: number, body: unknown) => {
      response.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
      });
      response.end(JSON.stringify(body));
    };
    if (request.headers.authorization !== `Bearer ${token}`) {
      send(401, { error: "unauthorized" });
      return;
    }
    const url = new URL(request.url ?? "/", "http://accounting.local");
    if (request.method === "GET" && url.pathname === "/api/slots") {
      const date = url.searchParams.get("date") ?? "";
      send(200, { slots: data.slots.filter((slot) => slot.date === date) });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/instructors") {
      send(200, { instructors: data.instructors });
      return;
    }
    const assign = url.pathname.match(/^\/api\/slots\/([\w-]+)\/assign$/);
    if (request.method === "POST" && assign) {
      const body = (await readJSON(request)) as { instructor_id?: unknown };
      const slot = data.slots.find((item) => item.id === assign[1]);
      const instructor = data.instructors.find(
        (item) => item.id === body.instructor_id,
      );
      if (!slot || !instructor) {
        send(404, { error: "not_found" });
        return;
      }
      if (slot.instructor_id) {
        send(409, { error: "slot_taken", slot });
        return;
      }
      slot.instructor_id = instructor.id;
      send(200, { slot });
      return;
    }
    send(404, { error: "not_found" });
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      const actual =
        typeof address === "object" && address ? address.port : port;
      resolve({ server, url: `http://127.0.0.1:${actual}`, data });
    });
  });
}

export async function readJSON(
  request: IncomingMessage,
  limit = 64 * 1024,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}
