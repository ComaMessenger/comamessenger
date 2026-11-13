import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  View,
  useWindowDimensions,
} from "react-native";
import { Image } from "expo-image";
import { Film, Play, RotateCw } from "lucide-react-native";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { FileMetadata } from "@comamessenger/core";
import { useFileSource } from "@/files/sources";
import { useTheme } from "@/lib/theme";
import { measureAnchor, type AnchorRect } from "@/ui/AnchoredMenu";
import { Text } from "@/ui/Text";
import { forgetProbeFailure, probeVideo } from "./probe";
import {
  recordMediaFacts,
  useAspects,
  useLocalMedia,
  useMediaFacts,
  usePoster,
} from "./facts";
import { formatMediaDuration, mediaKind } from "./items";
import { mediaMosaic, type MediaMosaic as Mosaic } from "./layout";

/** Widest a photo or video bubble gets, Telegram-like: about ¾ of the screen. */
export function useMediaMaxWidth(gutter = 0) {
  const { width } = useWindowDimensions();
  return Math.round(Math.min(320, (width - 20) * 0.8 - gutter));
}

/** The mosaic of a message's photos and videos at their known proportions. */
export function useMediaMosaic(
  files: readonly FileMetadata[],
  maxWidth: number,
): Mosaic {
  const ids = useMemo(() => files.map((file) => file.id), [files]);
  const aspects = useAspects(ids);
  return useMemo(
    () =>
      mediaMosaic(aspects, {
        maxWidth,
        maxHeight: Math.round(maxWidth * 1.3),
        minWidth: Math.round(maxWidth * 0.55),
      }),
    [aspects, maxWidth],
  );
}

/**
 * Photos and videos of one message laid out as a mosaic. Each tile shows
 * the server's preview (or the picked file on the sender's phone) with a
 * spinner until it is in, «Retry» if it failed; a video shows its first
 * frame, a play button and its length. A tap opens the full-screen viewer.
 */
export function MediaMosaic({
  files,
  mosaic,
  rounded = false,
  overlay,
  onOpen,
  onLongPress,
}: {
  files: readonly FileMetadata[];
  mosaic: Mosaic;
  /** The message menu: a long press on a tile is a long press on the bubble. */
  onLongPress?(): void;
  /** Corners of its own (outside a bubble that clips it). */
  rounded?: boolean;
  /** Laid over the last tile, bottom right: the time of a media message. */
  overlay?: ReactNode;
  onOpen(file: FileMetadata, origin: AnchorRect | null): void;
}) {
  return (
    <View
      testID="media-mosaic"
      style={[
        { width: mosaic.width, height: mosaic.height },
        rounded && styles.rounded,
      ]}
    >
      {files.map((file, index) => {
        const frame = mosaic.frames[index];
        if (!frame) return null;
        return (
          <View
            key={file.id}
            style={[
              styles.tile,
              {
                left: frame.x,
                top: frame.y,
                width: frame.width,
                height: frame.height,
              },
            ]}
          >
            <MediaTile
              file={file}
              index={index}
              onOpen={onOpen}
              onLongPress={onLongPress}
            />
          </View>
        );
      })}
      {overlay ? (
        <View pointerEvents="none" style={styles.overlay}>
          {overlay}
        </View>
      ) : null}
    </View>
  );
}

