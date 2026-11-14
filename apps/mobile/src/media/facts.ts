import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import Storage from "expo-sqlite/kv-store";
import type { VideoThumbnail } from "expo-video";

/**
 * What the phone learned about a photo or video that the server does not
 * say (the contract has no size or length): its proportions, so the bubble
 * is drawn at the right size from the first frame next time, and a video's
 * length. Kept on disk by file id; the poster frame of a video stays in
 * memory for the session.
 */
export type MediaFacts = { aspect?: number; durationMs?: number };

const prefix = "media-facts:";

type FactsState = {
  facts: Record<string, MediaFacts>;
  posters: Record<string, VideoThumbnail | string>;
  /** Local files picked on this phone, by the id of their uploaded file. */
  local: Record<string, string>;
};

const useFacts = create<FactsState>(() => ({
  facts: {},
  posters: {},
  local: {},
}));

// Disk reads, once per file and session (read while rendering, so no
// state update here).
const disk = new Map<string, MediaFacts>();
const none: MediaFacts = {};

function stored(id: string): MediaFacts {
  const cached = disk.get(id);
  if (cached) return cached;
  let value = none;
  try {
    const raw = Storage.getItemSync(prefix + id);
    if (raw) value = JSON.parse(raw) as MediaFacts;
  } catch {
    // Unknown: drawn at a default size until it loads.
  }
  disk.set(id, value);
  return value;
}

export function mediaFacts(id: string): MediaFacts {
  return useFacts.getState().facts[id] ?? stored(id);
}

export function recordMediaFacts(id: string, change: MediaFacts) {
  const current = mediaFacts(id);
  const next = { ...current, ...change };
  if (next.aspect === current.aspect && next.durationMs === current.durationMs)
    return;
  useFacts.setState((state) => ({ facts: { ...state.facts, [id]: next } }));
  try {
    Storage.setItemSync(prefix + id, JSON.stringify(next));
  } catch {
    // Only a size hint; the bubble resizes once the image loads.
  }
}

export function useMediaFacts(id: string): MediaFacts {
  const facts = useFacts((state) => state.facts[id]);
  return facts ?? stored(id);
}

export function recordPoster(id: string, poster: VideoThumbnail | string) {
  useFacts.setState((state) => ({
    posters: { ...state.posters, [id]: poster },
  }));
}

export function usePoster(id: string) {
  return useFacts((state) => state.posters[id] ?? null);
}

export function posterOf(id: string) {
  return useFacts.getState().posters[id] ?? null;
}

/** The picked file stands in for the uploaded one until it is downloaded. */
export function recordLocalMedia(id: string, uri: string) {
  useFacts.setState((state) => ({ local: { ...state.local, [id]: uri } }));
}

export function useLocalMedia(id: string) {
  return useFacts((state) => state.local[id] ?? null);
}

/** Sign-out: what was learned about the account's files goes too. */
export function clearMediaFacts() {
  useFacts.setState({ facts: {}, posters: {}, local: {} });
  disk.clear();
  try {
    for (const key of Storage.getAllKeysSync())
      if (key.startsWith(prefix)) Storage.removeItemSync(key);
  } catch {
    // Nothing stored.
  }
}

/** Proportions of several files at once, for one message's mosaic. */
export function useAspects(ids: readonly string[]): (number | undefined)[] {
  return useFacts(
    useShallow((state) =>
      ids.map((id) => (state.facts[id] ?? stored(id)).aspect),
    ),
  );
}
