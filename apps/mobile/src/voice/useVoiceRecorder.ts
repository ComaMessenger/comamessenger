import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AccessibilityInfo, Alert, AppState, Linking } from "react-native";
import * as Haptics from "expo-haptics";
import { File } from "expo-file-system";
import {
  AudioQuality,
  IOSOutputFormat,
  getRecordingPermissionsAsync,
  requestRecordingPermissionsAsync,
  useAudioRecorder,
  type RecordingOptions,
  type RecordingStatus,
} from "expo-audio";
import { create } from "zustand";
import { useTranslation } from "react-i18next";
import { useSignedIn } from "@/session/SessionProvider";
import { useMessenger } from "@/messenger/MessengerProvider";
import { enterRecordingMode, leaveRecordingMode } from "./audioSession";
import { queueVoice } from "./outbox";
import { stopVoice, type VoiceTrack } from "./player";
import {
  idlePhase,
  isRecording,
  recorderReducer,
  type RecorderEffect,
  type RecorderEvent,
  type RecorderPhase,
} from "./recording";

/** AAC in m4a, mono, 64 kbit/s: ten minutes stay under 5 MB. */
const voiceRecording: RecordingOptions = {
  extension: ".m4a",
  sampleRate: 44100,
  numberOfChannels: 1,
  bitRate: 64000,
  isMeteringEnabled: true,
  android: { extension: ".m4a", outputFormat: "mpeg4", audioEncoder: "aac" },
  ios: {
    extension: ".m4a",
    outputFormat: IOSOutputFormat.MPEG4AAC,
    audioQuality: AudioQuality.HIGH,
  },
  web: {},
};

const pollMs = 100;
const hintMs = 2200;

/** Length and levels of the take in progress; only the recording bar reads them. */
export const useRecordingMeter = create<{
  durationMs: number;
  levels: number[];
}>(() => ({ durationMs: 0, levels: [] }));

/** Where a finished take goes. */
export type VoiceTarget = {
  chatID: string;
  threadRootID: string | null;
  /** Message the voice answers, when the composer is replying. */
  replyToID: string | null;
  /** Called once the take is queued, e.g. to drop the reply bar. */
  onQueued?(): void;
};

export type VoiceRecorder = ReturnType<typeof useVoiceRecorder>;

type Take = { uri: string; durationMs: number; levels: number[] };

