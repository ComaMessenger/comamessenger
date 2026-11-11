import { APIError, type MessengerAPI } from "./api";
import type { CompletedFilePart, FileMetadata } from "./types";

export { parseRetryAfter } from "./retryAfter";

/** A non-2xx answer to an upload PUT (presigned, part or streaming). */
export class UploadHTTPError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(`Upload failed with HTTP ${status}.`);
    this.name = "UploadHTTPError";
  }
}

/**
 * Temporary failures worth repeating: the server keeps the upload open on
 * 429 and 503 (a voice check is busy, storage is unavailable), proxies
 * answer 502/504, and a dropped connection surfaces as a TypeError.
 */
export function isRetryableUploadError(error: unknown): boolean {
  if (error instanceof APIError || error instanceof UploadHTTPError)
    return [429, 502, 503, 504].includes(error.status);
  return error instanceof TypeError;
}

export type UploadRetryOptions = {
  /** Total tries, the first included. Default 6. */
  attempts?: number;
  /** Upper bound for one wait. Default 30 s. */
  maxDelayMs?: number;
  signal?: AbortSignal;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
};

function sleepFor(milliseconds: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("Upload cancelled"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", cancel);
      resolve();
    }, milliseconds);
    const cancel = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("Upload cancelled"));
    };
    signal?.addEventListener("abort", cancel, { once: true });
  });
}

/**
 * Repeats an upload step while it fails temporarily, waiting Retry-After
 * when the server gives one and backing off 1, 2, 4… s otherwise.
 */
export async function retryUploadStep<T>(
  step: () => Promise<T>,
  options: UploadRetryOptions = {},
): Promise<T> {
  const attempts = options.attempts ?? 6;
  const maxDelay = options.maxDelayMs ?? 30_000;
  const sleep = options.sleep ?? sleepFor;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await step();
    } catch (error) {
      if (
        !isRetryableUploadError(error) ||
        attempt >= attempts ||
        options.signal?.aborted
      )
        throw error;
      const hinted = (error as { retryAfterSeconds?: number })
        .retryAfterSeconds;
      const delay =
        hinted !== undefined ? hinted * 1000 : 1000 * 2 ** (attempt - 1);
      await sleep(Math.min(maxDelay, delay), options.signal);
    }
  }
}

/** Completes a presigned or multipart upload, retrying 429/503. */
export function completeUploadWithRetry(
  api: Pick<MessengerAPI, "completeFileUpload">,
  uploadID: string,
  parts: CompletedFilePart[] = [],
  options: UploadRetryOptions = {},
): Promise<FileMetadata> {
  return retryUploadStep(
    () => api.completeFileUpload(uploadID, parts),
    options,
  );
}

/**
 * Sends one multipart part, re-signing it when object storage answers 403
 * (its URL expired while earlier parts were uploading on a slow network).
 */
export async function sendPartWithResign<T>(
  api: Pick<MessengerAPI, "signFileUploadParts">,
  uploadID: string,
  part: { number: number; url: string },
  send: (url: string) => Promise<T>,
  maxResigns = 2,
): Promise<T> {
  let url = part.url;
  for (let resigned = 0; ; resigned += 1) {
    try {
      return await send(url);
    } catch (error) {
      if (
        !(error instanceof UploadHTTPError && error.status === 403) ||
        resigned >= maxResigns
      )
        throw error;
      const fresh = (await api.signFileUploadParts(uploadID, [part.number]))
        .parts[0];
      if (!fresh) throw error;
      url = fresh.url;
    }
  }
}

/**
 * Whether a failed upload should be aborted (which deletes what was sent).
 * A completion that failed temporarily stays open on the server, keeping the
 * uploaded object, and expires on its own; everything else is aborted.
 */
export function shouldAbortUpload(error: unknown, completing: boolean) {
  return !(completing && isRetryableUploadError(error));
}
