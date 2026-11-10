import { useCallback, useRef, useState } from "react";
import type { FileMetadata, MessengerAPI } from "@comamessenger/core";
import { uploadFile, type LocalFile } from "./upload";

export const attachmentLimit = 10;

export type Attachment = {
  id: string;
  local: LocalFile;
  status: "uploading" | "ready" | "failed";
  progress: number;
  file?: FileMetadata;
};

/** Files attached in the composer, uploaded as soon as they are picked. */
export function useAttachments(api: MessengerAPI) {
  const [items, setItems] = useState<Attachment[]>([]);
  const controllers = useRef(new Map<string, AbortController>());

  const patch = useCallback((id: string, change: Partial<Attachment>) => {
    setItems((current) =>
      current.map((item) => (item.id === id ? { ...item, ...change } : item)),
    );
  }, []);

  const start = useCallback(
    (id: string, local: LocalFile) => {
      const controller = new AbortController();
      controllers.current.set(id, controller);
      patch(id, { status: "uploading", progress: 0 });
      void uploadFile(api, local, controller.signal, (progress) =>
        patch(id, { progress }),
      )
        .then((file) => patch(id, { status: "ready", progress: 1, file }))
        .catch(() => {
          if (!controller.signal.aborted) patch(id, { status: "failed" });
        })
        .finally(() => controllers.current.delete(id));
    },
    [api, patch],
  );

  /** Adds files up to the limit; returns how many did not fit. */
  const add = useCallback(
    (files: LocalFile[]) => {
      const room = Math.max(0, attachmentLimit - items.length);
      const accepted = files.slice(0, room).map((local) => ({
        id: crypto.randomUUID(),
        local,
        status: "uploading" as const,
        progress: 0,
      }));
      setItems((current) => [...current, ...accepted]);
      for (const item of accepted) start(item.id, item.local);
      return files.length - accepted.length;
    },
    [items.length, start],
  );

  const remove = useCallback((id: string) => {
    controllers.current.get(id)?.abort();
    setItems((current) => current.filter((item) => item.id !== id));
  }, []);

  const retry = useCallback(
    (id: string) => {
      const item = items.find((candidate) => candidate.id === id);
      if (item) start(id, item.local);
    },
    [items, start],
  );

  const reset = useCallback(() => setItems([]), []);

  return {
    items,
    add,
    remove,
    retry,
    reset,
    ready: items
      .filter((item) => item.status === "ready" && item.file)
      .map((item) => item.file!),
    uploading: items.some((item) => item.status === "uploading"),
  };
}