function deleteFile(uri: string | null | undefined) {
  if (!uri) return;
  try {
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch {
    // Already gone.
  }
}

/**
 * Recording in the composer: runs the state machine of ./recording against
 * the Expo recorder, the audio session, haptics and screen reader
 * announcements. Gestures call press/move/release; buttons call the rest.
 */
export function useVoiceRecorder(target: VoiceTarget | undefined) {
  const { t } = useTranslation();
  const { api, user } = useSignedIn();
  const { outbox, store } = useMessenger();
  const [phase, setPhase] = useState<RecorderPhase>(idlePhase);
  const [hint, setHint] = useState<string | null>(null);
  const phaseRef = useRef(phase);
  const targetRef = useRef(target);
  targetRef.current = target;
  const levels = useRef<number[]>([]);
  const lastDuration = useRef(0);
  const started = useRef(false);
  const wanted = useRef(false);
  const review = useRef<Take | null>(null);
  const [reviewTake, setReviewTake] = useState<Take | null>(null);
  const seenRecording = useRef(false);
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);
  const permission = useRef<"granted" | "ask" | "denied">("ask");

  const dispatchRef = useRef<(event: RecorderEvent) => void>(() => undefined);
  const recorder = useAudioRecorder(
    voiceRecording,
    useCallback((status: RecordingStatus) => {
      if (status.hasError || status.mediaServicesDidReset)
        dispatchRef.current({ type: "failed" });
    }, []),
  );

  useEffect(() => {
    void getRecordingPermissionsAsync()
      .then((answer) => {
        permission.current = answer.granted
          ? "granted"
          : answer.canAskAgain
            ? "ask"
            : "denied";
      })
      .catch(() => undefined);
  }, []);

  const showHint = useCallback((text: string) => {
    setHint(text);
    AccessibilityInfo.announceForAccessibility(text);
  }, []);
  useEffect(() => {
    if (!hint) return;
    const timer = setTimeout(() => setHint(null), hintMs);
    return () => clearTimeout(timer);
  }, [hint]);

  const capturedMs = useCallback(() => {
    try {
      const status = recorder.getStatus();
      if (status.durationMillis > 0)
        lastDuration.current = status.durationMillis;
    } catch {
      // The recorder is gone; keep the last reading.
    }
    return started.current ? lastDuration.current : 0;
  }, [recorder]);

  const stopPolling = useCallback(() => {
    if (poll.current !== null) clearInterval(poll.current);
    poll.current = null;
  }, []);

  /** Stops the recorder; returns the take, or null if nothing was captured. */
  const finish = useCallback(async (): Promise<Take | null> => {
    wanted.current = false;
    stopPolling();
    const durationMs = capturedMs();
    const wasStarted = started.current;
    started.current = false;
    let uri: string | null = null;
    if (wasStarted) {
      try {
        await recorder.stop();
      } catch {
        // Stopped already (interruption, the system); the file is kept.
      }
      uri = recorder.uri;
    }
    await leaveRecordingMode();
    useRecordingMeter.setState({ durationMs: 0, levels: [] });
    return uri ? { uri, durationMs, levels: [...levels.current] } : null;
  }, [capturedMs, recorder, stopPolling]);

  const send = useCallback(
    (take: Take | null) => {
      const to = targetRef.current;
      if (!take || !to) {
        deleteFile(take?.uri);
        return;
      }
      try {
        queueVoice({ api, outbox, store, userID: user.id }, { ...take, ...to });
        to.onQueued?.();
      } catch {
        deleteFile(take.uri);
        showHint(t("voiceRecordFailed"));
      }
    },
    [api, outbox, showHint, store, t, user.id],
  );

  const start = useCallback(async () => {
    wanted.current = true;
    levels.current = [];
    lastDuration.current = 0;
    seenRecording.current = false;
    useRecordingMeter.setState({ durationMs: 0, levels: [] });
    stopVoice();
    try {
      await enterRecordingMode();
      await recorder.prepareToRecordAsync(voiceRecording);
      // Released or cancelled while the recorder was getting ready.
      if (!wanted.current) {
        await leaveRecordingMode();
        return;
      }
      recorder.record();
      started.current = true;
    } catch {
      started.current = false;
      dispatchRef.current({ type: "failed" });
      return;
    }
    poll.current = setInterval(() => {
      let status;
      try {
        status = recorder.getStatus();
      } catch {
        return;
      }
      if (status.durationMillis > 0)
        lastDuration.current = status.durationMillis;
      if (typeof status.metering === "number")
        levels.current.push(status.metering);
      useRecordingMeter.setState({
        durationMs: lastDuration.current,
        levels: levels.current.slice(-80),
      });
      if (status.isRecording) seenRecording.current = true;
      // A call or the system paused the recorder without telling us.
      if (!status.isRecording && started.current && seenRecording.current)
        dispatchRef.current({
          type: "interrupt",
          durationMs: lastDuration.current,
        });
      else
        dispatchRef.current({ type: "tick", durationMs: lastDuration.current });
    }, pollMs);
  }, [recorder]);

  const run = useCallback(
    (effect: RecorderEffect) => {
      switch (effect.type) {
        case "start":
          void start();
          break;
        case "stopAndSend":
          void finish().then(send);
          break;
        case "stopAndReview":
          void finish().then((take) => {
            review.current = take;
            setReviewTake(take);
            if (!take) dispatchRef.current({ type: "failed" });
          });
          break;
        case "stopAndDiscard":
          void finish().then((take) => deleteFile(take?.uri));
          break;
        case "sendReviewed":
          stopVoice(reviewKey(review.current));
          send(review.current);
          review.current = null;
          setReviewTake(null);
          break;
        case "discardReviewed":
          stopVoice(reviewKey(review.current));
          deleteFile(review.current?.uri);
          review.current = null;
          setReviewTake(null);
          break;
        case "haptic":
          if (effect.kind === "warning")
            void Haptics.notificationAsync(
              Haptics.NotificationFeedbackType.Warning,
            );
          else
            void Haptics.impactAsync(
              effect.kind === "start"
                ? Haptics.ImpactFeedbackStyle.Medium
                : Haptics.ImpactFeedbackStyle.Light,
            );
          break;
        case "announce":
          AccessibilityInfo.announceForAccessibility(t(effect.key));
          break;
        case "hint":
          showHint(t(effect.key));
          break;
      }
    },
    [finish, send, showHint, start, t],
  );

  const dispatch = useCallback(
    (event: RecorderEvent) => {
      const next = recorderReducer(phaseRef.current, event);
      if (next.phase === phaseRef.current && !next.effects.length) return;
      phaseRef.current = next.phase;
      setPhase(next.phase);
      for (const effect of next.effects) run(effect);
    },
    [run],
  );
  dispatchRef.current = dispatch;

  // Leaving the foreground stops the take and keeps it for review.
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active" && isRecording(phaseRef.current))
        dispatchRef.current({ type: "interrupt", durationMs: capturedMs() });
    });
    return () => subscription.remove();
  }, [capturedMs]);

  // Leaving the chat drops an unfinished take.
  useEffect(
    () => () => {
      wanted.current = false;
      stopPolling();
      if (started.current) {
        started.current = false;
        void recorder
          .stop()
          .catch(() => undefined)
          .then(() => deleteFile(recorder.uri));
        void leaveRecordingMode();
      }
      deleteFile(review.current?.uri);
      review.current = null;
    },
    [recorder, stopPolling],
  );

  /** Finger down on the microphone. */
  const press = useCallback(() => {
    if (!target || phaseRef.current.kind !== "idle") return;
    if (permission.current === "granted") {
      dispatch({ type: "press", at: Date.now() });
      return;
    }
    void askPermission();
  }, [dispatch, target]);

  async function askPermission(): Promise<boolean> {
    if (permission.current === "denied") {
      Alert.alert(t("voiceMicDeniedTitle"), t("voiceMicDenied"), [
        { text: t("cancel"), style: "cancel" },
        { text: t("openSettings"), onPress: () => void Linking.openSettings() },
      ]);
      return false;
    }
    const answer = await requestRecordingPermissionsAsync().catch(() => null);
    if (answer?.granted) {
      permission.current = "granted";
      // The finger is long gone after the system dialog.
      showHint(t("voiceHoldToRecord"));
      return true;
    }
    permission.current = answer && !answer.canAskAgain ? "denied" : "ask";
    if (permission.current === "denied") return askPermission();
    return false;
  }

  /** Screen reader activation: record hands-free without holding. */
  const startHandsFree = useCallback(async () => {
    if (!target || phaseRef.current.kind !== "idle") return;
    if (permission.current !== "granted") {
      if (!(await askPermission())) return;
    }
    dispatch({ type: "lockTap" });
  }, [dispatch, target]); // eslint-disable-line react-hooks/exhaustive-deps

  const reviewTrack = useMemo<VoiceTrack | null>(
    () =>
      reviewTake
        ? {
            key: `review:${reviewTake.uri}`,
            durationMs: reviewTake.durationMs,
            resolve: async () => reviewTake.uri,
          }
        : null,
    [reviewTake],
  );

  return {
    enabled: Boolean(target),
    phase,
    hint,
    reviewTrack,
    reviewLevels: reviewTake?.levels ?? [],
    press,
    move: (dx: number, dy: number) => dispatch({ type: "move", dx, dy }),
    release: () =>
      dispatch({ type: "release", at: Date.now(), durationMs: capturedMs() }),
    /** The system took the touch (a scroll, a sheet): keep what was said. */
    lostTouch: () => dispatch({ type: "interrupt", durationMs: capturedMs() }),
    startHandsFree,
    stop: () => dispatch({ type: "stop", durationMs: capturedMs() }),
    send: () => dispatch({ type: "send", durationMs: capturedMs() }),
    discard: () => dispatch({ type: "discard" }),
  };
}

function reviewKey(take: Take | null) {
  return take ? `review:${take.uri}` : undefined;
}
