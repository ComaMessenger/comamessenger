/**
 * The line under a chat title, as in Telegram: what someone is doing right
 * now, else whether the direct peer is online or when they were last seen,
 * else how many members a group has and how many are online.
 *
 * Russian uses the gender-neutral "был(а) в сети …": the server does not know
 * a person's gender, and Telegram readers know this form. "В сети N минут
 * назад" reads like "online" at a glance and is easy to misread.
 *
 * Plural rules are written out here rather than taken from Intl.PluralRules,
 * which the mobile JS engine does not guarantee.
 */

export type TypingAction =
  | "typing"
  | "recording_voice"
  | "uploading_photo"
  | "uploading_video"
  | "uploading_file";

export const typingActions: readonly TypingAction[] = [
  "typing",
  "recording_voice",
  "uploading_photo",
  "uploading_video",
  "uploading_file",
];

export function isTypingAction(value: unknown): value is TypingAction {
  return typingActions.includes(value as TypingAction);
}

export type LastSeenApprox =
  | "recently"
  | "within_week"
  | "within_month"
  | "long_ago";

export type PresenceLocale = "ru" | "en";

export type AgentWorkState =
  | "thinking"
  | "tool"
  | "streaming"
  | "completed"
  | "failed"
  | "canceled";

type PluralForms = { one: string; few: string; many: string };

/** CLDR cardinal category for ru (one/few/many) and en (one/other→many). */
export function pluralCategory(
  count: number,
  locale: PresenceLocale,
): keyof PluralForms {
  const n = Math.abs(Math.trunc(count));
  if (locale === "en") return n === 1 ? "one" : "many";
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return "one";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "few";
  return "many";
}

function plural(count: number, locale: PresenceLocale, forms: PluralForms) {
  return forms[pluralCategory(count, locale)].replace("#", String(count));
}

const ruMonths = [
  "января",
  "февраля",
  "марта",
  "апреля",
  "мая",
  "июня",
  "июля",
  "августа",
  "сентября",
  "октября",
  "ноября",
  "декабря",
];
const enMonths = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function clock(date: Date, locale: PresenceLocale): string {
  const minutes = String(date.getMinutes()).padStart(2, "0");
  if (locale === "ru")
    return `${String(date.getHours()).padStart(2, "0")}:${minutes}`;
  const hours = date.getHours() % 12 || 12;
  return `${hours}:${minutes} ${date.getHours() < 12 ? "AM" : "PM"}`;
}

function startOfDay(date: Date): number {
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
  ).getTime();
}

/** "был(а) в сети 5 минут назад" / "last seen 5 minutes ago" and the like. */
export function formatLastSeen(
  at: Date,
  now: Date,
  locale: PresenceLocale,
): string {
  const ru = locale === "ru";
  const prefix = ru ? "был(а) в сети" : "last seen";
  const elapsed = Math.max(0, now.getTime() - at.getTime());
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return ru ? `${prefix} только что` : `${prefix} just now`;
  if (minutes < 60)
    return `${prefix} ${plural(
      minutes,
      locale,
      ru
        ? { one: "# минуту", few: "# минуты", many: "# минут" }
        : { one: "# minute", few: "# minutes", many: "# minutes" },
    )} ${ru ? "назад" : "ago"}`;
  const day = startOfDay(at);
  const today = startOfDay(now);
  const yesterday = startOfDay(
    new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1),
  );
  if (day === today)
    return `${prefix} ${ru ? "сегодня в" : "today at"} ${clock(at, locale)}`;
  if (day === yesterday)
    return `${prefix} ${ru ? "вчера в" : "yesterday at"} ${clock(at, locale)}`;
  const sameYear = at.getFullYear() === now.getFullYear();
  if (ru)
    return `${prefix} ${at.getDate()} ${ruMonths[at.getMonth()]}${sameYear ? "" : ` ${at.getFullYear()}`}`;
  return `${prefix} ${enMonths[at.getMonth()]} ${at.getDate()}${sameYear ? "" : `, ${at.getFullYear()}`}`;
}

export function formatLastSeenApprox(
  approx: LastSeenApprox,
  locale: PresenceLocale,
): string {
  const ru = {
    recently: "был(а) недавно",
    within_week: "был(а) на этой неделе",
    within_month: "был(а) в этом месяце",
    long_ago: "был(а) давно",
  };
  const en = {
    recently: "last seen recently",
    within_week: "last seen within a week",
    within_month: "last seen within a month",
    long_ago: "last seen a long time ago",
  };
  return (locale === "ru" ? ru : en)[approx];
}

