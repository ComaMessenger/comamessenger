import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APIError, type MessengerAPI } from "@comamessenger/core";
import { uploadAttachment } from "./uploads";

type Answer = { status: number; etag?: string; retryAfter?: string };
let answers: Record<string, Answer[]>;
let sent: string[];

class FakeXHR {
  status = 0;
  responseText = "";
  upload: { onprogress: ((event: ProgressEvent) => void) | null } = {
    onprogress: null,
  };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  private url = "";
  private headers: Record<string, string> = {};
  open(_method: string, url: string) {
    this.url = url;
  }
  setRequestHeader() {}
  getResponseHeader(name: string) {
    return this.headers[name.toLowerCase()] ?? null;
  }
  abort() {
    this.onabort?.();
  }
  send() {
    sent.push(this.url);
    const answer = answers[this.url]?.shift() ?? {
      status: 200,
      etag: '"etag"',
    };
    this.status = answer.status;
    if (answer.etag) this.headers.etag = answer.etag;
    if (answer.retryAfter) this.headers["retry-after"] = answer.retryAfter;
    queueMicrotask(() => this.onload?.());
  }
}

function fakeAPI(
  mode: "presigned" | "multipart",
  complete: () => Promise<unknown>,
) {
  return {
    apiURL: "http://core.test",
    token: () => "token",
    createFileUpload: vi.fn().mockResolvedValue({
      id: "upload-1",
      mode,
      upload_url: mode === "presigned" ? "https://s3.test/put" : undefined,
      file: { mime: "text/plain" },
    }),
    signFileUploadParts: vi.fn((_id: string, numbers: number[]) =>
      Promise.resolve({
        parts: numbers.map((number) => ({
          number,
          url: `https://s3.test/part-${number}?signed=${sent.filter((url) => url.includes(`part-${number}`)).length}`,
        })),
      }),
    ),
    completeFileUpload: vi.fn(complete),
    abortFileUpload: vi.fn().mockResolvedValue(undefined),
  } as unknown as MessengerAPI & {
    completeFileUpload: ReturnType<typeof vi.fn>;
    abortFileUpload: ReturnType<typeof vi.fn>;
    signFileUploadParts: ReturnType<typeof vi.fn>;
  };
}

const busy = () => new APIError(503, "storage_unavailable", "busy", {}, 5);
const sleep = vi.fn().mockResolvedValue(undefined);
const small = new File(["hello"], "notes.txt", { type: "text/plain" });

describe("uploadAttachment", () => {
  beforeEach(() => {
    answers = {};
    sent = [];
    sleep.mockClear();
    vi.stubGlobal("XMLHttpRequest", FakeXHR);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("repeats complete on 503 after Retry-After and keeps the upload", async () => {
    const complete = vi
      .fn()
      .mockRejectedValueOnce(busy())
      .mockRejectedValueOnce(new APIError(429, "rate_limited", "", {}, 2))
      .mockResolvedValue({ id: "file-1" });
    const api = fakeAPI("presigned", complete);
    const file = await uploadAttachment(
      api,
      small,
      new AbortController().signal,
      () => undefined,
      { sleep },
    );
    expect(file).toEqual({ id: "file-1" });
    expect(complete).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map((call) => call[0])).toEqual([5000, 2000]);
    expect(api.abortFileUpload).not.toHaveBeenCalled();
  });

  it("does not abort when complete stays busy, so the object survives", async () => {
    const api = fakeAPI("presigned", () => Promise.reject(busy()));
    await expect(
      uploadAttachment(
        api,
        small,
        new AbortController().signal,
        () => undefined,
        { sleep, attempts: 3 },
      ),
    ).rejects.toMatchObject({ status: 503 });
    expect(api.completeFileUpload).toHaveBeenCalledTimes(3);
    expect(api.abortFileUpload).not.toHaveBeenCalled();
  });

  it("aborts on a final error", async () => {
    const api = fakeAPI("presigned", () =>
      Promise.reject(new APIError(422, "validation_failed", "not a recording")),
    );
    await expect(
      uploadAttachment(
        api,
        small,
        new AbortController().signal,
        () => undefined,
        { sleep },
      ),
    ).rejects.toMatchObject({ status: 422 });
    expect(api.completeFileUpload).toHaveBeenCalledOnce();
    expect(api.abortFileUpload).toHaveBeenCalledWith("upload-1");
  });

  it("re-signs a part whose URL expired and finishes the multipart upload", async () => {
    answers["https://s3.test/part-1?signed=0"] = [{ status: 403 }];
    const api = fakeAPI("multipart", () => Promise.resolve({ id: "file-2" }));
    const big = new File([new Uint8Array(6 * 1024 * 1024)], "video.bin");
    const file = await uploadAttachment(
      api,
      big,
      new AbortController().signal,
      () => undefined,
      { sleep },
    );
    expect(file).toEqual({ id: "file-2" });
    expect(sent).toEqual([
      "https://s3.test/part-1?signed=0",
      "https://s3.test/part-1?signed=1",
      "https://s3.test/part-2?signed=0",
    ]);
    expect(api.signFileUploadParts).toHaveBeenLastCalledWith("upload-1", [1]);
    expect(api.completeFileUpload).toHaveBeenCalledWith("upload-1", [
      { number: 1, etag: '"etag"', size: 5 * 1024 * 1024 },
      { number: 2, etag: '"etag"', size: 1024 * 1024 },
    ]);
    expect(api.abortFileUpload).not.toHaveBeenCalled();
  });
});
