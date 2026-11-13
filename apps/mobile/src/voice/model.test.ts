import { describe, expect, it } from "vitest";
import {
  APIError,
  UploadHTTPError,
  type ClientMessage,
  type FileMetadata,
} from "@comamessenger/core";
import {
  declaredDuration,
  liveBars,
  nextVoiceFile,
  playableVoice,
  voiceFailure,
} from "./model";

function file(id: string, extra: Partial<FileMetadata> = {}): FileMetadata {
  return {
    id,
    name: "voice.m4a",
    mime: "audio/mp4",
    size: 1000,
    status: "ready",
    ...extra,
  } as FileMetadata;
}

const waveform = Array.from({ length: 64 }, (_, index) => index * 4);
const voice = (id: string) =>
  file(id, { voice: { duration_ms: 14_000, waveform } });

function message(id: string, files: FileMetadata[], deleted = false) {
  return {
    id,
    files,
    deleted_at: deleted ? "2026-11-11T00:00:00Z" : null,
  } as unknown as ClientMessage;
}

describe("playableVoice", () => {
  it("accepts a well-formed voice file", () => {
    expect(playableVoice(voice("a"))?.voice.duration_ms).toBe(14_000);
  });

  it("falls back to an attachment for an old client, a broken waveform or no length", () => {
    expect(playableVoice(file("plain"))).toBeNull();
    for (const broken of [
      { duration_ms: 0, waveform },
      { duration_ms: Number.NaN, waveform },
      { duration_ms: 5000, waveform: [] },
      { duration_ms: 5000, waveform: "x" },
      { duration_ms: 5000, waveform: [1, null, 3] },
      { duration_ms: 5000 },
      "voice",
    ])
      expect(playableVoice(file("x", { voice: broken as never }))).toBeNull();
  });

  it("clamps out-of-range levels instead of failing", () => {
    const loud = playableVoice(
      file("x", { voice: { duration_ms: 1000, waveform: [-5, 300, 10] } }),
    );
    expect(loud?.voice.waveform).toEqual([0, 255, 10]);
  });
});

describe("nextVoiceFile", () => {
  const messages = [
    message("1", [voice("v1")]),
    message("2", [voice("v2")]),
    message("3", []),
    message("4", [voice("v4")]),
    message("5", [voice("v5")], true),
  ];

  it("plays the next message when it is a voice message", () => {
    expect(nextVoiceFile(messages, "v1")?.id).toBe("v2");
  });

  it("stops at anything else in between, a deleted message or the end", () => {
    expect(nextVoiceFile(messages, "v2")).toBeNull();
    expect(nextVoiceFile(messages, "v4")).toBeNull();
    expect(nextVoiceFile(messages, "v5")).toBeNull();
    expect(nextVoiceFile(messages, "missing")).toBeNull();
  });

  it("skips a voice file that is not ready", () => {
    const pending = [
      message("1", [voice("v1")]),
      message("2", [{ ...voice("v2"), status: "pending" } as FileMetadata]),
    ];
    expect(nextVoiceFile(pending, "v1")).toBeNull();
  });
});

describe("liveBars", () => {
  it("shows the latest levels right-aligned, quiet as zero", () => {
    expect(liveBars([-60, -25, 0], 4)).toEqual([0, 0, 0.5, 1]);
    expect(liveBars([-10, -10, -10, -10, -10, 0], 2)).toEqual([0.8, 1]);
  });
});

describe("declaredDuration", () => {
  it("keeps the captured length within the server limits", () => {
    expect(declaredDuration(14_004.4)).toBe(14_004);
    expect(declaredDuration(200)).toBe(300);
    expect(declaredDuration(600_350)).toBe(600_000);
  });
});

describe("voiceFailure", () => {
  it("retries network drops and busy answers", () => {
    expect(voiceFailure(new TypeError("Network request failed"))).toBe(
      "offline",
    );
    expect(
      voiceFailure(new APIError(503, "voice_check_busy", "busy", {}, 5)),
    ).toBe("offline");
    expect(
      voiceFailure(new APIError(429, "voice_check_in_progress", "busy")),
    ).toBe("offline");
    expect(voiceFailure(new UploadHTTPError(503, 5))).toBe("offline");
  });

  it("does not offer a retry for a refused recording", () => {
    expect(
      voiceFailure(
        new APIError(422, "validation_failed", "voice content is not an m4a"),
      ),
    ).toBe("rejected");
    expect(voiceFailure(new UploadHTTPError(413))).toBe("rejected");
  });

  it("tells storage full apart", () => {
    expect(voiceFailure(new APIError(507, "storage_full", "full"))).toBe(
      "full",
    );
    expect(voiceFailure(new Error("boom"))).toBe("failed");
  });
});
