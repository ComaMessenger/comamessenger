import { describe, expect, it } from "vitest";
import {
  VOICE_WAVEFORM_LENGTH,
  formatVoiceDuration,
  isVoiceFile,
  nextVoicePlaybackRate,
  voiceWaveform,
  waveformBars,
} from "./voice";
import type { FileMetadata } from "./types";

describe("voice helpers", () => {
  it("formats durations as m:ss", () => {
    expect(formatVoiceDuration(0)).toBe("0:00");
    expect(formatVoiceDuration(14_200)).toBe("0:14");
    expect(formatVoiceDuration(74_600)).toBe("1:15");
    expect(formatVoiceDuration(600_000)).toBe("10:00");
    expect(formatVoiceDuration(-5)).toBe("0:00");
  });

  it("builds a 64-value peak waveform from linear or dB levels", () => {
    const linear = voiceWaveform([0, 0.5, 1, 0.25]);
    expect(linear).toHaveLength(VOICE_WAVEFORM_LENGTH);
    expect(Math.max(...linear)).toBe(255);
    expect(linear.every((value) => value >= 0 && value <= 255)).toBe(true);
    const many = Array.from({ length: 640 }, (_, index) =>
      index === 5 ? 1 : 0.1,
    );
    const peaks = voiceWaveform(many);
    expect(peaks[0]).toBe(255);
    expect(peaks[1]).toBe(26);
    const db = voiceWaveform([-160, -25, 0, Number.NaN], { decibels: true });
    expect(db).toHaveLength(VOICE_WAVEFORM_LENGTH);
    expect(db[0]).toBe(0);
    expect(db.at(-1)).toBe(0);
    expect(db).toContain(128);
    expect(db).toContain(255);
    expect(voiceWaveform([])).toEqual(Array(VOICE_WAVEFORM_LENGTH).fill(0));
  });

  it("resamples a waveform to any bar count", () => {
    const waveform = Array.from({ length: 64 }, (_, index) =>
      index === 63 ? 255 : 51,
    );
    const bars = waveformBars(waveform, 32);
    expect(bars).toHaveLength(32);
    expect(bars[0]).toBeCloseTo(0.2);
    expect(bars[31]).toBe(1);
    expect(waveformBars(waveform, 100)).toHaveLength(100);
    expect(waveformBars([], 3)).toEqual([0, 0, 0]);
  });

  it("cycles playback speed and recognises voice files", () => {
    expect(nextVoicePlaybackRate(1)).toBe(1.5);
    expect(nextVoicePlaybackRate(1.5)).toBe(2);
    expect(nextVoicePlaybackRate(2)).toBe(1);
    expect(
      isVoiceFile({
        voice: { duration_ms: 1, waveform: [] },
      } as unknown as FileMetadata),
    ).toBe(true);
    expect(isVoiceFile({} as FileMetadata)).toBe(false);
  });
});