function MediaTile({
  file,
  index,
  onOpen,
  onLongPress,
}: {
  file: FileMetadata;
  index: number;
  onOpen(file: FileMetadata, origin: AnchorRect | null): void;
  onLongPress?(): void;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const ref = useRef<View>(null);
  const video = mediaKind(file) === "video";
  const facts = useMediaFacts(file.id);
  const label = video
    ? facts.durationMs
      ? t("mediaVideoLength", {
          duration: formatMediaDuration(facts.durationMs),
        })
      : t("mediaVideo")
    : t("mediaPhotoNamed", { name: file.name });
  return (
    <Pressable
      ref={ref}
      testID={`media-tile-${index}`}
      accessibilityRole="imagebutton"
      accessibilityLabel={label}
      accessibilityHint={t("mediaOpenHint")}
      onPress={() =>
        void measureAnchor(ref).then((origin) => onOpen(file, origin))
      }
      onLongPress={onLongPress}
      delayLongPress={350}
      style={[StyleSheet.absoluteFill, { backgroundColor: theme.sidebar }]}
    >
      {video ? (
        <VideoPoster file={file} durationMs={facts.durationMs} />
      ) : (
        <PhotoPreview file={file} />
      )}
    </Pressable>
  );
}

function PhotoPreview({ file }: { file: FileMetadata }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const local = useLocalMedia(file.id);
  const previewID = file.preview_file_id ?? file.id;
  const remote = useFileSource(local ? undefined : previewID);
  const [state, setState] = useState<"loading" | "loaded" | "failed">(
    "loading",
  );
  const [attempt, setAttempt] = useState(0);
  const source = local ? { uri: local } : remote;
  return (
    <>
      {source && (
        <Image
          key={attempt}
          source={source}
          contentFit="cover"
          cachePolicy="disk"
          recyclingKey={file.id}
          transition={120}
          style={StyleSheet.absoluteFill}
          onLoad={(event) => {
            setState("loaded");
            const { width, height } = event.source;
            if (width > 0 && height > 0)
              recordMediaFacts(file.id, { aspect: width / height });
          }}
          onError={() => setState("failed")}
        />
      )}
      {state === "loading" && (
        <View style={styles.center} pointerEvents="none">
          <ActivityIndicator color="#ffffff" />
        </View>
      )}
      {state === "failed" && (
        <Pressable
          testID="media-tile-retry"
          accessibilityRole="button"
          accessibilityLabel={t("retry")}
          onPress={() => {
            setState("loading");
            void queryClient
              .invalidateQueries({ queryKey: ["file-link", previewID] })
              .finally(() => setAttempt((value) => value + 1));
          }}
          style={styles.center}
        >
          <View style={styles.retry}>
            <RotateCw size={16} color="#ffffff" />
            <Text size={13} weight="semibold" style={styles.white}>
              {t("retry")}
            </Text>
          </View>
        </Pressable>
      )}
    </>
  );
}

function VideoPoster({
  file,
  durationMs,
}: {
  file: FileMetadata;
  durationMs?: number;
}) {
  const { t } = useTranslation();
  const local = useLocalMedia(file.id);
  const remote = useFileSource(local ? undefined : file.id);
  const poster = usePoster(file.id);
  const [failed, setFailed] = useState(false);
  const source = local ? { uri: local } : remote;
  const uri = source?.uri;
  const headers = source && "headers" in source ? source.headers : undefined;
  useEffect(() => {
    if (poster || !uri) return;
    let active = true;
    void probeVideo(file.id, { uri, headers, useCaching: true }).then((ok) => {
      if (active && !ok) setFailed(true);
    });
    return () => {
      active = false;
    };
    // The headers object is rebuilt on every render; one probe per link.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.id, poster, uri]);
  return (
    <>
      {poster ? (
        <Image
          source={poster}
          contentFit="cover"
          recyclingKey={file.id}
          transition={120}
          style={StyleSheet.absoluteFill}
        />
      ) : (
        <View style={[styles.center, styles.dark]} pointerEvents="none">
          {failed ? (
            <Film size={28} color="#ffffff" />
          ) : (
            <ActivityIndicator color="#ffffff" />
          )}
        </View>
      )}
      <View style={styles.center} pointerEvents="none">
        <View testID="media-play" style={styles.play}>
          <Play size={22} color="#ffffff" fill="#ffffff" />
        </View>
      </View>
      {durationMs ? (
        <View style={styles.duration} pointerEvents="none">
          <Text
            size={11.5}
            weight="semibold"
            style={[styles.white, styles.tabular]}
          >
            {formatMediaDuration(durationMs)}
          </Text>
        </View>
      ) : null}
      {failed && !poster ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("retry")}
          onPress={() => {
            forgetProbeFailure(file.id);
            setFailed(false);
          }}
          style={styles.posterRetry}
          hitSlop={8}
        >
          <RotateCw size={14} color="#ffffff" />
        </Pressable>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  rounded: { borderRadius: 12, overflow: "hidden" },
  tile: { position: "absolute", overflow: "hidden" },
  overlay: { position: "absolute", right: 8, bottom: 8 },
  center: {
    ...StyleSheet.absoluteFill,
    alignItems: "center",
    justifyContent: "center",
  },
  dark: { backgroundColor: "rgba(0, 0, 0, 0.35)" },
  retry: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    minHeight: 36,
    borderRadius: 18,
    backgroundColor: "rgba(0, 0, 0, 0.55)",
  },
  white: { color: "#ffffff" },
  tabular: { fontVariant: ["tabular-nums"] },
  play: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: "rgba(0, 0, 0, 0.45)",
    alignItems: "center",
    justifyContent: "center",
    paddingLeft: 3,
  },
  duration: {
    position: "absolute",
    left: 8,
    top: 8,
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 10,
    backgroundColor: "rgba(0, 0, 0, 0.5)",
  },
  posterRetry: {
    position: "absolute",
    right: 8,
    top: 8,
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: "rgba(0, 0, 0, 0.55)",
    alignItems: "center",
    justifyContent: "center",
  },
});
