import { describe, expect, it, vi } from "vitest";
import { APIError, MessengerAPI } from "./api";
import {
  UploadHTTPError,
  completeUploadWithRetry,
  isRetryableUploadError,
  parseRetryAfter,
  retryUploadStep,
  sendPartWithResign,
  shouldAbortUpload,
} from "./uploads";
import type { FileMetadata } from "./types";

const busy = (seconds?: number) =>
  new APIError(503, "storage_unavailable", "busy", {}, seconds);
const file = { id: "f" } as FileMetadata;

describe("upload retries", () => {
  it("parses Retry-After seconds and dates", () => {
    expect(parseRetryAfter("5")).toBe(5);
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter("soon")).toBeUndefined();
    const now = Date.parse("2026-11-11T12:00:00Z");
    expect(parseRetryAfter("Wed, 11 Nov 2026 12:00:07 GMT", now)).toBe(7);
  });

  it("classifies temporary failures", () => {
    expect(isRetryableUploadError(busy())).toBe(true);
    expect(isRetryableUploadError(new APIError(429, "rate_limited", ""))).toBe(
      true,
    );
    expect(isRetryableUploadError(new TypeError("Failed to fetch"))).toBe(true);
    expect(isRetryableUploadError(new UploadHTTPError(503))).toBe(true);
    expect(
      isRetryableUploadError(new APIError(422, "validation_failed", "")),
    ).toBe(false);
    expect(
      isRetryableUploadError(new APIError(404, "file_not_found", "")),
    ).toBe(false);
  });

  it("repeats complete on 503/429 honouring Retry-After", async () => {
    const complete = vi
      .fn()
      .mockRejectedValueOnce(busy(5))
      .mockRejectedValueOnce(new APIError(429, "rate_limited", "", {}, 2))
      .mockResolvedValue(file);
    const sleep = vi.fn().mockResolvedValue(undefined);
    await expect(
      completeUploadWithRetry({ completeFileUpload: complete }, "u", [], {
        sleep,
      }),
    ).resolves.toBe(file);
    expect(complete).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map((call) => call[0])).toEqual([5000, 2000]);
  });

  it("backs off without Retry-After, caps the wait and gives up", async () => {
    const complete = vi.fn().mockRejectedValue(busy());
    const sleep = vi.fn().mockResolvedValue(undefined);
    await expect(
      completeUploadWithRetry({ completeFileUpload: complete }, "u", [], {
        sleep,
        attempts: 4,
        maxDelayMs: 3000,
      }),
    ).rejects.toBeInstanceOf(APIError);
    expect(complete).toHaveBeenCalledTimes(4);
    expect(sleep.mock.calls.map((call) => call[0])).toEqual([1000, 2000, 3000]);
  });

  it("does not repeat a final error", async () => {
    const complete = vi
      .fn()
      .mockRejectedValue(new APIError(422, "validation_failed", ""));
    const sleep = vi.fn();
    await expect(
      retryUploadStep(() => complete(), { sleep }),
    ).rejects.toMatchObject({ status: 422 });
    expect(complete).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("re-signs a part whose URL expired", async () => {
    const sign = vi
      .fn()
      .mockResolvedValue({ parts: [{ number: 3, url: "fresh" }] });
    const send = vi
      .fn()
      .mockRejectedValueOnce(new UploadHTTPError(403))
      .mockResolvedValue("etag-3");
    await expect(
      sendPartWithResign(
        { signFileUploadParts: sign },
        "u",
        { number: 3, url: "old" },
        send,
      ),
    ).resolves.toBe("etag-3");
    expect(sign).toHaveBeenCalledWith("u", [3]);
    expect(send.mock.calls.map((call) => call[0])).toEqual(["old", "fresh"]);
    const failing = vi.fn().mockRejectedValue(new UploadHTTPError(500));
    await expect(
      sendPartWithResign(
        { signFileUploadParts: sign },
        "u",
        { number: 1, url: "x" },
        failing,
      ),
    ).rejects.toMatchObject({ status: 500 });
    expect(failing).toHaveBeenCalledOnce();
  });

  it("aborts only on final errors", () => {
    expect(shouldAbortUpload(busy(), true)).toBe(false);
    expect(
      shouldAbortUpload(new APIError(422, "validation_failed", ""), true),
    ).toBe(true);
    expect(shouldAbortUpload(new UploadHTTPError(403), false)).toBe(true);
    expect(shouldAbortUpload(busy(), false)).toBe(true);
  });
});

describe("APIError Retry-After", () => {
  it("carries the header of a failed request", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ code: "storage_unavailable", message: "busy" }),
        {
          status: 503,
          headers: { "Retry-After": "5", "Content-Type": "application/json" },
        },
      ),
    );
    vi.stubGlobal("fetch", fetch);
    try {
      const api = new MessengerAPI("http://core.test");
      await expect(api.completeFileUpload("u")).rejects.toMatchObject({
        status: 503,
        retryAfterSeconds: 5,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
