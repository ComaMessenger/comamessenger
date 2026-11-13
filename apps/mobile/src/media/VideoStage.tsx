import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  View,
  type LayoutChangeEvent,
} from "react-native";
import { useEvent } from "expo";
import { useVideoPlayer, VideoView } from "expo-video";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  runOnJS,
  useAnimatedStyle,
  type SharedValue,
} from "react-native-reanimated";
import { Pause, Play, RotateCw, Volume2, VolumeX } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import type { FileMetadata } from "@comamessenger/core";
import { useFileSource } from "@/files/sources";
import { Text } from "@/ui/Text";
import { recordMediaFacts, useLocalMedia } from "./facts";
import { formatMediaDuration } from "./items";
import { claimPlayback, releasePlayback } from "./playback";

/**
 * The player of the video on screen in the viewer: it starts with sound
 * when the page opens, the poster frame stays under it until the first
 * frame is drawn. Controls: play/pause, a scrubber to seek, time, sound.
 * Only the current page has a player; swiping away releases it. Starting
 * it pauses a voice message, and a voice message started later pauses it.
 */
export function VideoStage({
  file,
  content,
  scale,
  x,
  y,
  controls,
  bottomInset,
}: {
  file: FileMetadata;
  content: { width: number; height: number };
  scale: SharedValue<number>;
  x: SharedValue<number>;
  y: SharedValue<number>;
  controls: boolean;
  bottomInset: number;
}) {
  const { t } = useTranslation();
  const local = useLocalMedia(file.id);
  const remote = useFileSource(local ? undefined : file.id);
  const source = local
    ? { uri: local }
    : remote
      ? { uri: remote.uri, headers: remote.headers, useCaching: true }
      : null;
  const player = useVideoPlayer(source, (created) => {
    created.loop = false;
    created.audioMixingMode = "doNotMix";
    created.timeUpdateEventInterval = 0.25;
  });
  const { status } = useEvent(player, "statusChange", {
    status: player.status,
  });
  const { isPlaying } = useEvent(player, "playingChange", {
    isPlaying: player.playing,
  });
  const time = useEvent(player, "timeUpdate", {
    currentTime: 0,
    currentLiveTimestamp: null,
    currentOffsetFromLive: null,
    bufferedPosition: 0,
  });
  const { muted } = useEvent(player, "mutedChange", { muted: player.muted });
  const [duration, setDuration] = useState(0);
  const [frame, setFrame] = useState(false);
  const [ended, setEnded] = useState(false);

  const pause = useCallback(() => {
    try {
      player.pause();
    } catch {
      // Released with the page.
    }
  }, [player]);

  const play = useCallback(() => {
    claimPlayback(pause);
    if (ended) {
      player.currentTime = 0;
      setEnded(false);
    }
    player.play();
  }, [ended, pause, player]);

  useEffect(() => {
    const subscriptions = [
      player.addListener("sourceLoad", (event) => {
        if (event.duration > 0) {
          setDuration(event.duration);
          recordMediaFacts(file.id, {
            durationMs: Math.round(event.duration * 1000),
          });
        }
      }),
      player.addListener("playToEnd", () => setEnded(true)),
    ];
    return () => subscriptions.forEach((item) => item.remove());
  }, [file.id, player]);

  // Opening a video plays it, with sound (Telegram does the same).
  const started = useRef(false);
  useEffect(() => {
    if (status !== "readyToPlay" || started.current) return;
    started.current = true;
    play();
  }, [play, status]);

  useEffect(() => () => releasePlayback(pause), [pause]);

  const transform = useAnimatedStyle(() => ({
    transform: [
      { translateX: x.value },
      { translateY: y.value },
      { scale: scale.value },
    ],
  }));

  const total = duration || player.duration || 0;
  const position = Math.min(total, time.currentTime);
  const failed = status === "error";

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      <View style={styles.stage} pointerEvents="none">
        <Animated.View
          style={[
            { width: content.width, height: content.height },
            transform,
            !frame && styles.hidden,
          ]}
        >
          <VideoView
            testID="media-video"
            player={player}
            nativeControls={false}
            contentFit="contain"
            allowsPictureInPicture={false}
            onFirstFrameRender={() => setFrame(true)}
            style={StyleSheet.absoluteFill}
          />
        </Animated.View>
      </View>
      {status === "loading" && !failed ? (
        <View style={styles.stage} pointerEvents="none">
          <ActivityIndicator
            testID="media-video-loading"
            color="#ffffff"
            size="large"
          />
        </View>
      ) : null}
      {failed ? (
        <View style={styles.stage} pointerEvents="box-none">
          <Text size={15} style={styles.white}>
            {t("mediaVideoFailed")}
          </Text>
          <Pressable
            testID="media-video-retry"
            accessibilityRole="button"
            accessibilityLabel={t("retry")}
            onPress={() => {
              if (source)
                void player.replaceAsync(source).catch(() => undefined);
              started.current = false;
            }}
            style={styles.retry}
          >
            <RotateCw size={16} color="#ffffff" />
            <Text size={14} weight="semibold" style={styles.white}>
              {t("retry")}
            </Text>
          </Pressable>
        </View>
      ) : null}
      {controls && !failed ? (
        <View
          testID="media-video-controls"
          style={[styles.controls, { bottom: bottomInset + 70 }]}
        >
          <Pressable
            testID={isPlaying ? "media-video-pause" : "media-video-play"}
            accessibilityRole="button"
            accessibilityLabel={isPlaying ? t("mediaPause") : t("mediaPlay")}
            hitSlop={8}
            onPress={() => (isPlaying ? pause() : play())}
            style={styles.control}
          >
            {isPlaying ? (
              <Pause size={22} color="#ffffff" fill="#ffffff" />
            ) : (
              <Play size={22} color="#ffffff" fill="#ffffff" />
            )}
          </Pressable>
          <Text size={12} style={[styles.white, styles.tabular]}>
            {formatMediaDuration(position * 1000)}
          </Text>
          <Scrubber
            position={position}
            duration={total}
            onSeek={(seconds) => {
              player.currentTime = seconds;
              setEnded(false);
            }}
          />
          <Text size={12} style={[styles.white, styles.tabular]}>
            {formatMediaDuration(total * 1000)}
          </Text>
          <Pressable
            testID="media-video-mute"
            accessibilityRole="button"
            accessibilityLabel={muted ? t("mediaUnmute") : t("mediaMute")}
            hitSlop={8}
            onPress={() => {
              player.muted = !muted;
            }}
            style={styles.control}
          >
            {muted ? (
              <VolumeX size={20} color="#ffffff" />
            ) : (
              <Volume2 size={20} color="#ffffff" />
            )}
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

/** Seek bar: drag or tap along it; a screen reader steps 10 seconds. */
function Scrubber({
  position,
  duration,
  onSeek,
}: {
  position: number;
  duration: number;
  onSeek(seconds: number): void;
}) {
  const { t } = useTranslation();
  const [width, setWidth] = useState(0);
  const [dragging, setDragging] = useState<number | null>(null);
  const shown = dragging ?? position;
  const progress = duration > 0 ? Math.min(1, shown / duration) : 0;
  const toSeconds = (pointX: number) =>
    width > 0 ? Math.max(0, Math.min(1, pointX / width)) * duration : 0;
  const seek = (pointX: number) => onSeek(toSeconds(pointX));
  const drag = (pointX: number) => setDragging(toSeconds(pointX));
  const release = (pointX: number) => {
    setDragging(null);
    onSeek(toSeconds(pointX));
  };
  const pan = Gesture.Pan()
    .hitSlop({ vertical: 14 })
    .onUpdate((event) => runOnJS(drag)(event.x))
    .onEnd((event) => runOnJS(release)(event.x));
  const tap = Gesture.Tap().onEnd((event) => runOnJS(seek)(event.x));
  return (
    <GestureDetector gesture={Gesture.Exclusive(pan, tap)}>
      <View
        testID="media-video-scrubber"
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={t("mediaSeek")}
        accessibilityValue={{
          text: `${formatMediaDuration(shown * 1000)} / ${formatMediaDuration(duration * 1000)}`,
        }}
        accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
        onAccessibilityAction={(event) =>
          onSeek(
            Math.max(
              0,
              Math.min(
                duration,
                position +
                  (event.nativeEvent.actionName === "increment" ? 10 : -10),
              ),
            ),
          )
        }
        onLayout={(event: LayoutChangeEvent) =>
          setWidth(event.nativeEvent.layout.width)
        }
        style={styles.track}
      >
        <View style={styles.rail} />
        <View
          style={[styles.rail, styles.played, { width: `${progress * 100}%` }]}
        />
        <View style={[styles.knob, { left: `${progress * 100}%` }]} />
      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  stage: {
    ...StyleSheet.absoluteFill,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
  },
  hidden: { opacity: 0 },
  white: { color: "#ffffff" },
  tabular: { fontVariant: ["tabular-nums"], minWidth: 34, textAlign: "center" },
  retry: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 16,
    minHeight: 40,
    borderRadius: 20,
    backgroundColor: "rgba(255, 255, 255, 0.16)",
  },
  controls: {
    position: "absolute",
    left: 12,
    right: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 6,
    minHeight: 48,
    borderRadius: 16,
    backgroundColor: "rgba(20, 20, 24, 0.72)",
  },
  control: {
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
  },
  track: { flex: 1, height: 32, justifyContent: "center" },
  rail: {
    position: "absolute",
    left: 0,
    right: 0,
    height: 3,
    borderRadius: 2,
    backgroundColor: "rgba(255, 255, 255, 0.3)",
  },
  played: { right: undefined, backgroundColor: "#ffffff" },
  knob: {
    position: "absolute",
    width: 14,
    height: 14,
    marginLeft: -7,
    borderRadius: 7,
    backgroundColor: "#ffffff",
  },
});
