/**
 * How a message row's swipe-to-reply sits next to the stack's swipe back.
 *
 * Rows span the whole screen width, so with the swipeable's defaults
 * (it starts after 10 pt in either direction) a finger moving right from
 * the left edge was taken by the row before iOS's edge-swipe back could
 * recognise it: in a chat with messages the screen could not be swiped
 * away. Reply is a swipe to the left, as in Telegram, so the row never
 * needs a rightward pan, and a strip along the left edge is left to the
 * navigator entirely.
 */

/** iOS's edge-swipe back starts within about 20 pt of the left edge. */
export const BACK_EDGE_ZONE = 24;

/** Rightward drags never start the row's pan: that direction is "back". */
const NEVER = 10_000;

export const replySwipeProps = {
  /** Leftward movement that starts the reply drag. */
  dragOffsetFromRightEdge: 10,
  dragOffsetFromLeftEdge: NEVER,
  /** A negative slop trims the row's touch area: the edge belongs to back. */
  hitSlop: { left: -BACK_EDGE_ZONE },
} as const;
