import { create } from "zustand";
import type { FileMetadata, MessengerAPI } from "@comamessenger/core";
import { recordLocalMedia, recordMediaFacts } from "@/media/facts";
import { mediaKind } from "@/media/items";
import { adoptProbe, probeVideo } from "@/media/probe";
import { uploadFile, type LocalFile } from "./upload";

/**
 * Uploads of picked files, kept outside the composer: a message sent while
 * its video is still uploading takes the upload along (its bubble shows the
 * progress), clearing the composer does not stop it. Removing a file from
 * the composer or cancelling the sending bubble aborts it.
 */
export type UploadJob = {
  id: string;
  local: LocalFile;
  status: "uploading" | "ready" | "failed";
  progress: number;
  file?: FileMetadata;
  /** Chat (or `chat:thread`) the file goes to: the header there says so. */
  scope?: string;
};

export const useUploadJobs = create<{ jobs: Record<string, UploadJob> }>(
  () => ({ jobs: {} }),
);

const controllers = new Map<string, AbortController>();

function patch(id: string, change: Partial<UploadJob>) {
  useUploadJobs.setState((state) => {
    const job = state.jobs[id];
    return job
      ? { jobs: { ...state.jobs, [id]: { ...job, ...change } } }
      : state;
  });
}

function run(api: MessengerAPI, id: string) {
  const job = useUploadJobs.getState().jobs[id];
  if (!job) return;
  controllers.get(id)?.abort();
  const controller = new AbortController();
  controllers.set(id, controller);
  patch(id, { status: "uploading", progress: 0 });
  void uploadFile(api, job.local, controller.signal, (progress) =>
    patch(id, { progress }),
  )
    .then((file) => {
      // What the phone knows about the picked file goes to the uploaded one:
      // the sent bubble has its size, poster and length at once.
      recordLocalMedia(file.id, job.local.uri);
      if (job.local.width && job.local.height)
        recordMediaFacts(file.id, {
          aspect: job.local.width / job.local.height,
        });
      if (job.local.durationMs)
        recordMediaFacts(file.id, { durationMs: job.local.durationMs });
      adoptProbe(id, file.id);
      patch(id, { status: "ready", progress: 1, file });
    })
    .catch(() => {
      if (!controller.signal.aborted) patch(id, { status: "failed" });
    })
    .finally(() => {
      if (controllers.get(id) === controller) controllers.delete(id);
    });
}

export function startUpload(
  api: MessengerAPI,
  local: LocalFile,
  scope?: string,
): string {
  const id = crypto.randomUUID();
  useUploadJobs.setState((state) => ({
    jobs: {
      ...state.jobs,
      [id]: {
        id,
        local,
        status: "uploading",
        progress: 0,
        ...(scope ? { scope } : {}),
      },
    },
  }));
  if (local.width && local.height)
    recordMediaFacts(id, { aspect: local.width / local.height });
  if (local.durationMs) recordMediaFacts(id, { durationMs: local.durationMs });
  if (mediaKind(local) === "video") void probeVideo(id, { uri: local.uri });
  run(api, id);
  return id;
}

export function retryUpload(api: MessengerAPI, id: string) {
  const job = useUploadJobs.getState().jobs[id];
  if (job && job.status === "failed") run(api, id);
}

/** Stops the upload (the server drops what was sent) and forgets it. */
export function cancelUpload(id: string) {
  controllers.get(id)?.abort();
  controllers.delete(id);
  useUploadJobs.setState((state) => {
    const { [id]: _gone, ...jobs } = state.jobs;
    return { jobs };
  });
}

/** Forgets finished jobs once their message has taken the files. */
export function forgetUploads(ids: readonly string[]) {
  useUploadJobs.setState((state) => {
    const jobs = { ...state.jobs };
    for (const id of ids) if (jobs[id]?.status !== "uploading") delete jobs[id];
    return { jobs };
  });
}

/** Sign-out: nothing keeps uploading for the account that left. */
export function cancelAllUploads() {
  for (const controller of controllers.values()) controller.abort();
  controllers.clear();
  useUploadJobs.setState({ jobs: {} });
}
