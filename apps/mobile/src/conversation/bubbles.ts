import type { FeedRow } from "@comamessenger/core";

/** Where a message bubble sits and which parts of it are drawn. */
export type BubblePlacement = {
  own: boolean;
  /** First of a run of messages by one author: name and full top corner. */
  first: boolean;
  /** Last of the run: the avatar sits next to it. */
  last: boolean;
  /** Group chats name the author above their first bubble. */
  showName: boolean;
  /** Group chats keep an avatar column for other people's messages. */
  avatarColumn: boolean;
  /** The avatar itself, next to the last bubble of a run. */
  showAvatar: boolean;
};

/**
 * Layout of the bubble at `index`. `rows` comes from `feedRows`, whose
 * `grouped` already joins one author's messages within a few minutes.
 * `leading` makes the row start a run regardless, e.g. the first reply
 * under a thread root.
 */
export function bubblePlacement(
  rows: readonly FeedRow[],
  index: number,
  ownID: string,
  groupChat: boolean,
  leading = false,
): BubblePlacement {
  const row = rows[index]!;
  const own = row.message.actor_id === ownID;
  const first = leading || !row.grouped;
  const last = !rows[index + 1]?.grouped;
  const avatarColumn = groupChat && !own;
  return {
    own,
    first,
    last,
    showName: avatarColumn && first,
    avatarColumn,
    showAvatar: avatarColumn && last,
  };
}

/** Corner radii: the author's side is tucked in below the first bubble of a run. */
export function bubbleCorners(
  placement: Pick<BubblePlacement, "own" | "first">,
  round: number,
  tucked: number,
) {
  const sideTop = placement.first ? round : tucked;
  return placement.own
    ? {
        borderTopLeftRadius: round,
        borderBottomLeftRadius: round,
        borderTopRightRadius: sideTop,
        borderBottomRightRadius: tucked,
      }
    : {
        borderTopRightRadius: round,
        borderBottomRightRadius: round,
        borderTopLeftRadius: sideTop,
        borderBottomLeftRadius: tucked,
      };
}
