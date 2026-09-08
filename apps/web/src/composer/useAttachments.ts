import { useCallback, useEffect, useRef, useState } from "react";
import type { FileMetadata, MessengerAPI } from "@comamessenger/core";
import { messageOf } from "../errors";
import { uploadAttachment } from "../uploads";

export const attachmentLimit = 10;

export type ComposerAttachment = {
  id: string;
  source: File;
  status: "uploading" | "ready" | "failed";
  progress: number;
  file?: FileMetadata;
  error?: string;
  controller: AbortController;
};

/** Upload queue of the composer: progress, retry and cancellation per file. */
export function useAttachments(api: MessengerAPI) {
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const latest = useRef(attachments);
  latest.current = attachments;

  const start = useCallback(
    (source: File, existingID: string = crypto.randomUUID()) => {
      const controller = new AbortController();
      const initial: ComposerAttachment = {
        id: existingID,
        source,
        status: "uploading",
        progress: 0,
        controller,
      };
      setAttachments((items) => [...items.filter((item) => item.id !== existingID), initial]);
      void uploadAttachment(api, source, controller.signal, (progress) =>
        setAttachments((items) =>
          items.map((item) => (item.id === existingID ? { ...item, progress } : item)),
        ),
      )
        .then((file) =>
          setAttachments((items) =>
            items.map((item) =>
              item.id === existingID ? { ...item, file, status: "ready", progress: 1 } : item,
            ),
          ),
        )
        .catch((cause) => {
          if (controller.signal.aborted) return;
          setAttachments((items) =>
            items.map((item) =>
              item.id === existingID
                ? { ...item, status: "failed", error: messageOf(cause) }
                : item,
            ),
          );
        });
    },
    [api],
  );

  const add = useCallback(
    (files: File[]) => {
      const available = Math.max(0, attachmentLimit - latest.current.length);
      files.slice(0, available).forEach((file) => start(file));
    },
    [start],
  );

  const cancel = useCallback((id: string) => {
    latest.current.find((item) => item.id === id)?.controller.abort();
    setAttachments((items) => items.filter((item) => item.id !== id));
  }, []);

  const retry = useCallback(
    (id: string) => {
      const target = latest.current.find((item) => item.id === id);
      if (target) start(target.source, id);
    },
    [start],
  );

  const reset = useCallback(() => {
    latest.current.forEach((item) => item.controller.abort());
    setAttachments([]);
  }, []);

  useEffect(() => () => latest.current.forEach((item) => item.controller.abort()), []);

  const ready = attachments.filter((item) => item.status === "ready" && item.file);
  const uploading = attachments.some((item) => item.status === "uploading");
  return { attachments, ready, uploading, add, cancel, retry, reset };
}
