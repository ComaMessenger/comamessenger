import { describe, expect, it } from "vitest";
import type { ClientMessage, FileMetadata } from "@comamessenger/core";
import {
  chatMedia,
  containSize,
  formatMediaDuration,
  indexOfMedia,
  mediaPosition,
  panBounds,
} from "./items";
import { displayAspect, mediaMosaic, rowCounts } from "./layout";
import { fileMaxBytes, sendProgress, withinFileLimit } from "./progress";

const options = { maxWidth: 280, maxHeight: 360, minWidth: 140 };

function file(id: string, mime: string, extra: Partial<FileMetadata> = {}) {
  return {
    id,
    name: id,
    mime,
    size: 10,
    status: "ready",
    processing_status: "ready",
    created_at: "2026-11-11T09:00:00Z",
    uploader_id: "me",
    ...extra,
  } as FileMetadata;
}

function message(
  id: string,
  seq: number,
  files: FileMetadata[],
  extra: Partial<ClientMessage> = {},
): ClientMessage {
  return {
    id,
    chat_id: "chat",
    actor_id: "anna",
    client_msg_id: id,
    type: "text",
    body: "",
    body_format: "markdown",
    version: 1,
    created_seq: seq,
    created_at: "2026-11-11T09:00:00Z",
    mentioned_actor_ids: [],
    thread_reply_count: 0,
    files,
    ...extra,
  };
}

describe("mediaMosaic", () => {
  it("keeps a tall photo tall, narrower and capped in height", () => {
    const { width, height, frames } = mediaMosaic([0.75], options);
    expect(height).toBe(360);
    expect(width).toBe(270);
    expect(frames).toEqual([{ x: 0, y: 0, width: 270, height: 360 }]);
  });

  it("shows a wide photo across the bubble at its proportions", () => {
    expect(mediaMosaic([2], options)).toMatchObject({
      width: 280,
      height: 140,
    });
  });

  it("never makes a very tall photo a thin strip", () => {
    const { width } = mediaMosaic([0.2], options);
    expect(width).toBeGreaterThanOrEqual(140);
  });

  it("puts two portrait photos side by side and two wide ones stacked", () => {
    const side = mediaMosaic([0.75, 0.75], options);
    expect(side.frames[0]!.y).toBe(side.frames[1]!.y);
    expect(side.frames[1]!.x).toBeGreaterThan(0);
    const stacked = mediaMosaic([1.8, 1.8], options);
    expect(stacked.frames[1]!.y).toBeGreaterThan(0);
    expect(stacked.frames[1]!.x).toBe(0);
  });

  it("puts a tall first photo on the left and the rest stacked on the right", () => {
    const { frames, width, height } = mediaMosaic([0.6, 1.5, 1.5], options);
    expect(frames[0]).toMatchObject({ x: 0, y: 0, height });
    expect(frames[1]!.x).toBe(frames[2]!.x);
    expect(frames[2]!.y).toBeGreaterThan(frames[1]!.y);
    expect(frames[1]!.x + frames[1]!.width).toBe(width);
    expect(frames[2]!.y + frames[2]!.height).toBe(height);
  });

  it("puts a wide first photo on top of the others", () => {
    const { frames, width } = mediaMosaic([1.6, 1, 1, 1], options);
    expect(frames[0]).toMatchObject({ x: 0, y: 0, width });
    expect(new Set(frames.slice(1).map((frame) => frame.y)).size).toBe(1);
  });

  it("lays five and more out in rows that fill the width", () => {
    const { frames, width } = mediaMosaic([1, 1, 1, 1, 1, 1, 1], options);
    expect(frames).toHaveLength(7);
    const rows = new Map<number, number>();
    for (const frame of frames)
      rows.set(
        frame.y,
        Math.max(rows.get(frame.y) ?? 0, frame.x + frame.width),
      );
    for (const right of rows.values()) expect(right).toBe(width);
  });

  it("splits rows of three, shorter rows first", () => {
    expect(rowCounts(5)).toEqual([2, 3]);
    expect(rowCounts(7)).toEqual([2, 2, 3]);
    expect(rowCounts(9)).toEqual([3, 3, 3]);
  });

  it("treats an unknown size as a square", () => {
    expect(displayAspect(undefined)).toBe(1);
    expect(displayAspect(Number.NaN)).toBe(1);
    expect(displayAspect(10)).toBe(2.6);
  });
});

