import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { KnowledgeUploadState, MessengerAPI } from "@comamessenger/core";
import { messageOf } from "../errors";
import { uploadAttachment } from "../uploads";
import { documentFormat } from "./format";
import { collectionKey, collectionsKey, documentsKey } from "./shared";

export type KnowledgeUpload = {
  id: string;
  name: string;
  size: number;
  progress: number;
  state: KnowledgeUploadState;
  error?: string;
};

/**
 * Uploads files into a collection: bytes go through the regular file upload
 * (streaming, presigned or multipart) and the ready file becomes a document.
 * Finished items leave the queue — the document list shows them from then on.
 */
export function useKnowledgeUploads(api: MessengerAPI, collectionID: string) {
  const client = useQueryClient();
  const [items, setItems] = useState<KnowledgeUpload[]>([]);
  const controllers = useRef(new Map<string, AbortController>());

  useEffect(() => {
    const active = controllers.current;
    return () => {
      for (const controller of active.values()) controller.abort();
      active.clear();
    };
  }, [collectionID]);

  const patch = useCallback((id: string, next: Partial<KnowledgeUpload>) => {
    setItems((current) =>
      current.map((item) => (item.id === id ? { ...item, ...next } : item)),
    );
  }, []);

  const add = useCallback(
    (files: Iterable<File>) => {
      for (const file of files) {
        const id = crypto.randomUUID();
        const supported = documentFormat(file.name, file.type) !== "";
        setItems((current) => [
          ...current,
          {
            id,
            name: file.name,
            size: file.size,
            progress: 0,
            state: supported ? "uploading" : "rejected",
          },
        ]);
        if (!supported) continue;
        const controller = new AbortController();
        controllers.current.set(id, controller);
        void (async () => {
          try {
            const uploaded = await uploadAttachment(
              api,
              file,
              controller.signal,
              (progress) => patch(id, { progress }),
            );
            if (controller.signal.aborted) return;
            patch(id, { state: "adding", progress: 1 });
            await api.createKnowledgeDocument(collectionID, {
              kind: "file",
              file_id: uploaded.id,
            });
            setItems((current) => current.filter((item) => item.id !== id));
            await Promise.all([
              client.invalidateQueries({ queryKey: documentsKey(collectionID) }),
              client.invalidateQueries({ queryKey: collectionKey(collectionID) }),
              client.invalidateQueries({ queryKey: collectionsKey }),
            ]);
          } catch (cause) {
            if (controller.signal.aborted)
              patch(id, { state: "cancelled" });
            else patch(id, { state: "failed", error: messageOf(cause) });
          } finally {
            controllers.current.delete(id);
          }
        })();
      }
    },
    [api, client, collectionID, patch],
  );

  const cancel = useCallback((id: string) => {
    controllers.current.get(id)?.abort();
  }, []);

  const dismiss = useCallback((id: string) => {
    controllers.current.get(id)?.abort();
    setItems((current) => current.filter((item) => item.id !== id));
  }, []);

  return { items, add, cancel, dismiss };
}
