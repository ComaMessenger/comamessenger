import {
  createVideoPlayer,
  type VideoPlayer,
  type VideoSource,
} from "expo-video";
import { posterOf, recordMediaFacts, recordPoster, mediaFacts } from "./facts";

/**
 * Poster frame, length and proportions of a video, learned on the phone:
 * the server makes previews of photos only (see docs/backlog.md). A muted
 * player loads the video, one at a time, takes a frame from its first
 * second and is released. A picked video is probed before it is sent, so
 * its own bubble is right at once.
 */

type Job = { id: string; source: VideoSource; resolve(ok: boolean): void };

const queue: Job[] = [];
const pending = new Map<string, Promise<boolean>>();
const failed = new Set<string>();
let running = false;

const timeoutMs = 15_000;

export function probeVideo(id: string, source: VideoSource): Promise<boolean> {
  if (posterOf(id) && mediaFacts(id).durationMs) return Promise.resolve(true);
  if (failed.has(id)) return Promise.resolve(false);
  const known = pending.get(id);
  if (known) return known;
  const promise = new Promise<boolean>((resolve) =>
    queue.push({ id, source, resolve }),
  ).finally(() => pending.delete(id));
  pending.set(id, promise);
  void next();
  return promise;
}

/** A failed probe may be tried again (the «Retry» on the tile). */
export function forgetProbeFailure(id: string) {
  failed.delete(id);
}

async function next() {
  if (running) return;
  const job = queue.shift();
  if (!job) return;
  running = true;
  let player: VideoPlayer | null = null;
  try {
    player = createVideoPlayer(null);
    player.muted = true;
    player.audioMixingMode = "mixWithOthers";
    const loaded = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
      const subscriptions = [
        player!.addListener("sourceLoad", (event) => {
          clearTimeout(timer);
          subscriptions.forEach((item) => item.remove());
          resolve(event.duration);
        }),
        player!.addListener("statusChange", (event) => {
          if (event.status !== "error") return;
          clearTimeout(timer);
          subscriptions.forEach((item) => item.remove());
          reject(new Error(event.error?.message ?? "video failed"));
        }),
      ];
      void player!.replaceAsync(job.source).catch(reject);
    });
    const duration = Number.isFinite(loaded) && loaded > 0 ? loaded : 0;
    const [frame] = await player.generateThumbnailsAsync(
      Math.min(1, duration / 2),
      { maxWidth: 720, maxHeight: 720 },
    );
    if (frame) {
      recordPoster(job.id, frame);
      if (frame.width > 0 && frame.height > 0)
        recordMediaFacts(job.id, { aspect: frame.width / frame.height });
    }
    if (duration > 0)
      recordMediaFacts(job.id, { durationMs: Math.round(duration * 1000) });
    job.resolve(true);
  } catch {
    failed.add(job.id);
    job.resolve(false);
  } finally {
    try {
      player?.release();
    } catch {
      // Released already.
    }
    running = false;
    void next();
  }
}

/** The facts of a picked file carry over to its uploaded id. */
export function adoptProbe(fromID: string, toID: string) {
  const poster = posterOf(fromID);
  if (poster) recordPoster(toID, poster);
  const facts = mediaFacts(fromID);
  if (facts.aspect || facts.durationMs) recordMediaFacts(toID, facts);
}
