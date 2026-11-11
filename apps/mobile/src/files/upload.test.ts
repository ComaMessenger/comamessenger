import { beforeEach, describe, expect, it, vi } from "vitest";
import { APIError, type MessengerAPI } from "@comamessenger/core";

type Answer = { status: number; headers?: Record<string, string> };
const transfers: { answers: Record<string, Answer[]>; sent: string[] } = {
  answers: {},
  sent: [],
};

vi.mock("expo-file-system", () => {
  class File {
    offset = 0;
    constructor(..._parts: unknown[]) {}
    open() {
      return this;
    }
    readBytes(length: number) {
      return new Uint8Array(length);
    }
    write() {}
    delete() {}
    close() {}
    upload(url: string) {
      transfers.sent.push(url);
      const answer = transfers.answers[url]?.shift() ?? {
        status: 200,
        headers: { ETag: '"etag"' },
      };
      return Promise.resolve({
        status: answer.status,
        headers: answer.headers ?? {},
        body: JSON.stringify({ id: "streamed" }),
      });
    }
  }
  return { File, Paths: { cache: "cache" }, UploadType: { BINARY_CONTENT: 0 } };
});

const { uploadFile } = await import("./upload");

function fakeAPI(
  mode: "presigned" | "multipart",
  complete: () => Promise<unknown>,
) {
  return {
    apiURL: "https://core.test",
    token: () => "token",
    refresh: vi.fn(),
    clearToken: vi.fn(),
    createFileUpload: vi.fn().mockResolvedValue({
      id: "upload-1",
      mode,
      upload_url: mode === "presigned" ? "https://s3.test/put" : undefined,
    }),
    signFileUploadParts: vi.fn((_id: string, numbers: number[]) =>
      Promise.resolve({
        parts: numbers.map((number) => ({
          number,
          url: `https://s3.test/part-${number}?signed=${transfers.sent.filter((url) => url.includes(`part-${number}`)).length}`,
        })),
      }),
    ),
    completeFileUpload: vi.fn(complete),
    abortFileUpload: vi.fn().mockResolvedValue(undefined),
  } as unknown as MessengerAPI & Record<string, ReturnType<typeof vi.fn>>;
}

const local = {
  uri: "file:///voice.m4a",
  name: "voice.m4a",
  mime: "audio/mp4",
  size: 120,
};
const busy = () => new APIError(503, "voice_check_busy", "busy", {}, 5);
const sleep = vi.fn().mockResolvedValue(undefined);

describe("uploadFile", () => {
  beforeEach(() => {
    transfers.answers = {};
    transfers.sent = [];
    sleep.mockClear();
  });

  it("repeats complete on 503/429 after Retry-After without aborting", async () => {
    const complete = vi
      .fn()
      .mockRejectedValueOnce(busy())
      .mockRejectedValueOnce(
        new APIError(429, "voice_check_in_progress", "", {}, 2),
      )
      .mockResolvedValue({ id: "voice" });
    const api = fakeAPI("presigned", complete);
    await expect(
      uploadFile(api, local, new AbortController().signal, () => undefined, {
        sleep,
      }),
    ).resolves.toEqual({ id: "voice" });
    expect(sleep.mock.calls.map((call) => call[0])).toEqual([5000, 2000]);
    expect(api.abortFileUpload).not.toHaveBeenCalled();
  });

  it("keeps the upload when complete stays busy and aborts on a final error", async () => {
    const stuck = fakeAPI("presigned", () => Promise.reject(busy()));
    await expect(
      uploadFile(stuck, local, new AbortController().signal, () => undefined, {
        sleep,
        attempts: 3,
      }),
    ).rejects.toMatchObject({ status: 503 });
    expect(stuck.completeFileUpload).toHaveBeenCalledTimes(3);
    expect(stuck.abortFileUpload).not.toHaveBeenCalled();

    const rejected = fakeAPI("presigned", () =>
      Promise.reject(new APIError(422, "validation_failed", "not a recording")),
    );
    await expect(
      uploadFile(
        rejected,
        local,
        new AbortController().signal,
        () => undefined,
        { sleep },
      ),
    ).rejects.toMatchObject({ status: 422 });
    expect(rejected.abortFileUpload).toHaveBeenCalledWith("upload-1");
  });

  it("re-signs a multipart part after 403 and completes", async () => {
    transfers.answers["https://s3.test/part-2?signed=0"] = [{ status: 403 }];
    const api = fakeAPI("multipart", () => Promise.resolve({ id: "big" }));
    const big = { ...local, size: 6 * 1024 * 1024 };
    await expect(
      uploadFile(api, big, new AbortController().signal, () => undefined, {
        sleep,
      }),
    ).resolves.toEqual({ id: "big" });
    expect(transfers.sent).toEqual([
      "https://s3.test/part-1?signed=0",
      "https://s3.test/part-2?signed=0",
      "https://s3.test/part-2?signed=1",
    ]);
    expect(api.signFileUploadParts).toHaveBeenLastCalledWith("upload-1", [2]);
    expect(api.abortFileUpload).not.toHaveBeenCalled();
  });
});
