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
};

/**
 * Sections of the menu, separated by dividers: reply | important, remind,
 * pin, forward, views | links and text | edit | delete. Every member may
 * save a message and set a reminder about it for themselves, right after
 * saving as in the prototype; pinning is for chat owners and admins. Edit own
 * messages only, delete own or as a moderator.
 */
export function messageMenu(facts: MessageMenuFacts): MessageMenuAction[][] {
  const { own, persisted } = facts;
  const sections: MessageMenuAction[][] = [
    persisted ? ["reply", ...(facts.inThread ? [] : ["thread" as const])] : [],
    persisted
      ? [
          facts.saved ? "unsave" : "save",
          ...(facts.reminders ? ["remind" as const] : []),
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
    persisted && own && facts.hasText ? ["edit"] : [],
    persisted && (own || facts.canModerate) ? ["delete"] : [],
  ];
  return sections.filter((section) => section.length > 0);
}

/** Chat roles that may pin: the server's `chat.manage` action. */
export function canPinIn(chatRole: string | undefined) {
  return chatRole === "owner" || chatRole === "admin";
}

/** Translation key of the «remind» item: set one or change the one set. */
export function remindLabelKey(reminded: boolean | undefined): string {
  return reminded ? "messageEditReminder" : "messageRemindMe";
}
