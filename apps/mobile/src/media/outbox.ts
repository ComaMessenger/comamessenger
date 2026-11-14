import { useMemo } from "react";
import { create } from "zustand";
import type { FileMetadata } from "@comamessenger/core";
import { cancelUpload, forgetUploads, useUploadJobs } from "@/files/uploadJobs";

/**
 * Messages sent while their photos or videos were still uploading. The
 * message is a bubble in the feed at once, with the progress of each file
 * and a cancel button; when every file is up it goes to the regular outbox
 * (packages/core) as any other message. Cancelling stops the uploads.
 */
export type MediaSend = {
  id: string;
  chatID: string;
  threadRootID: string | null;
  body: string;
  jobIDs: string[];
  createdAt: string;
};

type Deliver = (files: FileMetadata[]) => Promise<void>;

const useMediaSends = create<{ items: Record<string, MediaSend> }>(() => ({
  items: {},
}));
const deliveries = new Map<string, Deliver>();
const delivering = new Set<string>();

export function queueMediaSend(
  item: Omit<MediaSend, "id" | "createdAt">,
  deliver: Deliver,
) {
  const id = crypto.randomUUID();
  deliveries.set(id, deliver);
  useMediaSends.setState((state) => ({
    items: {
      ...state.items,
      [id]: { ...item, id, createdAt: new Date().toISOString() },
    },
  }));
  check(id);
  return id;
}

function check(id: string) {
  const item = useMediaSends.getState().items[id];
  const deliver = deliveries.get(id);
  if (!item || !deliver || delivering.has(id)) return;
  const jobs = item.jobIDs.map((jobID) => useUploadJobs.getState().jobs[jobID]);
  if (jobs.some((job) => !job || job.status !== "ready" || !job.file)) return;
  delivering.add(id);
  const files = jobs.map((job) => job!.file!);
  void deliver(files)
    .catch(() => undefined)
    .finally(() => {
      delivering.delete(id);
      forget(id);
      forgetUploads(item.jobIDs);
    });
}

function forget(id: string) {
  deliveries.delete(id);
  useMediaSends.setState((state) => {
    const { [id]: _gone, ...items } = state.items;
    return { items };
  });
}

// Every finished upload may complete a waiting message.
useUploadJobs.subscribe(() => {
  for (const id of Object.keys(useMediaSends.getState().items)) check(id);
});

/** Cancel: stops the uploads; nothing is sent. */
export function cancelMediaSend(id: string) {
  const item = useMediaSends.getState().items[id];
  if (!item || delivering.has(id)) return;
  for (const jobID of item.jobIDs) cancelUpload(jobID);
  forget(id);
}

export function useMediaSendsIn(chatID: string, threadRootID: string | null) {
  const items = useMediaSends((state) => state.items);
  return useMemo(
    () =>
      Object.values(items)
        .filter(
          (item) =>
            item.chatID === chatID && item.threadRootID === threadRootID,
        )
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [chatID, items, threadRootID],
  );
}

/** Sign-out. */
export function clearMediaSends() {
  deliveries.clear();
  delivering.clear();
  useMediaSends.setState({ items: {} });
}
