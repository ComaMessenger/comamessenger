import {
  APIError,
  UploadHTTPError,
  VOICE_MAX_DURATION_MS,
  VOICE_MIN_DURATION_MS,
  VOICE_WAVEFORM_LENGTH,
  isRetryableUploadError,
  type ClientMessage,
  type FileMetadata,
  type VoiceInfo,
} from "@comamessenger/core";

export type VoiceFile = FileMetadata & { voice: VoiceInfo };

/**
 * The voice part of a file when it is safe to draw as a voice message. A
 * file from an older client (no `voice`), a broken waveform or a zero length
 * is shown as an ordinary attachment instead.
 */
export function playableVoice(file: FileMetadata): VoiceFile | null {
  const voice = file.voice as Partial<VoiceInfo> | null | undefined;
  if (!voice || typeof voice !== "object") return null;
  const duration = voice.duration_ms;
  if (
    typeof duration !== "number" ||
    !Number.isFinite(duration) ||
    duration <= 0 ||
    duration > VOICE_MAX_DURATION_MS * 2
  )
    return null;
  const waveform = voice.waveform;
  if (
    !Array.isArray(waveform) ||
    waveform.length === 0 ||
    waveform.length > VOICE_WAVEFORM_LENGTH * 4 ||
    !waveform.every(
      (value) => typeof value === "number" && Number.isFinite(value),
    )
  )
    return null;
  return {
    ...file,
    voice: {
      duration_ms: Math.round(duration),
      waveform: waveform.map((value) => Math.min(255, Math.max(0, value))),
    },
  };
}

/**
 * The voice message that plays after `fileID` ends: the next message in the
 * feed, if it is a voice message too. Anything else in between stops the
 * chain, as in the web player.
 */
export function nextVoiceFile(
  messages: readonly ClientMessage[],
  fileID: string,
): VoiceFile | null {
  const index = messages.findIndex((message) =>
    message.files?.some((file) => file.id === fileID),
  );
  if (index < 0) return null;
  const next = messages[index + 1];
  if (!next || next.deleted_at) return null;
  for (const file of next.files ?? []) {
    const voice = playableVoice(file);
    if (voice && voice.status === "ready") return voice;
  }
  return null;
}

/** Live bars while recording: the most recent `count` levels as 0..1. */
export function liveBars(
  levels: readonly number[],
  count: number,
  floorDb = -50,
): number[] {
  const recent = levels.slice(-count);
  const bars = recent.map((level) =>
    !Number.isFinite(level) || level <= floorDb
      ? 0
      : Math.min(1, (level - floorDb) / -floorDb),
  );
  return [...Array.from({ length: count - bars.length }, () => 0), ...bars];
}

/** Duration to declare to the server: what was captured, within the limits. */
export function declaredDuration(capturedMs: number) {
  return Math.min(
    VOICE_MAX_DURATION_MS,
    Math.max(VOICE_MIN_DURATION_MS, Math.round(capturedMs)),
  );
}

/**
 * Why an outgoing voice message is stuck, for the outbox row.
 * - `offline`: the network dropped or the server stayed busy (429/503 after
 *   all retries); «Retry» sends the same take again.
 * - `rejected`: the server checked the file and refused it (not a voice
 *   recording, too long, too large); repeating will not help, only delete.
 * - `full`: storage quota reached; may pass later.
 * - `failed`: anything else; retry is offered.
 */
export type VoiceFailure = "offline" | "rejected" | "full" | "failed";

export function voiceFailure(error: unknown): VoiceFailure {
  if (isRetryableUploadError(error)) return "offline";
  if (error instanceof APIError) {
    if (error.code === "storage_full" || error.status === 507) return "full";
    if (
      error.status === 422 ||
      error.status === 413 ||
      error.status === 415 ||
      error.code === "validation_failed"
    )
      return "rejected";
  }
  if (error instanceof UploadHTTPError && error.status === 413)
    return "rejected";
  return "failed";
}
