import { useState, type ReactNode } from "react";
import { Alert, Pressable, StyleSheet, View } from "react-native";
import { Image } from "expo-image";
import { FileText } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import {
  formatBytes,
  type FileMetadata,
  type MessengerAPI,
} from "@comamessenger/core";
import { radius, spacing } from "@comamessenger/tokens";
import { openAttachment } from "@/files/open";
import { PhotoViewer } from "@/files/PhotoViewer";
import { useFileSource } from "@/files/sources";
import { useTheme } from "@/lib/theme";
import { Text } from "@/ui/Text";
import { playableVoice } from "@/voice/model";
import { VoiceBoundary } from "@/voice/VoiceFeed";
import { VoiceMessage } from "@/voice/VoiceMessage";

function ImageAttachment({
  api,
  file,
  bleed,
  onOpen,
}: {
  api: MessengerAPI;
  file: FileMetadata;
  /** Edge to edge of the bubble: no frame, no rounding of its own. */
  bleed: boolean;
  onOpen(): void;
}) {
  const theme = useTheme();
  const source = useFileSource(file.preview_file_id ?? file.id);
  return (
    <Pressable
      accessibilityRole="imagebutton"
      accessibilityLabel={file.name}
      onPress={onOpen}
      style={[
        styles.image,
        bleed && styles.imageBleed,
        { backgroundColor: theme.sidebar, borderColor: theme.border },
      ]}
    >
      {source && (
        <Image
          source={source}
          contentFit="cover"
          cachePolicy="disk"
          style={StyleSheet.absoluteFill}
        />
      )}
    </Pressable>
  );
}

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

/** Attachments of one message: voice player, image previews and file cards. */
export function MessageFiles({
  api,
  files,
  own = false,
  bleed,
  overlay,
  voiceMeta,
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
}) {
  const [viewing, setViewing] = useState<FileMetadata | null>(null);
  const images = files.filter(
    (file) => file.mime.startsWith("image/") && file.status === "ready",
  );
  const others = files.filter((file) => !images.includes(file));
  return (
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
      {images.length > 0 && (
        <View
          style={[
            styles.gallery,
            bleed && styles.galleryBleed,
            bleed?.top && styles.bleedTop,
            bleed?.bottom && styles.bleedBottom,
          ]}
        >
          {images.map((file) => (
            <ImageAttachment
              key={file.id}
              api={api}
              file={file}
              bleed={Boolean(bleed)}
              onOpen={() => setViewing(file)}
            />
          ))}
          {overlay ? (
            <View pointerEvents="none" style={styles.overlay}>
              {overlay}
            </View>
          ) : null}
        </View>
      )}
      {others
        .filter((file) => !playableVoice(file))
        .map((file) => (
          <FileCard key={file.id} api={api} file={file} />
        ))}
      <PhotoViewer api={api} file={viewing} onClose={() => setViewing(null)} />
    </View>
  );
}

const styles = StyleSheet.create({
  files: { gap: spacing[2] },
  grow: { flex: 1 },
  gallery: { flexDirection: "row", flexWrap: "wrap", gap: spacing[1] },
  // Bubble padding 11 (sides), 7 (top), 6 (bottom), plus its 1 px border.
  // A column, so each photo stretches across the widened gallery (a
  // wrapping row only shifted it left and left a strip on the right).
  galleryBleed: {
    flexDirection: "column",
    // A wrapping container does not stretch its children across.
    flexWrap: "nowrap",
    alignSelf: "stretch",
    marginHorizontal: -12,
    gap: 2,
  },
  bleedTop: { marginTop: -8 },
  bleedBottom: { marginBottom: -7 },
  imageBleed: {
    width: undefined,
    maxWidth: undefined,
    alignSelf: "stretch",
    height: 200,
    borderRadius: 0,
    borderWidth: 0,
  },
  overlay: { position: "absolute", right: 8, bottom: 8 },
  image: {
    width: "100%",
    maxWidth: 280,
    height: 160,
    borderRadius: radius.md,
    borderWidth: 1,
    overflow: "hidden",
  },
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
});
