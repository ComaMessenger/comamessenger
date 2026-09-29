import { File, Paths, UploadType } from "expo-file-system";
import type {
  CompletedFilePart,
  FileMetadata,
  MessengerAPI,
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

/**
 * Uploads a picked file from its local URI through whichever mode the
 * instance chose: streaming to Core, a presigned PUT, or S3 multipart parts.
 * Mirrors apps/web/src/uploads.ts without loading the file into memory.
 */
export async function uploadFile(
  api: MessengerAPI,
  local: LocalFile,
  signal: AbortSignal,
  onProgress: Progress,
): Promise<FileMetadata> {
  let uploadID = "";
  try {
    const upload = await api.createFileUpload({
      name: local.name,
      mime: local.mime,
      size: local.size,
    });
    uploadID = upload.id;
    const source = new File(local.uri);
    const contentType = { "Content-Type": local.mime };
    if (upload.mode === "streaming") {
      const target = absoluteURL(
        api,
        upload.upload_url ?? `/api/v1/files/uploads/${upload.id}/content`,
      );
      const result = await withAuthorization(api, (authorization) =>
        put(
          source,
          target,
          { ...contentType, Authorization: authorization },
          signal,
          onProgress,
        ),
      );
      if (result.status < 200 || result.status >= 300)
        throw new Error(`Upload failed with HTTP ${result.status}.`);
      return JSON.parse(result.body) as FileMetadata;
    }
    if (upload.mode === "presigned") {
      if (!upload.upload_url) throw new Error("Upload URL is missing.");
      const result = await put(
        source,
        upload.upload_url,
        contentType,
        signal,
        onProgress,
      );
      if (result.status < 200 || result.status >= 300)
        throw new Error(`Upload failed with HTTP ${result.status}.`);
      return api.completeFileUpload(upload.id);
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
            const result = await put(
              chunk,
              part.url,
              contentType,
              signal,
              (value) =>
                onProgress(
                  Math.min(1, (start + value * bytes.length) / local.size),
                ),
            );
            const etag = header(result.headers, "etag");
            if (result.status < 200 || result.status >= 300 || !etag)
              throw new Error(`Part upload failed with HTTP ${result.status}.`);
            completed.push({ number: part.number, etag, size: bytes.length });
          } finally {
            chunk.delete();
          }
        }
      }
    } finally {
      handle.close();
    }
    return api.completeFileUpload(upload.id, completed);
  } catch (cause) {
    if (uploadID) await api.abortFileUpload(uploadID).catch(() => undefined);
    throw cause;
  }
}
