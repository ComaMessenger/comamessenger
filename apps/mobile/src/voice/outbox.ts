import { useMemo } from "react";
import { AppState } from "react-native";
import { create } from "zustand";
import type { StoreApi } from "zustand";
import { Directory, File, Paths } from "expo-file-system";
import {
  VOICE_MAX_BYTES,
  VOICE_MIME,
  voiceWaveform,
  type FileMetadata,
  type MessengerAPI,
  type MessengerState,
  type Outbox,
} from "@comamessenger/core";
import { uploadFile } from "@/files/upload";
import { adoptRecording, clearVoiceCache } from "./cache";
import { declaredDuration, voiceFailure, type VoiceFailure } from "./model";

/**
 * Outgoing voice messages until their file is uploaded. A recording is moved
 * out of the recorder's cache into the app's documents right away, with a
 * small JSON next to it, so a dropped network, a closed app or a server busy
 * checking voice never loses it: the row stays in the chat with «Retry»
 * and «Delete». Once uploaded, the message goes to the regular outbox
 * (packages/core), which owns retries of the message itself, and the
 * recording becomes the session cache copy of its file.
 *
 * Uploads run one at a time in the order recorded, so messages keep their
 * order and the server's one-check-per-sender rule is not hit by ourselves.
 */

export type VoiceOutboxStatus = "sending" | VoiceFailure;

export type VoiceOutboxItem = {
  id: string;
  userID: string;
  chatID: string;
  threadRootID: string | null;
  replyToID: string | null;
  durationMs: number;
  waveform: number[];
  size: number;
  createdAt: string;
  status: VoiceOutboxStatus;
  progress: number;
};

export type VoiceSender = {
  api: MessengerAPI;
  outbox: Outbox;
  store: StoreApi<MessengerState>;
  userID: string;
};

const useOutboxStore = create<{ items: Record<string, VoiceOutboxItem> }>(
  () => ({ items: {} }),
);

