import { describe, expect, it } from "vitest";
import {
  VOICE_CANCEL_DISTANCE,
  VOICE_LOCK_DISTANCE,
  gestureProgress,
  idlePhase,
  isRecording,
  recorderReducer,
  type RecorderEvent,
  type RecorderPhase,
} from "./recording";

function run(events: RecorderEvent[], from: RecorderPhase = idlePhase) {
  let phase = from;
  const effects: string[] = [];
  for (const event of events) {
    const next = recorderReducer(phase, event);
    phase = next.phase;
    for (const effect of next.effects)
      effects.push(
        effect.type === "haptic"
          ? `haptic:${effect.kind}`
          : effect.type === "announce" || effect.type === "hint"
            ? `${effect.type}:${effect.key}`
            : effect.type,
      );
  }
  return { phase, effects };
}

describe("hold to record", () => {
  it("starts on press and sends on release", () => {
    const { phase, effects } = run([
      { type: "press", at: 0 },
      { type: "release", at: 2000, durationMs: 1900 },
    ]);
    expect(phase.kind).toBe("idle");
    expect(effects).toEqual([
      "start",
      "haptic:start",
      "announce:voiceRecordingStarted",
      "stopAndSend",
      "announce:voiceRecordingSending",
    ]);
  });

  it("does not send a take shorter than 0.3 s and asks to hold", () => {
    const { phase, effects } = run([
      { type: "press", at: 0 },
      { type: "release", at: 600, durationMs: 250 },
    ]);
    expect(phase).toEqual({ kind: "idle" });
    expect(effects.slice(3)).toEqual([
      "stopAndDiscard",
      "haptic:warning",
      "hint:voiceHoldToRecord",
    ]);
  });

  it("judges the length by what the recorder captured, not by the finger", () => {
    // The recorder starts late; 0.4 s of holding captured 0.2 s.
    const { effects } = run([
      { type: "press", at: 0 },
      { type: "release", at: 400, durationMs: 200 },
    ]);
    expect(effects).toContain("stopAndDiscard");
    expect(effects).not.toContain("stopAndSend");
  });

  it("cancels when the finger slides left past the threshold", () => {
    const { phase, effects } = run([
      { type: "press", at: 0 },
      { type: "move", dx: -40, dy: 0 },
      { type: "move", dx: -VOICE_CANCEL_DISTANCE, dy: -5 },
      { type: "release", at: 3000, durationMs: 2900 },
    ]);
    expect(phase.kind).toBe("idle");
    expect(effects.slice(3)).toEqual([
      "stopAndDiscard",
      "haptic:cancel",
      "announce:voiceRecordingCanceled",
    ]);
  });

  it("locks when the finger slides up, and ignores the later release", () => {
    const { phase, effects } = run([
      { type: "press", at: 0 },
      { type: "move", dx: 0, dy: -VOICE_LOCK_DISTANCE },
      { type: "release", at: 1500, durationMs: 1400 },
    ]);
    expect(phase.kind).toBe("locked");
    expect(effects.slice(3)).toEqual([
      "haptic:lock",
      "announce:voiceRecordingLocked",
    ]);
  });

  it("tracks progress towards cancel and lock, clamping the other way", () => {
    const moved = run([
      { type: "press", at: 0 },
      { type: "move", dx: -VOICE_CANCEL_DISTANCE / 2, dy: 30 },
    ]).phase;
    expect(moved).toMatchObject({ dx: -VOICE_CANCEL_DISTANCE / 2, dy: 0 });
    expect(gestureProgress(moved)).toEqual({ cancel: 0.5, lock: 0 });
    expect(gestureProgress(idlePhase)).toEqual({ cancel: 0, lock: 0 });
  });
});

