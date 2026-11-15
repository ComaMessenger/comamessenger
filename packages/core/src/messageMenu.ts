/**
 * Items of a message's menu, shared by the web client and the phone so both
 * keep the same order and the same rights.
 */
export type MessageMenuAction =
  | "reply"
  | "thread"
  | "save"
  | "unsave"
  /** «Напомнить мне», or «Изменить напоминание» when one is set. */
  | "remind"
  /** «Сделать задачей»: the task form with the title from the text. */
  | "makeTask"
  | "pin"
  | "unpin"
  | "forward"
  | "details"
  | "copyLink"
  | "copyText"
  | "edit"
  | "delete";

export type MessageMenuFacts = {
  /** The reader wrote the message. */
  own: boolean;
  /** Moderates the chat: may delete anyone's message. */
  canModerate: boolean;
  /** Owner or admin of the chat: may pin (the server checks `chat.manage`). */
  canPin: boolean;
  pinned: boolean;
  /** The reader saved the message to their own «Important». */
  saved: boolean;
  /** The menu is opened inside a thread, where there is no thread to open. */
  inThread: boolean;
  /** The message has text to copy or edit. */
  hasText: boolean;
  /** The server has the message; unsent ones have no id to act on. */
  persisted: boolean;
  /**
   * The server has personal reminders (`message_reminders` in hello).
   * Absent means no: older callers keep their menu.
   */
  reminders?: boolean;
  /** The reader has a reminder about this message: the item reads «Изменить напоминание». */
  reminded?: boolean;
  /**
   * The server has tasks (`message_tasks` in hello) and the reader may
   * post in the chat. Absent means no.
   */
  tasks?: boolean;
  /** Message.type; only plain text messages become tasks. Absent means text. */
  messageType?: string;
};

/**
 * Sections of the menu, separated by dividers: reply | important, remind,
 * pin, forward, views | links and text | edit | delete. Every member may
 * save a message and set a reminder about it for themselves, right after
 * saving as in the prototype, then «Сделать задачей»; pinning is for chat
 * owners and admins. Edit own messages only, delete own or as a moderator.
 */
export function messageMenu(facts: MessageMenuFacts): MessageMenuAction[][] {
  const { own, persisted } = facts;
  const sections: MessageMenuAction[][] = [
    persisted ? ["reply", ...(facts.inThread ? [] : ["thread" as const])] : [],
    persisted
      ? [
          facts.saved ? "unsave" : "save",
          ...(facts.reminders ? ["remind" as const] : []),
          ...(canMakeTask(facts) ? ["makeTask" as const] : []),
          ...(facts.canPin
            ? [facts.pinned ? ("unpin" as const) : ("pin" as const)]
            : []),
          "forward",
          "details",
        ]
      : [],
    [
      ...(persisted ? ["copyLink" as const] : []),
      ...(facts.hasText ? ["copyText" as const] : []),
    ],
    // A task is changed on its own screen («⋯ → Изменить»), not as text.
    persisted && own && facts.hasText && facts.messageType !== "task"
      ? ["edit"]
      : [],
    persisted && (own || facts.canModerate) ? ["delete"] : [],
  ];
  return sections.filter((section) => section.length > 0);
}

/**
 * «Сделать задачей»: a text message the server has, not a task, request or
 * poll, with tasks on the server and the right to post. In a thread too:
 * the task goes to the chat's feed with a link to its source.
 */
export function canMakeTask(
  facts: Pick<
    MessageMenuFacts,
    "tasks" | "persisted" | "hasText" | "messageType"
  >,
): boolean {
  return Boolean(
    facts.tasks &&
      facts.persisted &&
      facts.hasText &&
      (facts.messageType ?? "text") === "text",
  );
}

/** Chat roles that may pin: the server's `chat.manage` action. */
export function canPinIn(chatRole: string | undefined) {
  return chatRole === "owner" || chatRole === "admin";
}

/** Translation key of the «remind» item: set one or change the one set. */
export function remindLabelKey(reminded: boolean | undefined): string {
  return reminded ? "messageEditReminder" : "messageRemindMe";
}
