import { useCallback, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import type { MessengerAPI } from "@comamessenger/core";
import type { LocalFile } from "./upload";
import {
  cancelUpload,
  retryUpload,
  startUpload,
  useUploadJobs,
  type UploadJob,
} from "./uploadJobs";

export const attachmentLimit = 10;

export type Attachment = UploadJob;

/**
 * Files attached in the composer, uploaded as soon as they are picked. The
 * uploads themselves live in `uploadJobs`: `detach` hands them to a message
 * being sent without stopping them.
 */
export function useAttachments(api: MessengerAPI) {
  const [ids, setIDs] = useState<string[]>([]);
  const jobs = useUploadJobs(
    useShallow((state) => ids.map((id) => state.jobs[id])),
  );
  const items = useMemo(
    () => jobs.filter((job): job is UploadJob => Boolean(job)),
    [jobs],
  );

  /** Adds files up to the limit; returns how many did not fit. */
  const add = useCallback(
    (files: LocalFile[]) => {
      const room = Math.max(0, attachmentLimit - ids.length);
      const accepted = files
        .slice(0, room)
        .map((local) => startUpload(api, local));
      setIDs((current) => [...current, ...accepted]);
      return files.length - accepted.length;
    },
    [api, ids.length],
  );

  const remove = useCallback((id: string) => {
    cancelUpload(id);
    setIDs((current) => current.filter((item) => item !== id));
  }, []);

  const retry = useCallback((id: string) => retryUpload(api, id), [api]);

  /** Empties the composer; the uploads go on for whoever took them. */
  const detach = useCallback(() => {
    const taken = items;
    setIDs([]);
    return taken;
  }, [items]);

  /** Empties the composer and stops what was still uploading. */
  const reset = useCallback(() => {
    for (const item of items)
      if (item.status !== "ready") cancelUpload(item.id);
    setIDs([]);
  }, [items]);

  return {
    items,
    add,
    remove,
    retry,
    detach,
    reset,
    ready: items
      .filter((item) => item.status === "ready" && item.file)
      .map((item) => item.file!),
    uploading: items.some((item) => item.status === "uploading"),
    failed: items.some((item) => item.status === "failed"),
  };
}
