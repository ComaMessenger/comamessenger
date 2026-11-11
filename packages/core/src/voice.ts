import type { FileMetadata, VoiceInfo } from "./types";

/** Server limits for voice recordings; see VoiceInfo in openapi.yaml. */
export const VOICE_WAVEFORM_LENGTH = 64;
export const VOICE_MIN_DURATION_MS = 300;
export const VOICE_MAX_DURATION_MS = 10 * 60 * 1000;
/** Below the default multipart threshold; the server always uses one PUT. */
export const VOICE_MAX_BYTES = 15 * 1024 * 1024;
/**
 * Type to declare and to send as Content-Type when uploading a recording.
 * The server stores every voice file as audio/mp4, and a presigned PUT must
 * repeat the stored type.
 */
export const VOICE_MIME = "audio/mp4";
export const VOICE_PLAYBACK_RATES = [1, 1.5, 2] as const;

export function isVoiceFile(
  file: FileMetadata,
): file is FileMetadata & { voice: VoiceInfo } {
  return file.voice != null;
}

/** "0:14", "1:05", "10:00"; rounds to the nearest second. */
export function formatVoiceDuration(milliseconds: number) {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * Builds the 64-value waveform the server expects from levels sampled while
 * recording. `levels` are linear 0..1 amplitudes, or dBFS (-160..0) when
 * `decibels` is set, as Expo's recorder metering reports. Each output value is
 * the loudest level of an equal slice, scaled to 0..255.
 */
export function voiceWaveform(
  levels: readonly number[],
  {
    decibels = false,
    floorDb = -50,
  }: { decibels?: boolean; floorDb?: number } = {},
): number[] {
  const linear = levels.map((level) => {
    if (!Number.isFinite(level)) return 0;
    if (!decibels) return Math.min(1, Math.max(0, level));
    if (level <= floorDb) return 0;
    return Math.min(1, (level - floorDb) / -floorDb);
  });
  const result: number[] = [];
  for (let index = 0; index < VOICE_WAVEFORM_LENGTH; index += 1) {
    if (linear.length === 0) {
      result.push(0);
      continue;
    }
    const start = Math.floor((index * linear.length) / VOICE_WAVEFORM_LENGTH);
    const end = Math.max(
      start + 1,
      Math.floor(((index + 1) * linear.length) / VOICE_WAVEFORM_LENGTH),
    );
    let peak = 0;
    for (let at = start; at < end && at < linear.length; at += 1)
      peak = Math.max(peak, linear[at]!);
    result.push(Math.round(peak * 255));
  }
  return result;
}

/** Resamples a waveform to `bars` heights in 0..1 for drawing at any width. */
export function waveformBars(
  waveform: readonly number[],
  bars: number,
): number[] {
  if (bars <= 0) return [];
  if (waveform.length === 0) return Array.from({ length: bars }, () => 0);
  return Array.from({ length: bars }, (_, index) => {
    const start = Math.floor((index * waveform.length) / bars);
    const end = Math.max(
      start + 1,
      Math.floor(((index + 1) * waveform.length) / bars),
    );
    let peak = 0;
    for (let at = start; at < end && at < waveform.length; at += 1)
      peak = Math.max(peak, waveform[at]!);
    return Math.min(1, Math.max(0, peak / 255));
  });
}

/** Next speed in the 1× → 1.5× → 2× → 1× cycle. */
export function nextVoicePlaybackRate(current: number) {
  const index = VOICE_PLAYBACK_RATES.findIndex((rate) => rate === current);
  return VOICE_PLAYBACK_RATES[(index + 1) % VOICE_PLAYBACK_RATES.length]!;
}
