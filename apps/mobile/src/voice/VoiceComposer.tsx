import { useEffect, useMemo, useRef, useState } from "react";
import {
  AccessibilityInfo,
  Animated,
  PanResponder,
  Pressable,
  StyleSheet,
  View,
} from "react-native";
import {
  ArrowUp,
  ChevronLeft,
  ChevronUp,
  Lock,
  Mic,
  Pause,
  Play,
  Square,
  Trash2,
} from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { formatVoiceDuration, voiceWaveform } from "@comamessenger/core";
import { radius } from "@comamessenger/tokens";
import { useTheme } from "@/lib/theme";
import { IconButton } from "@/ui/IconButton";
import { Text } from "@/ui/Text";
import { toggleVoice, useVoiceTrack } from "./player";
import { gestureProgress } from "./recording";
import { useRecordingMeter, type VoiceRecorder } from "./useVoiceRecorder";
import { Waveform } from "./Waveform";

/**
 * Right slot of the composer while the field is empty: the microphone
 * (hold to record, slide left to cancel, up to lock; double-tap or the
 * screen reader action for hands-free), or Send once hands-free.
 */
export function VoiceActionButton({ voice }: { voice: VoiceRecorder }) {
  const { t } = useTranslation();
  const theme = useTheme();
  const latest = useRef(voice);
  latest.current = voice;
  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: () => latest.current.press(),
        onPanResponderMove: (_, gesture) =>
          latest.current.move(gesture.dx, gesture.dy),
        onPanResponderRelease: () => latest.current.release(),
        // Scrolling the feed must not steal a held recording.
        onPanResponderTerminationRequest: () => false,
        onPanResponderTerminate: () => latest.current.lostTouch(),
      }),
    [],
  );
  const { phase } = voice;

  if (phase.kind === "locked" || phase.kind === "review")
    return (
      <View>
        <IconButton
          testID="voice-send"
          variant="accent"
          label={t("voiceSend")}
          onPress={voice.send}
          icon={(color) => (
            <ArrowUp size={20} color={color} strokeWidth={2.4} />
          )}
        />
        <Hint text={voice.hint} />
      </View>
    );

  const holding = phase.kind === "holding";
  const progress = gestureProgress(phase);
  return (
    <View style={styles.micSlot}>
      {holding && (
        <View
          pointerEvents="none"
          style={[
            styles.lock,
            {
              backgroundColor: theme.surface,
              borderColor: theme.border,
              transform: [{ translateY: -16 * progress.lock }],
            },
          ]}
        >
          <Lock
            size={18}
            color={progress.lock > 0.5 ? theme.primary : theme.muted}
          />
          <ChevronUp size={14} color={theme.muted} />
        </View>
      )}
      <View
        testID="composer-mic"
        accessible
        accessibilityRole="button"
        accessibilityLabel={t("voiceRecord")}
        accessibilityHint={t("voiceRecordHint")}
        accessibilityActions={[
          { name: "activate", label: t("voiceRecordHandsFree") },
        ]}
        onAccessibilityAction={(event) => {
          if (event.nativeEvent.actionName === "activate")
            void voice.startHandsFree();
        }}
        hitSlop={4}
        style={[styles.mic, { backgroundColor: theme.surfaceSelected }]}
        {...responder.panHandlers}
      >
        {holding ? (
          <View style={[styles.ring, { backgroundColor: theme.primarySoft }]}>
            <View style={[styles.big, { backgroundColor: theme.primary }]}>
              <Mic size={26} color={theme.onPrimary} />
            </View>
          </View>
        ) : (
          <Mic size={22} color={theme.foreground} />
        )}
      </View>
      <Hint text={voice.hint} />
    </View>
  );
}

function Hint({ text }: { text: string | null }) {
  const theme = useTheme();
  if (!text) return null;
  return (
    <View pointerEvents="none" style={styles.hintBox}>
      <View style={[styles.hint, { backgroundColor: theme.action }]}>
        <Text
          size={13.5}
          weight="medium"
          numberOfLines={2}
          style={{ color: theme.onAction }}
        >
          {text}
        </Text>
      </View>
    </View>
  );
}

function RecordingDot() {
  const theme = useTheme();
  const opacity = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    let loop: Animated.CompositeAnimation | null = null;
    let cancelled = false;
    void AccessibilityInfo.isReduceMotionEnabled().then((reduce) => {
      if (reduce || cancelled) return;
      loop = Animated.loop(
        Animated.sequence([
          Animated.timing(opacity, {
            toValue: 0.25,
            duration: 550,
            useNativeDriver: true,
          }),
          Animated.timing(opacity, {
            toValue: 1,
            duration: 550,
            useNativeDriver: true,
          }),
        ]),
      );
      loop.start();
    });
    return () => {
      cancelled = true;
      loop?.stop();
    };
  }, [opacity]);
  return (
    <Animated.View
      style={[styles.dot, { backgroundColor: theme.danger, opacity }]}
    />
  );
}

function Timer() {
  const { t } = useTranslation();
  const durationMs = useRecordingMeter((state) => state.durationMs);
  const label = formatVoiceDuration(Math.floor(durationMs / 1000) * 1000);
  return (
    <Text
      size={15}
      weight="semibold"
      accessibilityLabel={t("voiceRecordingTime", { duration: label })}
      style={styles.tabular}
    >
      {label}
    </Text>
  );
}

function LiveWave() {
  const theme = useTheme();
  const levels = useRecordingMeter((state) => state.levels);
  return (
    <Waveform
      levels={levels}
      progress={1}
      color={theme.muted}
      playedColor={theme.primary}
      height={22}
    />
  );
}