const actionSolo: Record<PresenceLocale, Record<TypingAction, string>> = {
  ru: {
    typing: "печатает",
    recording_voice: "записывает голосовое",
    uploading_photo: "отправляет фото",
    uploading_video: "отправляет видео",
    uploading_file: "отправляет файл",
  },
  en: {
    typing: "typing",
    recording_voice: "recording voice",
    uploading_photo: "sending photo",
    uploading_video: "sending video",
    uploading_file: "sending file",
  },
};
const actionNamed: Record<PresenceLocale, Record<TypingAction, string>> = {
  ru: actionSolo.ru,
  en: {
    typing: "is typing",
    recording_voice: "is recording a voice message",
    uploading_photo: "is sending a photo",
    uploading_video: "is sending a video",
    uploading_file: "is sending a file",
  },
};
const actionPlural: Record<PresenceLocale, Record<TypingAction, string>> = {
  ru: {
    typing: "печатают",
    recording_voice: "записывают голосовые",
    uploading_photo: "отправляют фото",
    uploading_video: "отправляют видео",
    uploading_file: "отправляют файлы",
  },
  en: {
    typing: "are typing",
    recording_voice: "are recording voice messages",
    uploading_photo: "are sending photos",
    uploading_video: "are sending videos",
    uploading_file: "are sending files",
  },
};

export type ChatAction = {
  actorID: string;
  name: string;
  action: TypingAction;
};

/**
 * "печатает" in a direct chat; "Анна печатает", "Анна и Олег печатают",
 * "Несколько человек печатают" in a group. Without the trailing dots: the
 * interface animates them.
 */
export function formatChatActions(
  actions: readonly ChatAction[],
  options: { direct: boolean; locale: PresenceLocale },
): string {
  const { locale } = options;
  if (!actions.length) return "";
  const first = actions[0]!;
  if (options.direct && actions.length === 1)
    return actionSolo[locale][first.action];
  if (actions.length === 1)
    return `${first.name} ${actionNamed[locale][first.action]}`;
  const same = actions.every((item) => item.action === first.action);
  const verb = actionPlural[locale][same ? first.action : "typing"];
  if (actions.length === 2)
    return `${first.name} ${locale === "ru" ? "и" : "and"} ${actions[1]!.name} ${verb}`;
  return `${locale === "ru" ? "Несколько человек" : "Several people"} ${verb}`;
}

/** "5 участников, 2 в сети" / "5 members, 2 online". */
export function formatGroupMembers(
  members: number,
  online: number,
  locale: PresenceLocale,
  channel = false,
): string {
  const count = plural(
    members,
    locale,
    locale === "ru"
      ? channel
        ? { one: "# подписчик", few: "# подписчика", many: "# подписчиков" }
        : { one: "# участник", few: "# участника", many: "# участников" }
      : channel
        ? { one: "# subscriber", few: "# subscribers", many: "# subscribers" }
        : { one: "# member", few: "# members", many: "# members" },
  );
  if (online <= 0) return count;
  return `${count}, ${online} ${locale === "ru" ? "в сети" : "online"}`;
}

const agentStates: Record<PresenceLocale, Record<AgentWorkState, string>> = {
  ru: {
    thinking: "думает",
    tool: "выполняет действие",
    streaming: "пишет ответ",
    completed: "",
    failed: "не справился",
    canceled: "остановлен",
  },
  en: {
    thinking: "thinking",
    tool: "running a tool",
    streaming: "writing a reply",
    completed: "",
    failed: "failed",
    canceled: "stopped",
  },
};

export type ConversationStatus = {
  text: string;
  /** Someone is doing something: show animated dots and the accent color. */
  animated: boolean;
  /** Online or acting: accent color without dots. */
  live: boolean;
};

export type ConversationStatusInput = {
  locale: PresenceLocale;
  kind: "direct" | "group" | "channel";
  now: Date;
  /** Others' actions in this chat (not in threads), oldest first. */
  actions: readonly ChatAction[];
  /** Direct chats: the other side. */
  peer?: {
    type: "user" | "agent";
    presence?: "online" | "away" | "offline";
    /** Exact last seen: realtime frame first, then REST. */
    lastSeenAt?: string | null;
    lastSeenApprox?: LastSeenApprox | null;
    /** Seen online or away during this session (hidden time → "recently"). */
    seenThisSession?: boolean;
    /** Agents: the run state, when one is running. */
    agentState?: AgentWorkState | null;
  } | null;
  /** Groups and channels. */
  memberCount?: number;
  onlineCount?: number;
};

