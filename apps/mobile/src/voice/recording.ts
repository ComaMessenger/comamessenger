import {
  VOICE_MAX_DURATION_MS,
  VOICE_MIN_DURATION_MS,
} from "@comamessenger/core";

/**
 * Voice recording in the composer as a pure state machine: gestures and
 * recorder reports go in as events, the next phase and the side effects to
 * run come out. Nothing here touches native modules, so every rule is
 * covered by unit tests (recording.test.ts).
 *
 *   idle ──press──▶ holding ──release (≥ 0.3 s)──▶ send ──▶ idle
 *     │               │  ├─release (< 0.3 s)──▶ idle + «hold to record»
 *     │               │  ├─left past cancel──▶ idle (discard, haptic)
 *     │               │  └─up past lock──▶ locked
 *     └─lockTap (screen reader / second quick tap)──▶ locked
 *   locked ──send──▶ idle (send) · ──stop──▶ review · ──discard──▶ idle
 *   review ──send──▶ idle (send the kept file) · ──discard──▶ idle
 *   holding/locked ──10 min, app in background, call──▶ review
 */

/** Finger travel to the left that cancels a held recording, in points. */
export const VOICE_CANCEL_DISTANCE = 110;
/** Finger travel upwards that locks the recording (hands-free), in points. */
export const VOICE_LOCK_DISTANCE = 80;
/** A second short tap within this window starts hands-free recording. */
export const VOICE_DOUBLE_TAP_MS = 450;
/** A press released sooner than this counts as a tap. */
export const VOICE_TAP_MS = 300;

export type RecorderPhase =
  | { kind: "idle"; lastTapAt?: number }
  | {
      kind: "holding";
      startedAt: number;
      /** Finger offset from where it went down; negative is left / up. */
      dx: number;
      dy: number;
      lastTapAt?: number;
    }
  | { kind: "locked"; startedAt: number }
  | { kind: "review"; durationMs: number };

export type RecorderEvent =
  /** Finger down on the microphone (permission already granted). */
  | { type: "press"; at: number }
  | { type: "move"; dx: number; dy: number }
  /** Finger up; `durationMs` is what the recorder actually captured. */
  | { type: "release"; at: number; durationMs: number }
  /** Hands-free start without holding: screen reader activation. */
  | { type: "lockTap" }
  /** Stop button of hands-free mode: keep the take for review. */
  | { type: "stop"; durationMs: number }
  | { type: "send"; durationMs: number }
  | { type: "discard" }
  | { type: "tick"; durationMs: number }
  /** The app left the foreground, a call came in or the route was lost. */
  | { type: "interrupt"; durationMs: number }
  /** The recorder reported an error; whatever was captured is dropped. */
  | { type: "failed" };

export type RecorderEffect =
  | { type: "start" }
  | { type: "stopAndSend" }
  | { type: "stopAndReview" }
  | { type: "stopAndDiscard" }
  | { type: "sendReviewed" }
  | { type: "discardReviewed" }
  | { type: "haptic"; kind: "start" | "lock" | "cancel" | "warning" }
  | {
      type: "announce";
      key:
        | "voiceRecordingStarted"
        | "voiceRecordingLocked"
        | "voiceRecordingCanceled"
        | "voiceRecordingStopped"
        | "voiceRecordingSending";
    }
  | {
      type: "hint";
      key: "voiceHoldToRecord" | "voiceMaxReached" | "voiceRecordFailed";
    };

export type Transition = { phase: RecorderPhase; effects: RecorderEffect[] };

export const idlePhase: RecorderPhase = { kind: "idle" };

/** Whether the recorder is capturing sound in this phase. */
export function isRecording(phase: RecorderPhase) {
  return phase.kind === "holding" || phase.kind === "locked";
}

/** 0..1 towards the cancel and lock thresholds, for the hint and the lock pill. */
export function gestureProgress(phase: RecorderPhase) {
  if (phase.kind !== "holding") return { cancel: 0, lock: 0 };
  return {
    cancel: clamp01(-phase.dx / VOICE_CANCEL_DISTANCE),
    lock: clamp01(-phase.dy / VOICE_LOCK_DISTANCE),
  };
}

function clamp01(value: number) {
  return Math.min(1, Math.max(0, value));
}

const same = (phase: RecorderPhase): Transition => ({ phase, effects: [] });

function cancelled(): Transition {
  return {
    phase: idlePhase,
    effects: [
      { type: "stopAndDiscard" },
      { type: "haptic", kind: "cancel" },
      { type: "announce", key: "voiceRecordingCanceled" },
    ],
  };
}

function toReview(durationMs: number, extra: RecorderEffect[] = []) {
  return {
    phase: {
      kind: "review",
      durationMs: Math.min(durationMs, VOICE_MAX_DURATION_MS),
    },
    effects: [
      { type: "stopAndReview" },
      { type: "announce", key: "voiceRecordingStopped" },
      ...extra,
    ],
  } satisfies Transition;
}