export function useVoiceOutbox(chatID: string, threadRootID: string | null) {
  const items = useOutboxStore((state) => state.items);
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

const folder = () => new Directory(Paths.document, "voice-outbox");
const audioFile = (id: string) => new File(folder(), `${id}.m4a`);
const metaFile = (id: string) => new File(folder(), `${id}.json`);

function patch(id: string, change: Partial<VoiceOutboxItem>) {
  useOutboxStore.setState((state) => {
    const item = state.items[id];
    return item
      ? { items: { ...state.items, [id]: { ...item, ...change } } }
      : state;
  });
}

function save(item: VoiceOutboxItem) {
  // Progress and the transient status are not worth a disk write each tick.
  const { progress: _progress, ...stored } = item;
  metaFile(item.id).write(JSON.stringify(stored));
}

function forget(id: string) {
  controllers.get(id)?.abort();
  controllers.delete(id);
  for (const file of [audioFile(id), metaFile(id)])
    try {
      if (file.exists) file.delete();
    } catch {
      // Removed already.
    }
  useOutboxStore.setState((state) => {
    const { [id]: _gone, ...items } = state.items;
    return { items };
  });
}

const controllers = new Map<string, AbortController>();
let queue: Promise<void> = Promise.resolve();
let sender: VoiceSender | null = null;
let hydratedFor: string | null = null;

/** Keeps a finished take and starts sending it. */
export function queueVoice(
  deps: VoiceSender,
  take: {
    uri: string;
    durationMs: number;
    /** dBFS readings collected while recording. */
    levels: readonly number[];
    chatID: string;
    threadRootID: string | null;
    replyToID: string | null;
  },
) {
  sender = deps;
  const directory = folder();
  if (!directory.exists) directory.create({ intermediates: true });
  const id = crypto.randomUUID();
  const recording = new File(take.uri);
  recording.moveSync(audioFile(id));
  const item: VoiceOutboxItem = {
    id,
    userID: deps.userID,
    chatID: take.chatID,
    threadRootID: take.threadRootID,
    replyToID: take.replyToID,
    durationMs: declaredDuration(take.durationMs),
    waveform: voiceWaveform(take.levels, { decibels: true }),
    size: audioFile(id).size ?? 0,
    createdAt: new Date().toISOString(),
    status: "sending",
    progress: 0,
  };
  save(item);
  useOutboxStore.setState((state) => ({
    items: { ...state.items, [id]: item },
  }));
  schedule(id);
}

function schedule(id: string) {
  if (controllers.has(id)) return;
  patch(id, { status: "sending", progress: 0 });
  queue = queue.then(() => send(id)).catch(() => undefined);
}

async function send(id: string) {
  const item = useOutboxStore.getState().items[id];
  const deps = sender;
  // Already uploading (a manual retry raced the return to the foreground).
  if (!item || !deps || item.status !== "sending" || controllers.has(id))
    return;
  if (item.userID !== deps.userID) {
    forget(id);
    return;
  }
  const controller = new AbortController();
  controllers.set(id, controller);
  let file: FileMetadata;
  try {
    if (item.size > VOICE_MAX_BYTES) throw new RangeError("voice too large");
    file = await uploadFile(
      deps.api,
      {
        uri: audioFile(id).uri,
        name: "voice.m4a",
        mime: VOICE_MIME,
        size: item.size,
      },
      controller.signal,
      (progress) => patch(id, { progress }),
      {},
      { duration_ms: item.durationMs, waveform: item.waveform },
    );
  } catch (error) {
    controllers.delete(id);
    if (controller.signal.aborted) return;
    patch(id, {
      status: error instanceof RangeError ? "rejected" : voiceFailure(error),
    });
    return;
  }
  controllers.delete(id);
  if (!useOutboxStore.getState().items[id]) return;
  showFileWhileSending(deps.store, item, file);
  const message = deps.outbox.enqueue(item.chatID, {
    client_msg_id: item.id,
    body: "",
    body_format: "plain",
    reply_to_id: item.replyToID ?? undefined,
    thread_root_id: item.threadRootID ?? undefined,
    file_ids: [file.id],
  });
  // The message is in the persistent outbox once enqueue stored it; the
  // recording becomes the cached copy of the file for playback.
  const recording = audioFile(id);
  if (recording.exists) adoptRecording(file.id, recording.uri);
  forget(id);
  await message.catch(() => undefined);
}

/**
 * The regular outbox shows a sending message without files; the voice is
 * filled in as soon as that placeholder appears.
 */
function showFileWhileSending(
  store: StoreApi<MessengerState>,
  item: VoiceOutboxItem,
  file: FileMetadata,
) {
  const unsubscribe = store.subscribe((state) => {
    const pending = state.messages[item.chatID]?.find(
      (message) =>
        message.client_msg_id === item.id &&
        message.delivery !== undefined &&
        message.delivery !== "sent",
    );
    if (!pending) return;
    stop();
    if (!pending.files?.length) state.optimistic({ ...pending, files: [file] });
  });
  const timer = setTimeout(() => stop(), 15_000);
  function stop() {
    clearTimeout(timer);
    unsubscribe();
  }
}

export function retryVoice(id: string) {
  const item = useOutboxStore.getState().items[id];
  if (item && item.status !== "sending") schedule(id);
}

export function deleteVoice(id: string) {
  forget(id);
}

/**
 * Loads takes left from an earlier run for the signed-in account and tries
 * them again; takes of another account are deleted.
 */
export function hydrateVoiceOutbox(deps: VoiceSender) {
  sender = deps;
  if (hydratedFor === deps.userID) return;
  hydratedFor = deps.userID;
  const directory = folder();
  if (!directory.exists) return;
  for (const entry of directory.list()) {
    if (!(entry instanceof File) || !entry.name.endsWith(".json")) continue;
    const id = entry.name.slice(0, -".json".length);
    if (useOutboxStore.getState().items[id]) continue;
    try {
      const stored = JSON.parse(entry.textSync()) as VoiceOutboxItem;
      if (stored.userID !== deps.userID || !audioFile(id).exists) {
        forget(id);
        continue;
      }
      const status = stored.status === "rejected" ? "rejected" : "offline";
      useOutboxStore.setState((state) => ({
        items: { ...state.items, [id]: { ...stored, status, progress: 0 } },
      }));
      if (status === "offline") schedule(id);
    } catch {
      forget(id);
    }
  }
}

// Back in the foreground: what failed for lack of network is tried again.
AppState.addEventListener("change", (state) => {
  if (state !== "active") return;
  for (const item of Object.values(useOutboxStore.getState().items))
    if (item.status === "offline") schedule(item.id);
});

/** Sign-out: queued takes and cached recordings belong to the account. */
export function clearVoiceData() {
  for (const controller of controllers.values()) controller.abort();
  controllers.clear();
  useOutboxStore.setState({ items: {} });
  hydratedFor = null;
  sender = null;
  try {
    const directory = folder();
    if (directory.exists) directory.delete();
  } catch {
    // Nothing queued.
  }
  clearVoiceCache();
}
