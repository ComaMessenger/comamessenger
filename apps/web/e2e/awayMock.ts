import type { Page } from "@playwright/test";

/*
 * «Отсутствую» (phase 6.7 wave 4) in memory: getAway / setAway / clearAway,
 * away in people objects, presence=away|here in the directory, the
 * substitutes list and the auto-reply of a direct chat (once per sender
 * and period). The live server is checked by live/away-live.spec.ts.
 */

// Wednesday 11 November 2026, 10:15 in Moscow.
export const now = new Date("2026-11-11T10:15:00+03:00");

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

type Person = {
  actor_id: string;
  display_name: string;
  handle: string;
  title: string;
};

export const people = {
  anna: {
    actor_id: id(1),
    display_name: "Анна Иванова",
    handle: "anna",
    title: "Инструктор ЛФК",
  },
  oleg: {
    actor_id: id(2),
    display_name: "Олег Чернов",
    handle: "oleg",
    title: "Инструктор ЛФК",
  },
  marina: {
    actor_id: id(3),
    display_name: "Марина Соколова",
    handle: "marina",
    title: "Администратор",
  },
  igor: {
    actor_id: id(4),
    display_name: "Игорь Лаптев",
    handle: "igor",
    title: "Старший инструктор",
  },
} satisfies Record<string, Person>;
export type PersonKey = keyof typeof people;

export const chats = {
  /** Олег ↔ Анна. */
  annaDirect: id(20),
  /** Олег ↔ Марина: the slot «Вместо Анны — …» opens it. */
  marinaDirect: id(21),
  group: id(22),
};

export type AwayRecord = {
  kind: "vacation" | "appointment" | "trip" | "dnd" | "other";
  label: string;
  starts_at: string;
  ends_at: string;
  autoreply: { enabled: boolean; text: string };
  substitute_id: string | null;
  mute_push: boolean;
  version: number;
};

/** Anna on vacation from yesterday until 30 November, Marina instead. */
export function annaVacation(): AwayRecord {
  return {
    kind: "vacation",
    label: "",
    starts_at: "2026-11-09T21:00:00Z",
    ends_at: "2026-11-30T21:00:00Z",
    autoreply: {
      enabled: true,
      text: "Я в отпуске до 30 ноября. По срочным вопросам — к Марине Соколовой.",
    },
    substitute_id: people.marina.actor_id,
    mute_push: true,
    version: 2,
  };
}

type MessageRecord = {
  id: string;
  chat_id: string;
  actor_id: string;
  client_msg_id: string;
  body: string;
  created_seq: number;
  created_at: string;
  auto_reply?: boolean;
};