export function conversationStatus(
  input: ConversationStatusInput,
): ConversationStatus {
  const { locale, peer } = input;
  const direct = input.kind === "direct";
  if (peer?.type === "agent") {
    const label = locale === "ru" ? "агент" : "agent";
    const state = peer.agentState ? agentStates[locale][peer.agentState] : "";
    if (!state) return { text: label, animated: false, live: false };
    const working =
      peer.agentState === "thinking" ||
      peer.agentState === "tool" ||
      peer.agentState === "streaming";
    return { text: `${label} · ${state}`, animated: working, live: working };
  }
  if (input.actions.length)
    return {
      text: formatChatActions(input.actions, { direct, locale }),
      animated: true,
      live: true,
    };
  if (direct && peer) {
    if (peer.presence === "online")
      return {
        text: locale === "ru" ? "в сети" : "online",
        animated: false,
        live: true,
      };
    if (peer.lastSeenAt) {
      const at = new Date(peer.lastSeenAt);
      if (!Number.isNaN(at.getTime()))
        return {
          text: formatLastSeen(at, input.now, locale),
          animated: false,
          live: false,
        };
    }
    if (peer.lastSeenApprox)
      return {
        text: formatLastSeenApprox(
          peer.seenThisSession ? "recently" : peer.lastSeenApprox,
          locale,
        ),
        animated: false,
        live: false,
      };
    return { text: "", animated: false, live: false };
  }
  return {
    text: formatGroupMembers(
      input.memberCount ?? 0,
      input.onlineCount ?? 0,
      locale,
      input.kind === "channel",
    ),
    animated: false,
    live: false,
  };
}

type HeaderMember = {
  actor_id: string;
  type: "user" | "agent";
  display_name: string;
};
type HeaderPeer = HeaderMember & {
  last_seen_at?: string | null;
  last_seen_approx?: LastSeenApprox | null;
};

/**
 * Builds the header line for a chat from what the store knows: actions in
 * the chat itself (threads keep their own), presence frames, last seen from
 * frames and REST, agent run states.
 */
export function chatHeaderStatus(input: {
  locale: PresenceLocale;
  now: Date;
  viewerID: string;
  chat: {
    id: string;
    kind: "direct" | "group" | "channel";
    direct_peer?: HeaderPeer | null;
  };
  members: readonly HeaderMember[];
  actions:
    | Readonly<Record<string, { action: TypingAction; expiresAt: number }>>
    | undefined;
  presence: Readonly<Record<string, "online" | "away" | "offline">>;
  lastSeen: Readonly<Record<string, string>>;
  agentStatuses: readonly {
    actorID: string;
    chatID: string;
    threadRootID: string | null;
    state: AgentWorkState;
  }[];
}): ConversationStatus {
  const { chat, viewerID } = input;
  const nameOf = (actorID: string) =>
    input.members.find((member) => member.actor_id === actorID)?.display_name ??
    (chat.direct_peer?.actor_id === actorID
      ? chat.direct_peer.display_name
      : "");
  const actions: ChatAction[] = Object.entries(input.actions ?? {})
    .filter(
      ([actorID, item]) =>
        actorID !== viewerID && item.expiresAt > input.now.getTime(),
    )
    .map(([actorID, item]) => ({
      actorID,
      name: nameOf(actorID),
      action: item.action,
    }))
    .filter((item) => item.name);
  const peer = chat.kind === "direct" ? chat.direct_peer : null;
  if (peer) {
    const state = input.presence[peer.actor_id];
    const run = input.agentStatuses.find(
      (item) =>
        item.actorID === peer.actor_id &&
        item.chatID === chat.id &&
        item.threadRootID === null,
    );
    return conversationStatus({
      locale: input.locale,
      kind: "direct",
      now: input.now,
      actions,
      peer: {
        type: peer.type,
        presence: state,
        lastSeenAt: input.lastSeen[peer.actor_id] ?? peer.last_seen_at ?? null,
        lastSeenApprox: peer.last_seen_approx ?? null,
        seenThisSession: state !== undefined,
        agentState: run?.state ?? null,
      },
    });
  }
  const online = input.members.filter(
    (member) =>
      member.type === "user" &&
      (member.actor_id === viewerID ||
        input.presence[member.actor_id] === "online"),
  ).length;
  return conversationStatus({
    locale: input.locale,
    kind: chat.kind,
    now: input.now,
    actions,
    memberCount: input.members.length,
    // Alone online is not news: say so only when someone else is there too.
    onlineCount: online > 1 ? online : 0,
  });
}