function tooShort(): Transition {
  return {
    phase: idlePhase,
    effects: [
      { type: "stopAndDiscard" },
      { type: "haptic", kind: "warning" },
      { type: "hint", key: "voiceHoldToRecord" },
    ],
  };
}

function sent(): Transition {
  return {
    phase: idlePhase,
    effects: [
      { type: "stopAndSend" },
      { type: "announce", key: "voiceRecordingSending" },
    ],
  };
}

export function recorderReducer(
  phase: RecorderPhase,
  event: RecorderEvent,
): Transition {
  switch (event.type) {
    case "press":
      if (phase.kind !== "idle") return same(phase);
      return {
        phase: {
          kind: "holding",
          startedAt: event.at,
          dx: 0,
          dy: 0,
          lastTapAt: phase.lastTapAt,
        },
        effects: [
          { type: "start" },
          { type: "haptic", kind: "start" },
          { type: "announce", key: "voiceRecordingStarted" },
        ],
      };

    case "lockTap":
      if (phase.kind !== "idle") return same(phase);
      return {
        phase: { kind: "locked", startedAt: 0 },
        effects: [
          { type: "start" },
          { type: "haptic", kind: "start" },
          { type: "announce", key: "voiceRecordingLocked" },
        ],
      };

    case "move": {
      if (phase.kind !== "holding") return same(phase);
      if (event.dx <= -VOICE_CANCEL_DISTANCE) return cancelled();
      if (event.dy <= -VOICE_LOCK_DISTANCE)
        return {
          phase: { kind: "locked", startedAt: phase.startedAt },
          effects: [
            { type: "haptic", kind: "lock" },
            { type: "announce", key: "voiceRecordingLocked" },
          ],
        };
      // Only leftward and upward travel matters; the other way is clamped.
      return same({
        ...phase,
        dx: Math.min(0, event.dx),
        dy: Math.min(0, event.dy),
      });
    }

    case "release": {
      if (phase.kind !== "holding") return same(phase);
      const tap = event.at - phase.startedAt < VOICE_TAP_MS;
      // Two quick taps: the second one keeps recording, hands-free.
      if (
        tap &&
        phase.lastTapAt !== undefined &&
        event.at - phase.lastTapAt <= VOICE_DOUBLE_TAP_MS + VOICE_TAP_MS
      )
        return {
          phase: { kind: "locked", startedAt: phase.startedAt },
          effects: [
            { type: "haptic", kind: "lock" },
            { type: "announce", key: "voiceRecordingLocked" },
          ],
        };
      if (event.durationMs < VOICE_MIN_DURATION_MS) {
        const next = tooShort();
        return tap
          ? { ...next, phase: { kind: "idle", lastTapAt: event.at } }
          : next;
      }
      return sent();
    }

    case "tick":
      if (!isRecording(phase) || event.durationMs < VOICE_MAX_DURATION_MS)
        return same(phase);
      return toReview(event.durationMs, [
        { type: "haptic", kind: "warning" },
        { type: "hint", key: "voiceMaxReached" },
      ]);

    case "stop":
      if (phase.kind !== "locked") return same(phase);
      return event.durationMs < VOICE_MIN_DURATION_MS
        ? tooShort()
        : toReview(event.durationMs);

    case "send":
      if (phase.kind === "review")
        return {
          phase: idlePhase,
          effects: [
            { type: "sendReviewed" },
            { type: "announce", key: "voiceRecordingSending" },
          ],
        };
      if (phase.kind !== "locked") return same(phase);
      return event.durationMs < VOICE_MIN_DURATION_MS ? tooShort() : sent();

    case "discard":
      if (phase.kind === "review")
        return {
          phase: idlePhase,
          effects: [
            { type: "discardReviewed" },
            { type: "announce", key: "voiceRecordingCanceled" },
          ],
        };
      if (!isRecording(phase)) return same(phase);
      return cancelled();

    case "interrupt":
      if (!isRecording(phase)) return same(phase);
      // Nothing worth keeping is dropped silently; a take too short to send
      // is dropped without a hint, the person did not finish it.
      return event.durationMs < VOICE_MIN_DURATION_MS
        ? { phase: idlePhase, effects: [{ type: "stopAndDiscard" }] }
        : toReview(event.durationMs);

    case "failed":
      if (phase.kind === "review")
        return {
          phase: idlePhase,
          effects: [
            { type: "discardReviewed" },
            { type: "hint", key: "voiceRecordFailed" },
          ],
        };
      if (!isRecording(phase)) return same(phase);
      return {
        phase: idlePhase,
        effects: [
          { type: "stopAndDiscard" },
          { type: "haptic", kind: "warning" },
          { type: "hint", key: "voiceRecordFailed" },
        ],
      };
  }
}
