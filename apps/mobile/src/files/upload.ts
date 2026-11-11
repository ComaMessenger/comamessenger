import { File, Paths, UploadType } from "expo-file-system";
import {
  UploadHTTPError,
  completeUploadWithRetry,
  parseRetryAfter,
  retryUploadStep,
  sendPartWithResign,
  shouldAbortUpload,
  type CompletedFilePart,
  type FileMetadata,
  type MessengerAPI,
  type UploadRetryOptions,
  type VoiceInfo,
} from "@comamessenger/core";
import { absoluteURL, withAuthorization } from "./auth";

export type LocalFile = {
  uri: string;
  name: string;
  mime: string;
  size: number;
};

const multipartPartBytes = 5 * 1024 * 1024;

type Progress = (value: number) => void;

function put(
  file: File,
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal,
  onProgress: Progress,
) {
  return file.upload(url, {
    httpMethod: "PUT",
    uploadType: UploadType.BINARY_CONTENT,
    headers,
    signal,
    onProgress: ({ bytesSent, totalBytes }) =>
      totalBytes > 0 && onProgress(bytesSent / totalBytes),
  });
}

function header(headers: Record<string, string>, name: string) {
  const key = Object.keys(headers).find((item) => item.toLowerCase() === name);
  return key ? headers[key] : undefined;
}

/** Throws UploadHTTPError (with Retry-After) for a non-2xx transfer. */
function ensureOK<
  T extends { status: number; headers: Record<string, string> },
>(result: T): T {
  if (result.status < 200 || result.status >= 300)
    throw new UploadHTTPError(
      result.status,
      parseRetryAfter(header(result.headers, "retry-after")),
    );
  return result;
}

/**
 * Uploads a picked file from its local URI through whichever mode the
 * instance chose: streaming to Core, a presigned PUT, or S3 multipart parts.
 * Mirrors apps/web/src/uploads.ts without loading the file into memory:
 * completion is retried on 429/503 after Retry-After, a part whose URL
 * expired is re-signed, and the upload is aborted (deleting what was sent)
 * only on a final error.
 */
export async function uploadFile(
  api: MessengerAPI,
  local: LocalFile,
  signal: AbortSignal,
  onProgress: Progress,
  retry: Omit<UploadRetryOptions, "signal"> = {},
  /** Marks the upload as a voice message (send `local.mime` = VOICE_MIME). */
  voice?: VoiceInfo,
): Promise<FileMetadata> {
  let uploadID = "";
  let completing = false;
  const retryOptions = { ...retry, signal };
  try {
    const upload = await api.createFileUpload({
      name: local.name,
      mime: local.mime,
      size: local.size,
      ...(voice ? { voice } : {}),
    });
    uploadID = upload.id;
    const source = new File(local.uri);
    const contentType = { "Content-Type": local.mime };
    if (upload.mode === "streaming") {
      const target = absoluteURL(
        api,
        upload.upload_url ?? `/api/v1/files/uploads/${upload.id}/content`,
      );
      // Streaming completes with the PUT itself; a busy server keeps the
      // upload open, so the content is sent again.
      completing = true;
      const result = await retryUploadStep(
        async () =>
          ensureOK(
            await withAuthorization(api, (authorization) =>
              put(
                source,
                target,
                { ...contentType, Authorization: authorization },
                signal,
                onProgress,
              ),
            ),
          ),
        retryOptions,
      );
      return JSON.parse(result.body) as FileMetadata;
    }
    if (upload.mode === "presigned") {
      if (!upload.upload_url) throw new Error("Upload URL is missing.");
      ensureOK(
        await put(source, upload.upload_url, contentType, signal, onProgress),
      );
      completing = true;
      return await completeUploadWithRetry(api, upload.id, [], retryOptions);
    }
    // Multipart: each part is copied to a temporary file so it can be sent
    // as a native upload with progress, then removed.
    const count = Math.ceil(local.size / multipartPartBytes);
    const completed: CompletedFilePart[] = [];
    const handle = source.open();
    try {
      for (let offset = 0; offset < count; offset += 100) {
        const numbers = Array.from(
          { length: Math.min(100, count - offset) },
          (_, index) => offset + index + 1,
        );
        const signed = await api.signFileUploadParts(upload.id, numbers);
        for (const part of signed.parts) {
          const start = (part.number - 1) * multipartPartBytes;
          handle.offset = start;
          const bytes = handle.readBytes(
            Math.min(multipartPartBytes, local.size - start),
          );
          const chunk = new File(
            Paths.cache,
            `upload-${upload.id}-${part.number}`,
          );
          chunk.write(bytes);
          try {
            const result = await sendPartWithResign(
              api,
              upload.id,
              part,
              async (url) =>
                ensureOK(
                  await put(chunk, url, contentType, signal, (value) =>
                    onProgress(
                      Math.min(1, (start + value * bytes.length) / local.size),
                    ),
                  ),
                ),
            );
            const etag = header(result.headers, "etag");
            if (!etag) throw new Error("Object storage did not expose ETag.");
            completed.push({ number: part.number, etag, size: bytes.length });
          } finally {
            chunk.delete();
          }
        }
      }
    } finally {
      handle.close();
    }
    completing = true;
    return await completeUploadWithRetry(
      api,
      upload.id,
      completed,
      retryOptions,
    );
  } catch (cause) {
    if (uploadID && shouldAbortUpload(cause, completing))
      await api.abortFileUpload(uploadID).catch(() => undefined);
    throw cause;
  }
}