/**
 * Left part of the composer while recording (prototype `.rec`): held — dot,
 * timer and «slide left to cancel»; hands-free — delete, dot, timer, live
 * bars and stop; review — delete and a player for the take.
 */
export function VoiceRecordingBar({ voice }: { voice: VoiceRecorder }) {
  const { t } = useTranslation();
  const theme = useTheme();
  const { phase } = voice;
  const pill = [
    styles.rec,
    { backgroundColor: theme.surface, borderColor: theme.border },
  ];

  if (phase.kind === "holding") {
    const progress = gestureProgress(phase);
    return (
      <View testID="voice-recording" style={pill}>
        <RecordingDot />
        <Timer />
        <View
          style={[
            styles.slide,
            {
              opacity: 1 - progress.cancel * 0.8,
              transform: [{ translateX: phase.dx * 0.5 }],
            },
          ]}
        >
          <ChevronLeft size={15} color={theme.muted} />
          <Text tone="muted" size={13.5} numberOfLines={1}>
            {t("voiceSlideToCancel")}
          </Text>
        </View>
      </View>
    );
  }

  if (phase.kind === "locked")
    return (
      <>
        <IconButton
          testID="voice-delete"
          variant="danger"
          label={t("voiceDelete")}
          onPress={voice.discard}
          icon={(color) => <Trash2 size={20} color={color} />}
        />
        <View testID="voice-recording" style={pill}>
          <RecordingDot />
          <Timer />
          <LiveWave />
          <Pressable
            testID="voice-stop"
            accessibilityRole="button"
            accessibilityLabel={t("voiceStop")}
            hitSlop={8}
            onPress={voice.stop}
            style={[styles.small, { backgroundColor: theme.surfaceSelected }]}
          >
            <Square size={12} color={theme.danger} fill={theme.danger} />
          </Pressable>
        </View>
      </>
    );

  if (phase.kind === "review")
    return (
      <>
        <IconButton
          testID="voice-delete"
          variant="danger"
          label={t("voiceDelete")}
          onPress={voice.discard}
          icon={(color) => <Trash2 size={20} color={color} />}
        />
        <ReviewPlayer voice={voice} />
      </>
    );

  return null;
}

function ReviewPlayer({ voice }: { voice: VoiceRecorder }) {
  const { t } = useTranslation();
  const theme = useTheme();
  const track = voice.reviewTrack;
  const state = useVoiceTrack(track?.key ?? "review");
  const waveform = useMemo(
    () => voiceWaveform(voice.reviewLevels, { decibels: true }),
    [voice.reviewLevels],
  );
  const durationMs = track?.durationMs ?? 0;
  const total = state.duration || durationMs / 1000;
  const progress = total > 0 ? Math.min(1, state.position / total) : 0;
  const listening = state.status === "playing" || state.status === "paused";
  return (
    <View
      testID="voice-review"
      style={[
        styles.rec,
        styles.review,
        { backgroundColor: theme.surface, borderColor: theme.border },
      ]}
    >
      <Pressable
        testID="voice-review-play"
        accessibilityRole="button"
        accessibilityLabel={
          state.status === "playing" ? t("voicePause") : t("voicePlay")
        }
        disabled={!track}
        hitSlop={8}
        onPress={() => track && toggleVoice(track)}
        style={[styles.small, { backgroundColor: theme.primary }]}
      >
        {state.status === "playing" ? (
          <Pause
            size={14}
            color={theme.onPrimary}
            fill={theme.onPrimary}
            strokeWidth={0}
          />
        ) : (
          <Play
            size={14}
            color={theme.onPrimary}
            fill={theme.onPrimary}
            strokeWidth={0}
          />
        )}
      </Pressable>
      <Waveform
        waveform={waveform}
        progress={progress}
        color={theme.muted}
        playedColor={theme.primary}
        height={22}
      />
      <Text tone="muted" size={13} style={styles.tabular}>
        {listening
          ? formatVoiceDuration(state.position * 1000)
          : formatVoiceDuration(durationMs)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  // Prototype: `.rec { height: 40px; border-radius: 20px; gap: 8px; padding: 0 12px }`.
  rec: {
    flex: 1,
    minWidth: 0,
    height: 40,
    borderRadius: radius.field,
    borderWidth: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
  },
  review: { paddingLeft: 6 },
  dot: { width: 9, height: 9, borderRadius: 4.5 },
  tabular: { fontVariant: ["tabular-nums"] },
  slide: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    marginLeft: "auto",
    flexShrink: 1,
  },
  small: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  micSlot: { width: 40, height: 40 },
  mic: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  // Prototype `.micbig`: 62 px with a 9 px soft ring, centred on the button.
  ring: {
    position: "absolute",
    width: 80,
    height: 80,
    borderRadius: 40,
    left: -20,
    top: -20,
    alignItems: "center",
    justifyContent: "center",
  },
  big: {
    width: 62,
    height: 62,
    borderRadius: 31,
    alignItems: "center",
    justifyContent: "center",
  },
  lock: {
    position: "absolute",
    right: 0,
    bottom: 76,
    width: 40,
    paddingTop: 9,
    paddingBottom: 7,
    borderRadius: 20,
    borderWidth: 1,
    alignItems: "center",
    gap: 3,
  },
  hintBox: {
    position: "absolute",
    right: 0,
    bottom: 52,
    width: 260,
    alignItems: "flex-end",
  },
  hint: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: radius.lg,
  },
});