describe("chatMedia", () => {
  it("lists photos and videos in feed order and skips the rest", () => {
    const items = chatMedia([
      message("m2", 2, [
        file("v1", "video/mp4"),
        file("doc", "application/pdf"),
      ]),
      message("m1", 1, [file("p1", "image/jpeg"), file("p2", "image/png")]),
      message("m3", 3, [file("p3", "image/jpeg")], { deleted_at: "x" }),
      message("m4", 4, [file("p4", "image/jpeg")], { delivery: "sending" }),
      message("m5", 5, [file("p5", "image/jpeg", { status: "pending" })]),
      message("m6", 6, [
        file("a1", "audio/mp4", {
          voice: { duration_ms: 1000, waveform: [] },
        }),
      ]),
    ]);
    expect(items.map((item) => [item.key, item.kind, item.messageID])).toEqual([
      ["p1", "photo", "m1"],
      ["p2", "photo", "m1"],
      ["v1", "video", "m2"],
    ]);
    expect(indexOfMedia(items, "v1")).toBe(2);
    expect(indexOfMedia(items, null)).toBe(-1);
  });
});

describe("viewer geometry", () => {
  it("fits an item inside the screen", () => {
    expect(containSize(2, { width: 400, height: 800 })).toEqual({
      width: 400,
      height: 200,
    });
    expect(containSize(0.5, { width: 400, height: 400 })).toEqual({
      width: 200,
      height: 400,
    });
  });

  it("lets a zoomed item move only until its edge reaches the screen's", () => {
    const screen = { width: 400, height: 800 };
    expect(panBounds({ width: 400, height: 200 }, screen, 1)).toEqual({
      x: 0,
      y: 0,
    });
    expect(panBounds({ width: 400, height: 200 }, screen, 2.5)).toEqual({
      x: 300,
      y: 0,
    });
  });

  it("formats durations", () => {
    expect(formatMediaDuration(7_000)).toBe("0:07");
    expect(formatMediaDuration(750_000)).toBe("12:30");
    expect(formatMediaDuration(3_723_000)).toBe("1:02:03");
  });
});

describe("sending media", () => {
  const job = (
    status: "uploading" | "ready" | "failed",
    progress: number,
    size: number,
  ) => ({ status, progress, local: { size } });

  it("weights progress by file size", () => {
    expect(
      sendProgress([job("ready", 1, 1), job("uploading", 0.5, 9)]).progress,
    ).toBeCloseTo(0.55);
    expect(sendProgress([job("ready", 1, 3)])).toMatchObject({
      progress: 1,
      ready: true,
      failed: false,
    });
    expect(sendProgress([job("failed", 0.2, 3)]).failed).toBe(true);
    expect(sendProgress([undefined]).ready).toBe(false);
  });

  it("leaves out files over the server limit", () => {
    const result = withinFileLimit([{ size: 10 }, { size: fileMaxBytes + 1 }]);
    expect(result).toEqual({ accepted: [{ size: 10 }], tooLarge: 1 });
  });
});

describe("mediaPosition", () => {
  it("counts the loaded items when the total is unknown", () => {
    expect(mediaPosition(2, 12)).toEqual({ current: 3, total: 12 });
  });
  it("counts across the whole chat in the archive", () => {
    // The newest 60 of 140 are loaded, oldest first: the first is №81.
    expect(mediaPosition(0, 60, 140)).toEqual({ current: 81, total: 140 });
    expect(mediaPosition(59, 60, 140)).toEqual({ current: 140, total: 140 });
    // A stale total smaller than what is loaded never shows «70 of 60».
    expect(mediaPosition(5, 70, 60)).toEqual({ current: 6, total: 70 });
  });
});