describe("hands-free", () => {
  it("starts locked from the screen reader action", () => {
    const { phase, effects } = run([{ type: "lockTap" }]);
    expect(phase.kind).toBe("locked");
    expect(effects).toEqual([
      "start",
      "haptic:start",
      "announce:voiceRecordingLocked",
    ]);
  });

  it("starts locked after two quick taps", () => {
    const { phase } = run([
      { type: "press", at: 0 },
      { type: "release", at: 120, durationMs: 40 },
      { type: "press", at: 300 },
      { type: "release", at: 420, durationMs: 60 },
    ]);
    expect(phase.kind).toBe("locked");
  });

  it("treats two taps far apart as two hints", () => {
    const { phase, effects } = run([
      { type: "press", at: 0 },
      { type: "release", at: 120, durationMs: 40 },
      { type: "press", at: 5000 },
      { type: "release", at: 5100, durationMs: 50 },
    ]);
    expect(phase.kind).toBe("idle");
    expect(
      effects.filter((item) => item === "hint:voiceHoldToRecord"),
    ).toHaveLength(2);
  });

  it("sends, stops into review or discards", () => {
    const locked: RecorderPhase = { kind: "locked", startedAt: 0 };
    expect(run([{ type: "send", durationMs: 5000 }], locked).effects).toContain(
      "stopAndSend",
    );
    expect(run([{ type: "stop", durationMs: 5000 }], locked).phase).toEqual({
      kind: "review",
      durationMs: 5000,
    });
    expect(run([{ type: "discard" }], locked).effects).toContain(
      "stopAndDiscard",
    );
  });

  it("refuses to send or keep a take under 0.3 s", () => {
    const locked: RecorderPhase = { kind: "locked", startedAt: 0 };
    for (const event of [
      { type: "send", durationMs: 100 },
      { type: "stop", durationMs: 100 },
    ] as RecorderEvent[]) {
      const { phase, effects } = run([event], locked);
      expect(phase.kind).toBe("idle");
      expect(effects).toContain("hint:voiceHoldToRecord");
    }
  });
});

describe("review", () => {
  const review: RecorderPhase = { kind: "review", durationMs: 4000 };

  it("sends or deletes the kept take", () => {
    expect(run([{ type: "send", durationMs: 0 }], review).effects).toEqual([
      "sendReviewed",
      "announce:voiceRecordingSending",
    ]);
    expect(run([{ type: "discard" }], review).effects).toEqual([
      "discardReviewed",
      "announce:voiceRecordingCanceled",
    ]);
  });

  it("ignores gestures and a new press", () => {
    expect(run([{ type: "press", at: 0 }], review).phase).toBe(review);
    expect(run([{ type: "move", dx: -500, dy: 0 }], review).phase).toBe(review);
  });
});

describe("limits and interruptions", () => {
  it("stops at ten minutes and moves to review", () => {
    const { phase, effects } = run([
      { type: "press", at: 0 },
      { type: "tick", durationMs: 599_000 },
      { type: "tick", durationMs: 600_040 },
    ]);
    expect(phase).toEqual({ kind: "review", durationMs: 600_000 });
    expect(effects).toContain("stopAndReview");
    expect(effects).toContain("hint:voiceMaxReached");
  });

  it("keeps an interrupted take for review", () => {
    const { phase } = run([
      { type: "press", at: 0 },
      { type: "interrupt", durationMs: 3000 },
    ]);
    expect(phase).toEqual({ kind: "review", durationMs: 3000 });
  });

  it("drops an interrupted take too short to send", () => {
    const { phase, effects } = run([
      { type: "lockTap" },
      { type: "interrupt", durationMs: 100 },
    ]);
    expect(phase.kind).toBe("idle");
    expect(effects).toContain("stopAndDiscard");
    expect(effects.some((item) => item.startsWith("hint:"))).toBe(false);
  });

  it("drops the take and says so when the recorder fails", () => {
    const { phase, effects } = run([
      { type: "press", at: 0 },
      { type: "failed" },
    ]);
    expect(phase.kind).toBe("idle");
    expect(effects).toContain("hint:voiceRecordFailed");
  });

  it("ignores events that make no sense in idle", () => {
    for (const event of [
      { type: "move", dx: -500, dy: -500 },
      { type: "release", at: 10, durationMs: 1000 },
      { type: "tick", durationMs: 700_000 },
      { type: "interrupt", durationMs: 5000 },
      { type: "send", durationMs: 5000 },
      { type: "discard" },
      { type: "failed" },
    ] as RecorderEvent[])
      expect(recorderReducer(idlePhase, event)).toEqual({
        phase: idlePhase,
        effects: [],
      });
    expect(isRecording(idlePhase)).toBe(false);
  });
});
