import { useMemo, useState, type ReactNode } from "react";
import { Alert, Pressable, StyleSheet, View } from "react-native";
import { FileText } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import {
  formatBytes,
  type FileMetadata,
  type MessengerAPI,
} from "@comamessenger/core";
import { radius, spacing } from "@comamessenger/tokens";
import { openAttachment } from "@/files/open";
import { useTheme } from "@/lib/theme";
import { Text } from "@/ui/Text";
import { playableVoice } from "@/voice/model";
import { VoiceBoundary } from "@/voice/VoiceFeed";
import { VoiceMessage } from "@/voice/VoiceMessage";
import { isVisualMedia, mediaKind, type MediaItem } from "@/media/items";
import type { MediaMosaic as Mosaic } from "@/media/layout";
import {
  MediaMosaic,
  useMediaMaxWidth,
  useMediaMosaic,
} from "@/media/MediaMosaic";
import {
  MediaViewerContext,
  useOpenMedia,
  type OpenMedia,
} from "@/media/MediaViewerContext";
import { MediaViewerHost } from "@/media/MediaViewer";

function FileCard({ api, file }: { api: MessengerAPI; file: FileMetadata }) {
  const { t, i18n } = useTranslation();
  const theme = useTheme();
  const [busy, setBusy] = useState(false);
  const size = formatBytes(file.size, i18n.language, {
    bytes: t("unitBytes"),
    kilobytes: t("unitKilobytes"),
    megabytes: t("unitMegabytes"),
    gigabytes: t("unitGigabytes"),
  });
  const available = file.status === "ready";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityHint={t("openFile")}
      disabled={!available || busy}
      onPress={() => {
        setBusy(true);
        void openAttachment(api, file)
          .catch(() => Alert.alert(t("fileUnavailable")))
          .finally(() => setBusy(false));
      }}
      style={[
        styles.card,
        {
          backgroundColor: theme.surface,
          borderColor: theme.border,
          opacity: busy ? 0.6 : 1,
        },
      ]}
    >
      <View
        style={[
          styles.icon,
          { backgroundColor: theme.sidebar, borderColor: theme.border },
        ]}
      >
        <FileText size={20} color={theme.muted} />
      </View>
      <View style={styles.grow}>
        <Text weight="medium" size={15} numberOfLines={1}>
          {file.name}
        </Text>
        <Text tone="muted" size={13}>
          {available ? size : t("fileUnavailable")}
        </Text>
      </View>
    </Pressable>
  );
}

/** How the photos sit in the bubble: edge to edge, and up to which edges. */
export type ImageBleed = { top: boolean; bottom: boolean };

/**
 * Attachments of one message: voice player, a mosaic of photos and videos
 * (opening the chat's full-screen viewer) and file cards.
 */
export function MessageFiles({
  api,
  files,
  own = false,
  bleed,
  overlay,
  voiceMeta,
  mosaic,
}: {
  api: MessengerAPI;
  files: FileMetadata[];
  /** The reader's own bubble: the voice player takes its colours. */
  own?: boolean;
  /** Photos edge to edge of the bubble (its padding is 11 + 1 border). */
  bleed?: ImageBleed;
  /** Laid over the last photo, bottom right: the time of a photo message. */
  overlay?: ReactNode;
  /** The time of a voice message, in the player's length row. */
  voiceMeta?: ReactNode;
  /** The bubble already sized itself to this mosaic. */
  mosaic?: Mosaic;
}) {
  const visual = useMemo(() => files.filter(isVisualMedia), [files]);
  const others = files.filter((file) => !visual.includes(file));
  const maxWidth = useMediaMaxWidth();
  const ownMosaic = useMediaMosaic(visual, maxWidth);
  const open = useOpenMedia();
  const fallbackItems = useMemo<MediaItem[]>(
    () =>
      visual.map((file) => ({
        key: file.id,
        kind: mediaKind(file)!,
        file,
        messageID: "",
        actorID: file.uploader_id,
        createdAt: file.created_at,
      })),
    [visual],
  );
  const content = (openMedia: OpenMedia | null) => (
    <View style={styles.files}>
      {others.map((file) => {
        // A voice file without valid `voice` data stays a plain attachment.
        const voice = playableVoice(file);
        return voice ? (
          <VoiceBoundary
            key={file.id}
            fallback={<FileCard api={api} file={file} />}
          >
            <VoiceMessage
              api={api}
              file={voice}
              own={own}
              trailing={voiceMeta}
            />
          </VoiceBoundary>
        ) : null;
      })}
      {visual.length > 0 && (
        <View
          style={[
            bleed && styles.galleryBleed,
            bleed?.top && styles.bleedTop,
            bleed?.bottom && styles.bleedBottom,
          ]}
        >
          <MediaMosaic
            files={visual}
            mosaic={mosaic ?? ownMosaic}
            rounded={!bleed}
            overlay={overlay}
            onOpen={(file, origin) => openMedia?.(file.id, origin)}
          />
        </View>
      )}
      {others
        .filter((file) => !playableVoice(file))
        .map((file) => (
          <FileCard key={file.id} api={api} file={file} />
        ))}
    </View>
  );
  if (open || visual.length === 0) return content(open);
  // Outside a chat screen: a viewer of this message's media only.
  return (
    <MediaViewerHost items={fallbackItems} authorName={() => ""}>
      <MediaViewerContext.Consumer>{content}</MediaViewerContext.Consumer>
    </MediaViewerHost>
  );
}

const styles = StyleSheet.create({
  files: { gap: spacing[2] },
  // Bubble padding 11 (sides), 7 (top), 6 (bottom), plus its 1 px border.
  galleryBleed: { alignSelf: "stretch", marginHorizontal: -12 },
  bleedTop: { marginTop: -8 },
  bleedBottom: { marginBottom: -7 },
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing[3],
    padding: spacing[3],
    borderRadius: radius.lg,
    borderWidth: 1,
    maxWidth: 320,
    minHeight: 64,
  },
  icon: {
    width: 36,
    height: 36,
    borderRadius: radius.md,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  grow: { flex: 1 },
});
