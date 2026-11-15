/*
 * Polls («Опрос») of phase 6.7 wave 4 in memory, for workplaceMock: the
 * card's rules as the server keeps them — counts only for those who may see
 * results, an anonymous vote final and never tied to a person, «Кто
 * голосовал», remind and close. The live server is checked by
 * live/polls-live.spec.ts.
 */

export type PollRecord = {
  id: string;
  chat_id: string;
  author: string;
  question: string;
  options: string[];
  multiple: boolean;
  anonymous: boolean;
  due_at: string | null;
  status: "open" | "closed";
  closed_reason: "author" | "moderator" | "expired" | null;
  closed_at: string | null;
  /** Ordinary polls: who chose what. Anonymous: only who voted (empty choice). */
  votes: Record<string, number[]>;
  /** Anonymous polls keep only the counts. */
  counts: number[];
  version: number;
  created_seq: number;
  created_at: string;
  edited_at?: string;
  next_remind_at: string | null;
  reminds: number;
  client_msg_id?: string;
};

type Fail = { status: number; body: unknown };
const fail = (status: number, code: string): Fail => ({
  status,
  body: { error: { code, message: code, details: {} } },
});

export function createPollServer(options: {
  polls: PollRecord[];
  me: string;
  /** People of a chat now, without agents. */
  peopleOf(chatID: string): string[];
  nowISO: string;
  nextID(): string;
  nextSeq(): number;
  chatRef(chatID: string): unknown;
  authorOf(actorID: string): unknown;
}) {
  const { polls, me, nowISO } = options;
  const memberCount = (r: PollRecord) => {
    const people = new Set(options.peopleOf(r.chat_id));
    for (const voter of Object.keys(r.votes)) people.add(voter);
    return people.size;
  };
  const countsOf = (r: PollRecord) => {
    if (r.anonymous) return [...r.counts];
    const counts = r.options.map(() => 0);
    for (const choice of Object.values(r.votes))
      for (const index of choice) counts[index]! += 1;
    return counts;
  };
  const pollOf = (r: PollRecord) => ({
    question: r.question,
    options: r.options,
    multiple: r.multiple,
    anonymous: r.anonymous,
    due_at: r.due_at,
    status: r.status,
    closed_reason: r.closed_reason,
    closed_at: r.closed_at,
    voter_count: Object.keys(r.votes).length,
    member_count: memberCount(r),
    final_counts: r.status === "closed" ? countsOf(r) : null,
    version: r.version,
  });
  const viewerOf = (r: PollRecord) => {
    const open = r.status === "open";
    const voted = me in r.votes;
    const isAuthor = r.author === me;
    const results = voted || isAuthor || !open;
    const remindReady =
      isAuthor &&
      open &&
      r.reminds < 5 &&
      (!r.next_remind_at || Date.parse(r.next_remind_at) <= Date.parse(nowISO));
    return {
      voted,
      my_options: r.anonymous ? null : voted ? r.votes[me]! : null,
      can_vote: open && (!r.anonymous || !voted),
      can_change: open && !r.anonymous && voted,
      can_view_results: results,
      can_view_voters: results && !r.anonymous,
      can_view_waiting: isAuthor && !r.anonymous,
      can_close: open && isAuthor,
      can_remind: remindReady,
      next_remind_at: r.next_remind_at,
      counts: results ? countsOf(r) : null,
    };
  };
  const body = (r: PollRecord) =>
    `Опрос: ${r.question}\n\n${r.options.map((o) => `— ${o}`).join("\n")}`;
  const messageOf = (r: PollRecord) => ({
    id: r.id,
    chat_id: r.chat_id,
    actor_id: r.author,
    client_msg_id: r.client_msg_id ?? r.id.replace("4000-8000", "4000-9000"),
    type: "poll",
    body: body(r),
    body_format: "plain",
    version: 1,
    created_seq: r.created_seq,
    created_at: r.created_at,
    ...(r.edited_at ? { edited_at: r.edited_at } : {}),
    mentioned_actor_ids: [],
    files: [],
    thread_reply_count: 0,
    poll: pollOf(r),
    poll_viewer: viewerOf(r),
  });
  const state = (r: PollRecord) => ({ poll: pollOf(r), viewer: viewerOf(r) });
  const waitingForMe = () =>
    polls.filter(
      (r) =>
        r.status === "open" &&
        r.due_at &&
        !(me in r.votes) &&
        options.peopleOf(r.chat_id).includes(me),
    );
  const hot = (r: PollRecord) =>
    Boolean(r.due_at) &&
    Date.parse(r.due_at!) - Date.parse(nowISO) < 24 * 60 * 60_000;

  function route(
    method: string,
    path: string,
    url: URL,
    input: { [key: string]: unknown } | null,
  ): Fail | null {
    const create = /^\/chats\/([^/]+)\/polls$/.exec(path);
    if (create && method === "POST") {
      const replay = polls.find(
        (r) => r.client_msg_id && r.client_msg_id === input?.client_msg_id,
      );
      if (replay) return { status: 201, body: messageOf(replay) };
      const list = (input?.options as string[]) ?? [];
      const record: PollRecord = {
        id: options.nextID(),
        chat_id: create[1]!,
        author: me,
        question: String(input?.question ?? ""),
        options: list,
        multiple: Boolean(input?.multiple),
        anonymous: Boolean(input?.anonymous),
        due_at: (input?.due_at as string) ?? null,
        status: "open",
        closed_reason: null,
        closed_at: null,
        votes: {},
        counts: list.map(() => 0),
        version: 1,
        created_seq: options.nextSeq(),
        created_at: nowISO,
        next_remind_at: null,
        reminds: 0,
      };
      record.client_msg_id = String(input?.client_msg_id ?? "");
      polls.push(record);
      return { status: 201, body: messageOf(record) };
    }
    const match =
      /^\/polls\/([^/]+)(?:\/(vote|voters|remind|close))?$/.exec(path);
    if (!match) return null;
    const r = polls.find((entry) => entry.id === match[1]);
    if (!r) return fail(404, "poll_not_found");
    const action = match[2];
    if (!action && method === "GET") return { status: 200, body: state(r) };
    if (!action && method === "PATCH") {
      if (r.author !== me) return fail(403, "forbidden");
      if (r.status !== "open") return fail(409, "poll_closed");
      if (input?.expected_version !== r.version)
        return fail(409, "version_conflict");
      r.question = String(input?.question ?? r.question);
      r.edited_at = nowISO;
      r.version += 1;
      return { status: 200, body: messageOf(r) };
    }
    if (action === "vote" && method === "PUT") {
      if (r.status !== "open") return fail(409, "poll_closed");
      const choice = [...new Set((input?.options as number[]) ?? [])].sort();
      if (!choice.length || (!r.multiple && choice.length !== 1))
        return fail(422, "poll_invalid");
      if (r.anonymous) {
        if (me in r.votes) return fail(409, "poll_vote_final");
        r.votes[me] = [];
        for (const index of choice) r.counts[index]! += 1;
      } else r.votes[me] = choice;
      r.version += 1;
      return { status: 200, body: state(r) };
    }
    if (action === "vote" && method === "DELETE") {
      if (r.anonymous) return fail(409, "poll_vote_final");
      if (r.status !== "open") return fail(409, "poll_closed");
      if (me in r.votes) {
        delete r.votes[me];
        r.version += 1;
      }
      return { status: 204, body: undefined };
    }
    if (action === "voters") {
      if (r.anonymous) return fail(403, "forbidden");
      const filter = url.searchParams.get("filter") ?? "";
      const limit = Number(url.searchParams.get("limit") ?? 50);
      const viewer = viewerOf(r);
      if (filter === "waiting") {
        if (!viewer.can_view_waiting) return fail(403, "forbidden");
        const items = options
          .peopleOf(r.chat_id)
          .filter((actor) => !(actor in r.votes))
          .map((actor) => ({ actor_id: actor, voted_at: null, in_chat: true }));
        return { status: 200, body: { items, next_cursor: null } };
      }
      if (!viewer.can_view_voters) return fail(403, "forbidden");
      const option = Number(filter.replace("option:", ""));
      const items = Object.entries(r.votes)
        .filter(([, choice]) => choice.includes(option))
        .slice(0, limit)
        .map(([actor]) => ({
          actor_id: actor,
          voted_at: r.created_at,
          in_chat: options.peopleOf(r.chat_id).includes(actor),
        }));
      return { status: 200, body: { items, next_cursor: null } };
    }
    if (action === "remind") {
      if (r.author !== me) return fail(403, "forbidden");
      if (!viewerOf(r).can_remind) return fail(429, "poll_remind_too_soon");
      r.reminds += 1;
      r.next_remind_at = new Date(
        Date.parse(nowISO) + 2 * 60 * 60_000,
      ).toISOString();
      const reminded = options
        .peopleOf(r.chat_id)
        .filter((actor) => !(actor in r.votes) && actor !== me).length;
      return { status: 200, body: { reminded, next_remind_at: r.next_remind_at } };
    }
    if (action === "close") {
      if (!viewerOf(r).can_close && r.status === "open")
        return fail(403, "forbidden");
      if (r.status === "open") {
        r.status = "closed";
        r.closed_reason = "author";
        r.closed_at = nowISO;
        r.version += 1;
      }
      return { status: 200, body: state(r) };
    }
    return fail(404, "not_found");
  }

  return {
    messageOf,
    route,
    waitingItems: () =>
      waitingForMe().map((r) => ({
        kind: "poll",
        message: messageOf(r),
        chat_id: r.chat_id,
        author: options.authorOf(r.author),
        chat: options.chatRef(r.chat_id),
        due_at: r.due_at,
        request: null,
        viewer: null,
        my_role: null,
      })),
    unread: () => ({
      polls_waiting_total: waitingForMe().length,
      polls_hot_total: waitingForMe().filter(hot).length,
    }),
    chatUnread: (chatID: string) => ({
      polls_waiting: waitingForMe().filter((r) => r.chat_id === chatID).length,
    }),
    /** Someone else votes: what the server would do, without a frame. */
    voteAs(pollID: string, actorID: string, choice: number[]) {
      const r = polls.find((entry) => entry.id === pollID)!;
      if (r.anonymous) {
        r.votes[actorID] = [];
        for (const index of choice) r.counts[index]! += 1;
      } else r.votes[actorID] = choice;
      r.version += 1;
      return pollOf(r);
    },
    pollOf,
  };
}