export async function mockAway(
  page: Page,
  options: {
    theme?: "light" | "dark";
    me?: PersonKey;
    /** Away records by person. */
    away?: Partial<Record<PersonKey, AwayRecord>>;
    features?: string[];
  } = {},
) {
  const theme = options.theme ?? "light";
  const meKey = options.me ?? "oleg";
  const me = people[meKey];
  const features = options.features ?? ["actor_away"];
  const away: Partial<Record<string, AwayRecord>> = {};
  for (const [key, value] of Object.entries(options.away ?? {}))
    away[people[key as PersonKey].actor_id] = value;
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const messages: MessageRecord[] = [
    {
      id: id(40),
      chat_id: chats.annaDirect,
      actor_id: people.anna.actor_id,
      client_msg_id: id(140),
      body: "Пришлю расписание вечером.",
      created_seq: 1,
      created_at: "2026-11-09T15:20:00Z",
    },
    {
      id: id(41),
      chat_id: chats.group,
      actor_id: people.igor.actor_id,
      client_msg_id: id(141),
      body: "Кто в среду подменит в бассейне?",
      created_seq: 2,
      created_at: "2026-11-11T06:40:00Z",
    },
  ];
  const autoreplied = new Set<string>();
  let seq = 10;
  let nextID = 300;

  const isActive = (record: AwayRecord | undefined) =>
    Boolean(
      record &&
        Date.parse(record.starts_at) <= now.getTime() &&
        now.getTime() < Date.parse(record.ends_at),
    );
  const awayPublic = (actorID: string) => {
    const record = away[actorID];
    if (!record) return null;
    const substitute = record.substitute_id;
    return {
      kind: record.kind,
      label: record.label,
      starts_at: record.starts_at,
      ends_at: record.ends_at,
      active: isActive(record),
      substitute_id:
        substitute && !isActive(away[substitute]) ? substitute : null,
      notifications_off: record.mute_push,
    };
  };
  const awayStatus = (actorID: string) => {
    const record = away[actorID]!;
    return {
      ...awayPublic(actorID)!,
      autoreply: record.autoreply,
      substitute_id: record.substitute_id,
      mute_push: record.mute_push,
      version: record.version,
    };
  };
  const statusOf = (actorID: string) => {
    const record = away[actorID];
    if (!record || !isActive(record)) return { emoji: "", text: "" };
    return {
      emoji: { vacation: "🌴", appointment: "🩺", trip: "🚗", dnd: "🔕", other: "⏸" }[
        record.kind
      ],
      text: "В отпуске до 30 ноября",
    };
  };
  const actor = (person: Person) => {
    const status = statusOf(person.actor_id);
    return {
      actor_id: person.actor_id,
      display_name: person.display_name,
      handle: person.handle,
      title: person.title,
      about: "",
      type: "user" as const,
      role: "member",
      joined_at: "2026-08-19T00:00:00Z",
      status_emoji: status.emoji,
      status_text: status.text,
      status_expires_at: null,
      avatar_version: 0,
      away: awayPublic(person.actor_id),
    };
  };
  const user = () => ({
    id: me.actor_id,
    org_id: id(10),
    organization_name: "Реабцентр «Опора»",
    role: "member",
    email: `${me.handle}@example.com`,
    display_name: me.display_name,
    handle: me.handle,
    title: me.title,
    about: "",
    timezone: "Europe/Moscow",
    status: "active",
    must_change_password: false,
    can_create_invitations: false,
    status_emoji: "",
    status_text: "",
    status_expires_at: null,
    created_at: "2026-08-19T00:00:00Z",
    permissions: [],
    away: awayPublic(me.actor_id),
  });
  const base = {
    visibility: "private",
    topic: "",
    role: "member",
    created_at: "2026-08-19T00:00:00Z",
    notify_level: "default",
    muted_until: null,
    last_activity_seq: 1,
    last_message_at: "2026-11-11T06:40:00Z",
    last_message: null,
    avatar_version: 0,
  };
  const direct = (chatID: string, peer: Person) => ({
    ...base,
    id: chatID,
    kind: "direct",
    name: null,
    display_name: peer.display_name,
    avatar_seed: peer.actor_id,
    direct_peer: actor(peer),
  });
  const chatList = () => {
    const list: unknown[] = [
      {
        ...base,
        id: chats.group,
        kind: "group",
        name: "Инструкторы · зал",
        display_name: "Инструкторы · зал",
        avatar_seed: "hall",
      },
    ];
    if (meKey === "oleg")
      list.unshift(
        direct(chats.annaDirect, people.anna),
        direct(chats.marinaDirect, people.marina),
      );
    return list;
  };
  const membersOf = (chatID: string) =>
    chatID === chats.annaDirect
      ? [people.oleg, people.anna]
      : chatID === chats.marinaDirect
        ? [people.oleg, people.marina]
        : [people.anna, people.oleg, people.marina, people.igor];
  const messageOf = (record: MessageRecord) => ({
    id: record.id,
    chat_id: record.chat_id,
    actor_id: record.actor_id,
    client_msg_id: record.client_msg_id,
    type: "text",
    body: record.body,
    body_format: "markdown",
    version: 1,
    created_seq: record.created_seq,
    created_at: record.created_at,
    mentioned_actor_ids: [],
    files: [],
    thread_reply_count: 0,
    ...(record.auto_reply ? { auto_reply: true } : {}),
  });
  /** Auto-replies made by the last send, for the test to deliver by event. */
  const pendingEvents: unknown[] = [];

  await page.clock.setFixedTime(now);
  await page.addInitScript(
    ({ theme: value, features: list }) => {
      localStorage.setItem("coma-locale", "ru");
      localStorage.setItem("coma-theme", value);
      class FakeSocket {
        static OPEN = 1;
        static latest: FakeSocket | null = null;
        readyState = 1;
        onopen: null | (() => void) = null;
        onmessage: null | ((event: { data: string }) => void) = null;
        onclose: null | ((event: { code: number }) => void) = null;
        constructor() {
          FakeSocket.latest = this;
          setTimeout(() => this.onopen?.(), 0);
        }
        send(raw: string) {
          const frame = JSON.parse(raw);
          if (frame.op === "auth")
            setTimeout(
              () =>
                this.onmessage?.({
                  data: JSON.stringify({
                    op: "hello",
                    request_id: frame.request_id,
                    connection_id: "00000000-0000-4000-8000-000000000099",
                    current_seq: 0,
                    min_retained_seq: 0,
                    heartbeat_interval_ms: 25000,
                    ack_interval_ms: 1000,
                    ack_batch_size: 50,
                    max_unacked_events: 128,
                    features: list,
                  }),
                }),
              0,
            );
        }
        close() {}
      }
      Object.assign(window, {
        WebSocket: FakeSocket,
        __emitComaEvent: (frame: unknown) =>
          FakeSocket.latest?.onmessage?.({ data: JSON.stringify(frame) }),
      });
    },
    { theme, features },
  );

  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace(/^\/api\/v1/, "");
    const method = request.method();
    const input = (() => {
      try {
        return request.postDataJSON() as Record<string, unknown>;
      } catch {
        return null;
      }
    })();
    if (/away|substituting|actors|status|messages/.test(path))
      calls.push({ method, path: `${path}${url.search}`, body: input });
    let status = 200;
    let body: unknown = {};
    if (path === "/bootstrap/status") body = { bootstrapped: true };
    else if (path === "/branding")
      body = {
        workspace_name: "Реабцентр «Опора»",
        accent_color: "#174586",
        version: 1,
        password_recovery_available: false,
        email_delivery_available: false,
      };
    else if (path === "/auth/refresh")
      body = {
        access_token: "test",
        access_expires_at: "2026-11-12T00:00:00Z",
        user: user(),
      };
    else if (path === "/me") body = user();
    else if (path === "/preferences")
      body = {
        theme,
        locale: "ru",
        in_app_enabled: true,
        push_enabled: false,
        push_preview: false,
        notify_messages: "all",
        notify_threads: "all",
        notify_reactions: true,
        notify_invites: true,
        notify_system: true,
        sound_enabled: false,
        sound_id: "default",
        schedule: null,
        snoozed_until: null,
        email_digest: false,
      };
    else if (
      path === "/preferences/chat-folders" ||
      path === "/preferences/pinned-chats"
    )
      body = [];
    else if (path === "/chats") body = { chats: chatList() };
    else if (path === "/unread") body = { chats: [], threads: [] };
    else if (path === "/drafts") body = { drafts: [] };
    else if (path === "/agents") body = [];
    else if (path === "/scheduled-messages") body = { scheduled_messages: [] };
    else if (path === "/actors") {
      const presence = url.searchParams.get("presence");
      const list = Object.values(people)
        .map(actor)
        .filter((item) =>
          presence === "away"
            ? isActive(away[item.actor_id])
            : presence === "here"
              ? !isActive(away[item.actor_id])
              : true,
        );
      body = { actors: list, next_after_id: null };
    } else if (path === "/me/away") {
      if (!features.includes("actor_away")) {
        status = 501;
        body = { error: { code: "not_implemented", message: "" } };
      } else if (method === "GET") {
        if (away[me.actor_id]) body = awayStatus(me.actor_id);
        else {
          await route.fulfill({ status: 204, body: "" });
          return;
        }
      } else if (method === "PUT") {
        const previous = away[me.actor_id];
        away[me.actor_id] = {
          kind: input!.kind as AwayRecord["kind"],
          label: (input!.label as string) ?? "",
          starts_at: (input!.starts_at as string) ?? now.toISOString(),
          ends_at: input!.ends_at as string,
          autoreply: input!.autoreply as AwayRecord["autoreply"],
          substitute_id: (input!.substitute_id as string | null) ?? null,
          mute_push: Boolean(input!.mute_push),
          version: (previous?.version ?? 0) + 1,
        };
        body = awayStatus(me.actor_id);
      } else if (method === "DELETE") {
        delete away[me.actor_id];
        await route.fulfill({ status: 204, body: "" });
        return;
      }
    } else if (path === "/me/substituting")
      body = {
        items: Object.entries(away)
          .filter(([, record]) => record?.substitute_id === me.actor_id)
          .map(([actorID]) => ({
            actor_id: actorID,
            away: awayPublic(actorID),
          })),
      };
    else if (/^\/chats\/[^/]+\/members$/.test(path))
      body = { members: membersOf(path.split("/")[2]!).map(actor) };
    else if (/^\/chats\/[^/]+\/pins$/.test(path)) body = { pins: [] };
    else if (/^\/chats\/[^/]+\/agents$/.test(path)) body = { agents: [] };
    else if (/^\/chats\/[^/]+\/read$/.test(path))
      body = {
        chat_id: path.split("/")[2],
        last_read_seq: seq,
        last_read_at: now.toISOString(),
      };
    else if (/^\/chats\/[^/]+\/messages$/.test(path)) {
      const chatID = path.split("/")[2]!;
      if (method === "POST") {
        seq += 1;
        const record: MessageRecord = {
          id: id(nextID++),
          chat_id: chatID,
          actor_id: me.actor_id,
          client_msg_id: input!.client_msg_id as string,
          body: input!.body as string,
          created_seq: seq,
          created_at: now.toISOString(),
        };
        messages.push(record);
        body = messageOf(record);
        // The peer of a direct chat is away with an auto-reply: once per sender.
        const peer = membersOf(chatID).find(
          (item) => item.actor_id !== me.actor_id,
        );
        const record2 = peer ? away[peer.actor_id] : undefined;
        if (
          chatID !== chats.group &&
          peer &&
          isActive(record2) &&
          record2!.autoreply.enabled &&
          !autoreplied.has(`${peer.actor_id}:${me.actor_id}`)
        ) {
          autoreplied.add(`${peer.actor_id}:${me.actor_id}`);
          seq += 1;
          const reply: MessageRecord = {
            id: id(nextID++),
            chat_id: chatID,
            actor_id: peer.actor_id,
            client_msg_id: id(nextID++),
            body: record2!.autoreply.text,
            created_seq: seq,
            created_at: now.toISOString(),
            auto_reply: true,
          };
          messages.push(reply);
          pendingEvents.push({
            op: "event",
            seq,
            type: "message.created",
            occurred_at: now.toISOString(),
            actor_id: peer.actor_id,
            chat_id: chatID,
            subject_id: reply.id,
            data: messageOf(reply),
          });
        }
      } else
        body = {
          messages: messages
            .filter((item) => item.chat_id === chatID)
            .map(messageOf),
          next_before_seq: null,
        };
    } else if (/^\/messages\/[^/]+\/reactions$/.test(path))
      body = { reactions: [] };
    else if (path.startsWith("/saved-messages/ids")) body = { message_ids: [] };
    else if (path === "/saved-messages/chats") body = { chats: [] };
    else if (path.startsWith("/saved-messages"))
      body = { items: [], next_cursor: null };
    else if (path.startsWith("/reminders")) body = { reminders: [], next_cursor: null };
    else status = 404;
    await route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });

  return {
    calls,
    away,
    /** Delivers the auto-replies the last sends made, as the server would. */
    async deliver() {
      const frames = pendingEvents.splice(0);
      for (const frame of frames)
        await page.evaluate(
          (value) =>
            (
              window as unknown as { __emitComaEvent(frame: unknown): void }
            ).__emitComaEvent(value),
          frame,
        );
      return frames.length;
    },
    /** A realtime frame as the server sends it. */
    async emit(frame: unknown) {
      await page.evaluate(
        (value) =>
          (
            window as unknown as { __emitComaEvent(frame: unknown): void }
          ).__emitComaEvent(value),
        frame,
      );
    },
  };
}
