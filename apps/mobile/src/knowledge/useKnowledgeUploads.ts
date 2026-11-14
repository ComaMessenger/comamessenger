import { useCallback, useEffect, useRef, useState } from "react";
import * as DocumentPicker from "expo-document-picker";
import {
  documentFormat,
  knowledgeDocumentMIMETypes,
  type KnowledgeUploadState,
} from "@comamessenger/core";
import { File } from "expo-file-system";
import { uploadFile, type LocalFile } from "@/files/upload";
import { messageOf } from "@/lib/errors";
import { useSignedIn } from "@/session/SessionProvider";
import { useInvalidateCollection } from "./queries";

export type KnowledgeUpload = {
  id: string;
  name: string;
  size: number;
  progress: number;
  state: KnowledgeUploadState;
  error?: string;
  /** Kept to send the same file again after a failure. */
  file: LocalFile;
};

/** Picks documents in the system file picker; only formats the indexer reads. */
export async function pickDocuments(): Promise<LocalFile[]> {
  const result = await DocumentPicker.getDocumentAsync({
    multiple: true,
    copyToCacheDirectory: true,
    type: [...knowledgeDocumentMIMETypes],
  });
  if (result.canceled) return [];
  return result.assets.map((asset) => ({
    uri: asset.uri,
    name: asset.name,
    mime: asset.mimeType ?? "application/octet-stream",
    size: asset.size && asset.size > 0 ? asset.size : new File(asset.uri).size,
  }));
}

/**
 * Uploads files into a collection, as on the web: bytes go through the
 * regular file upload (streaming, presigned or multipart) and the ready file
 * becomes a document. Finished items leave the queue — the document list
 * shows them from then on; a failed one can be sent again.
 */
export function useKnowledgeUploads(collectionID: string) {
  const { api } = useSignedIn();
  const invalidate = useInvalidateCollection();
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

  const send = useCallback(
    (id: string, file: LocalFile) => {
      const controller = new AbortController();
      controllers.current.set(id, controller);
      void (async () => {
        try {
          const uploaded = await uploadFile(
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
          await invalidate(collectionID);
        } catch (cause) {
          if (controller.signal.aborted) patch(id, { state: "cancelled" });
          else patch(id, { state: "failed", error: messageOf(cause) });
        } finally {
          controllers.current.delete(id);
        }
      })();
    },
    [api, collectionID, invalidate, patch],
  );

  const add = useCallback(
    (files: LocalFile[]) => {
      for (const file of files) {
        const id = crypto.randomUUID();
        const supported = documentFormat(file.name, file.mime) !== "";
        setItems((current) => [
          ...current,
          {
            id,
            name: file.name,
            size: file.size,
            progress: 0,
            state: supported ? "uploading" : "rejected",
            file,
          },
        ]);
        if (supported) send(id, file);
      }
    },
    [send],
  );

  const retry = useCallback(
    (id: string) => {
      const item = items.find((entry) => entry.id === id);
      if (!item || (item.state !== "failed" && item.state !== "cancelled"))
        return;
      patch(id, { state: "uploading", progress: 0, error: undefined });
      send(id, item.file);
    },
    [items, patch, send],
  );

  const cancel = useCallback((id: string) => {
    controllers.current.get(id)?.abort();
  }, []);

  const dismiss = useCallback((id: string) => {
    controllers.current.get(id)?.abort();
    setItems((current) => current.filter((item) => item.id !== id));
  }, []);

  return { items, add, retry, cancel, dismiss };
}
