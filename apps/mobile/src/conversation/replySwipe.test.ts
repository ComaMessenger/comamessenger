import { describe, expect, it } from "vitest";
import { BACK_EDGE_ZONE, replySwipeProps } from "./replySwipe";

describe("swipe to reply next to swipe back", () => {
  it("starts only on a leftward drag, as in Telegram", () => {
    expect(replySwipeProps.dragOffsetFromRightEdge).toBeLessThanOrEqual(12);
    // A rightward drag is "back": the row must never take it.
    expect(replySwipeProps.dragOffsetFromLeftEdge).toBeGreaterThan(5_000);
  });

  it("leaves the left edge to the navigator's swipe back", () => {
    expect(BACK_EDGE_ZONE).toBeGreaterThanOrEqual(20);
    expect(replySwipeProps.hitSlop.left).toBe(-BACK_EDGE_ZONE);
  });
});
