import type { ClientMessage } from "./types";

export type FeedRow = {
  message: ClientMessage;
  /** First message of a calendar day: render a day separator above it. */
  newDay: boolean;
  /** First message after the read boundary the chat was opened with. */
  firstUnread: boolean;
  /** Same author within five minutes: render without avatar and name. */
  grouped: boolean;
};

const groupWindowMs = 5 * 60_000;

/** Layout facts of a chronological message feed, shared by every client. */
export function feedRows(
  messages: ClientMessage[],
  unreadAnchor: number,
): FeedRow[] {
  return messages.map((message, index) => {
    const previous = messages[index - 1];
    const newDay =
      !previous ||
      new Date(previous.created_at).toDateString() !==
        new Date(message.created_at).toDateString();
    const firstUnread =
      unreadAnchor > 0 &&
      message.created_seq > unreadAnchor &&
      (!previous || previous.created_seq <= unreadAnchor);
    const grouped =
      !newDay &&
      !firstUnread &&
      previous?.actor_id === message.actor_id &&
      new Date(message.created_at).getTime() -
        new Date(previous.created_at).getTime() <
        groupWindowMs;
    return { message, newDay, firstUnread, grouped };
  });
}
