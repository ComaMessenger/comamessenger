/** Items of the long-press menu of a message, in the web client's order. */
export type MessageMenuAction =
  | "reply"
  | "thread"
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
  /** The menu is opened inside a thread, where there is no thread to open. */
  inThread: boolean;
  /** The message has text to copy or edit. */
  hasText: boolean;
  /** The server has the message; unsent ones have no id to act on. */
  persisted: boolean;
};

/**
 * Sections of the menu, separated by dividers: reply | important, forward,
 * views | links and text | edit | delete. Rights match the web client and
 * the server: edit own messages only, delete own or as a moderator.
 */
export function messageMenu(facts: MessageMenuFacts): MessageMenuAction[][] {
  const { own, persisted } = facts;
  const sections: MessageMenuAction[][] = [
    persisted ? ["reply", ...(facts.inThread ? [] : ["thread" as const])] : [],
    persisted
      ? [
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
