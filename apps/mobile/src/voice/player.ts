import { AppState } from "react-native";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import {
  createAudioPlayer,
  type AudioPlayer,
  type AudioStatus,
} from "expo-audio";
import { nextVoicePlaybackRate } from "@comamessenger/core";
import { enterPlaybackMode, leavePlaybackMode } from "./audioSession";

/** Something the shared player can play: a voice file or a take in review. */
export type VoiceTrack = {
  key: string;
  durationMs: number;
  /** Local URI to play; downloads on first use. */
  resolve(): Promise<string>;
  /** What to play after this one ends (the next voice message in the feed). */
  next?(): VoiceTrack | null;
};

type PlayerStatus = "idle" | "loading" | "playing" | "paused";

type PlayerState = {
  key: string | null;
  status: PlayerStatus;
  /** Seconds. */
  position: number;
  duration: number;
  /** Shared by all voice messages, as long as the app runs. */
  rate: number;
  /** Keys whose file could not be loaded or played. */
  failed: Record<string, true>;
};

const usePlayerStore = create<PlayerState>(() => ({
  key: null,
  status: "idle",
  position: 0,
  duration: 0,
  rate: 1,
  failed: {},
}));

/**
 * One native player for the whole app, so only one recording plays at a
 * time: starting another replaces the source. Leaving the foreground pauses.
 */
let player: AudioPlayer | null = null;
let current: VoiceTrack | null = null;
let ticket = 0;

function withoutFailure(key: string) {
  const { [key]: _gone, ...rest } = usePlayerStore.getState().failed;
  return rest;
}

function fail(key: string) {
  player?.pause();
  leavePlaybackMode();
  current = null;
  usePlayerStore.setState((state) => ({
    key: null,
    status: "idle",
    position: 0,
    failed: { ...state.failed, [key]: true },
  }));
}

function finished() {
  const ended = current;
  current = null;
  usePlayerStore.setState({ key: null, status: "idle", position: 0 });
  const next = ended?.next?.();
  if (next) void playVoice(next);
  else leavePlaybackMode();
}

function onStatus(status: AudioStatus) {
  const state = usePlayerStore.getState();
  if (!current || state.key !== current.key) return;
  if (status.error) {
    fail(current.key);
    return;
  }
  if (status.didJustFinish) {
    finished();
    return;
  }
  usePlayerStore.setState({
    position: status.currentTime,
    duration:
      Number.isFinite(status.duration) && status.duration > 0
        ? status.duration
        : state.duration,
    // A call, unplugged headphones or the system pause the player natively.
    status: status.playing
      ? "playing"
      : state.status === "loading"
        ? "loading"
        : "paused",
  });
}

function ensurePlayer(): AudioPlayer {
  if (player) return player;
  player = createAudioPlayer(null, {
    updateInterval: 100,
    keepAudioSessionActive: true,
  });
  player.addListener("playbackStatusUpdate", onStatus);
  AppState.addEventListener("change", (next) => {
    if (next !== "active") pauseVoice();
  });
  return player;
}

export async function playVoice(track: VoiceTrack, startAt = 0) {
  const mine = ++ticket;
  current = track;
  usePlayerStore.setState({
    key: track.key,
    status: "loading",
    position: startAt,
    duration: track.durationMs / 1000,
    failed: withoutFailure(track.key),
  });
  try {
    const uri = await track.resolve();
    if (mine !== ticket) return;
    await enterPlaybackMode();
    if (mine !== ticket) return;
    const native = ensurePlayer();
    native.replace({ uri });
    native.setPlaybackRate(usePlayerStore.getState().rate);
    native.play();
    if (startAt > 0) await native.seekTo(startAt);
  } catch {
    if (mine === ticket) fail(track.key);
  }
}

export function currentVoiceKey() {
  return usePlayerStore.getState().key;
}

export function pauseVoice() {
  if (!current) return;
  player?.pause();
  leavePlaybackMode();
  if (usePlayerStore.getState().status !== "idle")
    usePlayerStore.setState({ status: "paused" });
}

/**
 * Stops whatever plays, e.g. before recording or when a chat closes.
 * `release: false` keeps the audio session for the recorder taking over.
 */
export function stopVoice(key?: string, release = true) {
  if (key && usePlayerStore.getState().key !== key) return;
  ticket += 1;
  player?.pause();
  if (current && release) leavePlaybackMode();
  current = null;
  usePlayerStore.setState({ key: null, status: "idle", position: 0 });
}

export function toggleVoice(track: VoiceTrack) {
  const state = usePlayerStore.getState();
  if (state.key !== track.key) {
    void playVoice(track);
    return;
  }
  if (state.status === "playing") pauseVoice();
  else if (state.status === "paused" && player) {
    void enterPlaybackMode()
      .catch(() => undefined)
      .then(() => {
        player?.play();
        usePlayerStore.setState({ status: "playing" });
      });
  }
}

/** Seeks the current track, or starts `track` at `seconds`. */
export function seekVoice(track: VoiceTrack, seconds: number) {
  const state = usePlayerStore.getState();
  const total =
    state.key === track.key ? state.duration : track.durationMs / 1000;
  const target = Math.min(Math.max(0, seconds), Math.max(0, total - 0.05));
  if (state.key !== track.key || !player) {
    void playVoice(track, target);
    return;
  }
  usePlayerStore.setState({ position: target });
  void player.seekTo(target).catch(() => undefined);
}

export function cycleVoiceRate() {
  const rate = nextVoicePlaybackRate(usePlayerStore.getState().rate);
  usePlayerStore.setState({ rate });
  player?.setPlaybackRate(rate);
}

/** What one voice message shows: its own progress, or rest when another plays. */
export function useVoiceTrack(key: string) {
  return usePlayerStore(
    useShallow((state) => {
      const active = state.key === key;
      return {
        active,
        status: active ? state.status : ("idle" as PlayerStatus),
        position: active ? state.position : 0,
        duration: active ? state.duration : 0,
        rate: state.rate,
        failed: Boolean(state.failed[key]),
      };
    }),
  );
}
