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
} from "@comamessenger/core";

const multipartPartBytes = 5 * 1024 * 1024;

/**
 * Uploads a file through the mode the instance chose. Completion is retried
 * on 429/503 after Retry-After; a part whose URL expired is re-signed. The
 * upload is aborted (deleting what was sent) only on a final error.
 */
export async function uploadAttachment(
  api: MessengerAPI,
  file: File,
  signal: AbortSignal,
  onProgress: (value: number) => void,
  retry: Omit<UploadRetryOptions, "signal"> = {},
): Promise<FileMetadata> {
  let uploadID = "";
  let completing = false;
  const retryOptions = { ...retry, signal };
  const contentType = file.type || "application/octet-stream";
  try {
    const upload = await api.createFileUpload({
      name: file.name,
      mime: contentType,
      size: file.size,
    });
    uploadID = upload.id;
    if (upload.mode === "streaming") {
      const target = new URL(
        upload.upload_url ?? `/api/v1/files/uploads/${upload.id}/content`,
        api.apiURL,
      ).toString();
      // Streaming completes with the PUT itself; a busy server keeps the
      // upload open, so the content is sent again.
      completing = true;
      const response = await retryUploadStep(
        () =>
          xhrUpload(
            target,
            file,
            contentType,
            api.token(),
            signal,
            onProgress,
          ),
        retryOptions,
      );
      return JSON.parse(response.body) as FileMetadata;
    }
    if (upload.mode === "presigned") {
      if (!upload.upload_url) throw new Error("Upload URL is missing.");
      await xhrUpload(
        upload.upload_url,
        file,
        contentType,
        null,
        signal,
        onProgress,
      );
      completing = true;
      return await completeUploadWithRetry(api, upload.id, [], retryOptions);
    }
    const count = Math.ceil(file.size / multipartPartBytes);
    const completed: CompletedFilePart[] = [];
    for (let offset = 0; offset < count; offset += 100) {
      const numbers = Array.from(
        { length: Math.min(100, count - offset) },
        (_, index) => offset + index + 1,
      );
      const signed = await api.signFileUploadParts(upload.id, numbers);
      for (const part of signed.parts) {
        const start = (part.number - 1) * multipartPartBytes;
        const chunk = file.slice(start, start + multipartPartBytes);
        const response = await sendPartWithResign(api, upload.id, part, (url) =>
          xhrUpload(url, chunk, contentType, null, signal, (partProgress) =>
            onProgress(
              Math.min(1, (start + partProgress * chunk.size) / file.size),
            ),
          ),
        );
        const etag = response.etag;
        if (!etag) throw new Error("Object storage did not expose ETag.");
        completed.push({ number: part.number, etag, size: chunk.size });
      }
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

function xhrUpload(
  url: string,
  body: Blob,
  contentType: string,
  token: string | null,
  signal: AbortSignal,
  onProgress: (value: number) => void,
): Promise<{ body: string; etag: string | null }> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    const abort = () => request.abort();
    request.open("PUT", url);
    request.setRequestHeader("Content-Type", contentType);
    if (token) request.setRequestHeader("Authorization", `Bearer ${token}`);
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    };
    request.onload = () => {
      signal.removeEventListener("abort", abort);
      if (request.status >= 200 && request.status < 300) {
        onProgress(1);
        resolve({
          body: request.responseText,
          etag: request.getResponseHeader("ETag"),
        });
      } else
        reject(
          new UploadHTTPError(
            request.status,
            parseRetryAfter(request.getResponseHeader("Retry-After")),
          ),
        );
    };
    request.onerror = () => reject(new TypeError("Upload connection failed."));
    request.onabort = () =>
      reject(new DOMException("Upload cancelled", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    else request.send(body);
  });
}
