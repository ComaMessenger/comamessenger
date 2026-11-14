/** A file being uploaded, as far as a progress bar cares. */
export type ProgressJob = {
  status: "uploading" | "ready" | "failed";
  progress: number;
  local: { size: number };
};

/**
 * Upload state of a message waiting for its files: progress weighted by
 * size (a big video counts more than a photo) and whether any failed.
 */
export function sendProgress(jobs: readonly (ProgressJob | undefined)[]) {
  const present = jobs.filter((job): job is ProgressJob => Boolean(job));
  const total = present.reduce((sum, job) => sum + job.local.size, 0);
  const sent = present.reduce(
    (sum, job) =>
      sum + job.local.size * (job.status === "ready" ? 1 : job.progress),
    0,
  );
  return {
    progress: total > 0 ? Math.min(1, sent / total) : 0,
    failed: present.some((job) => job.status === "failed"),
    ready: present.length > 0 && present.every((job) => job.status === "ready"),
  };
}

/** Largest file the server takes by default (FILE_MAX_BYTES, 100 MiB). */
export const fileMaxBytes = 100 * 1024 * 1024;

/** Picked files that fit, and how many were too big to send. */
export function withinFileLimit<T extends { size: number }>(
  files: readonly T[],
  limit = fileMaxBytes,
) {
  const accepted = files.filter((file) => file.size <= limit);
  return { accepted, tooLarge: files.length - accepted.length };
}
