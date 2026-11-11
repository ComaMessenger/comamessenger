import { useCallback, useMemo } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  View,
  type AccessibilityActionEvent,
} from "react-native";
import { Pause, Play, RotateCw } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { formatVoiceDuration, type MessengerAPI } from "@comamessenger/core";
import { useTheme } from "@/lib/theme";
import { Text } from "@/ui/Text";
import { voiceFileURI } from "./cache";
import type { VoiceFile } from "./model";
import {
  cycleVoiceRate,
  seekVoice,
  toggleVoice,
  useVoiceTrack,
  type VoiceTrack,
} from "./player";
import { nextVoiceInFeeds } from "./VoiceFeed";
import { Waveform } from "./Waveform";

const seekStepSeconds = 5;

export function voiceTrack(
  api: MessengerAPI,
  file: VoiceFile,
  next?: (fileID: string) => VoiceFile | null,
): VoiceTrack {
  return {
    key: file.id,
    durationMs: file.voice.duration_ms,
    resolve: () => voiceFileURI(api, file.id),
    next: next
      ? () => {
          const following = next(file.id);
          return following ? voiceTrack(api, following, next) : null;
        }
      : undefined,
  };
}

/**
 * Voice message in a bubble (prototype `.voice`): round play button, bars
 * with progress that seek on tap or drag, the length, and the speed while
 * listening. Time and delivery stay in the bubble's footer.
 */
export function VoiceMessage({
  api,
  file,
  own,
}: {
  api: MessengerAPI;
  file: VoiceFile;
  own: boolean;
}) {
  const { t, i18n } = useTranslation();
  const theme = useTheme();
  const track = useMemo(
    () => voiceTrack(api, file, nextVoiceInFeeds),
    [api, file],
  );
  const state = useVoiceTrack(file.id);
  const total = state.duration || file.voice.duration_ms / 1000;
  const progress = total > 0 ? Math.min(1, state.position / total) : 0;
  const listening = state.status === "playing" || state.status === "paused";
  const totalLabel = formatVoiceDuration(file.voice.duration_ms);
  const elapsedLabel = formatVoiceDuration(state.position * 1000);
  const rateLabel = `${new Intl.NumberFormat(i18n.language).format(state.rate)}×`;
  const available = file.status === "ready";

  const muted = own ? theme.ownMuted : theme.muted;
  const button = own ? theme.onOwn : theme.primary;
  const icon = own ? theme.own : theme.onPrimary;
  const bar = own ? theme.onOwn : theme.muted;
  const played = own ? theme.onOwn : theme.primary;

  const seek = useCallback(
    (ratio: number) => seekVoice(track, ratio * total),
    [total, track],
  );

  function onAdjust(event: AccessibilityActionEvent) {
    const step =
      event.nativeEvent.actionName === "increment"
        ? seekStepSeconds
        : event.nativeEvent.actionName === "decrement"
          ? -seekStepSeconds
          : 0;
    if (step) seekVoice(track, state.position + step);
  }

  return (
    <View
      testID="voice-message"
      accessibilityLabel={t("voiceMessageLabel", { duration: totalLabel })}
      style={styles.voice}
    >
      <Pressable
        testID="voice-play"
        accessibilityRole="button"
        accessibilityLabel={
          state.status === "playing" ? t("voicePause") : t("voicePlay")
        }
        accessibilityHint={t("voiceMessageLabel", { duration: totalLabel })}
        accessibilityState={{
          busy: state.status === "loading",
          disabled: !available,
        }}
        disabled={!available}
        hitSlop={4}
        onPress={() => toggleVoice(track)}
        style={({ pressed }) => [
          styles.play,
          { backgroundColor: button, opacity: pressed || !available ? 0.7 : 1 },
        ]}
      >
        {state.status === "loading" ? (
          <ActivityIndicator size="small" color={icon} />
        ) : state.failed ? (
          <RotateCw size={18} color={icon} />
        ) : state.status === "playing" ? (
          <Pause size={18} color={icon} fill={icon} strokeWidth={0} />
        ) : (
          <Play size={18} color={icon} fill={icon} strokeWidth={0} />
        )}
      </Pressable>
      <View style={styles.body}>
        <View
          accessible
          accessibilityRole="adjustable"
          accessibilityLabel={t("voiceSeek")}
          accessibilityValue={{ text: `${elapsedLabel} / ${totalLabel}` }}
          accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
          onAccessibilityAction={onAdjust}
        >
          <Waveform
            waveform={file.voice.waveform}
            progress={progress}
            color={bar}
            playedColor={played}
            onSeek={available ? seek : undefined}
          />
        </View>
        <View style={styles.meta}>
          <Text size={11.5} style={[styles.tabular, { color: muted }]}>
            {listening ? `${elapsedLabel} / ${totalLabel}` : totalLabel}
          </Text>
          {listening && (
            <Pressable
              testID="voice-speed"
              accessibilityRole="button"
              accessibilityLabel={t("voiceSpeed", { rate: rateLabel })}
              hitSlop={10}
              onPress={cycleVoiceRate}
              style={[
                styles.speed,
                {
                  backgroundColor: own ? theme.ownTrack : theme.surfaceSelected,
                },
              ]}
            >
              <Text
                size={11}
                weight="bold"
                style={{ color: own ? theme.onOwn : theme.foreground }}
              >
                {rateLabel}
              </Text>
            </Pressable>
          )}
          {state.failed && (
            <Text
              size={11.5}
              accessibilityRole="alert"
              accessibilityHint={t("voiceLoadRetry")}
              style={{ color: own ? theme.onOwn : theme.danger }}
            >
              {t("voiceLoadFailed")}
            </Text>
          )}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // Prototype: `.voice { gap: 10px; width: 214px }`, `.pl` 42 px.
  voice: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    width: 214,
    maxWidth: "100%",
  },
  play: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: "center",
    justifyContent: "center",
  },
  body: { flex: 1, minWidth: 0 },
  meta: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 2,
    minHeight: 18,
  },
  tabular: { fontVariant: ["tabular-nums"] },
  speed: { borderRadius: 8, paddingHorizontal: 6, paddingVertical: 1 },
});
