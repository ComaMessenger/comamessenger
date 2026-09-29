import { useState } from "react";
import { Alert, Modal, Pressable, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Image } from "expo-image";
import { FileText, Share2, X } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import {
  formatBytes,
  type FileMetadata,
  type MessengerAPI,
} from "@comamessenger/core";
import { radius, spacing } from "@comamessenger/tokens";
import { openAttachment } from "@/files/open";
import { useFileSource } from "@/files/sources";
import { useTheme } from "@/lib/theme";
import { Text } from "@/ui/Text";

function ImageAttachment({
  api,
  file,
  onOpen,
}: {
  api: MessengerAPI;
  file: FileMetadata;
  onOpen(): void;
}) {
  const theme = useTheme();
  const source = useFileSource(file.preview_file_id ?? file.id);
  return (
    <Pressable
      accessibilityRole="imagebutton"
      accessibilityLabel={file.name}
      onPress={onOpen}
      style={[styles.image, { backgroundColor: theme.sidebar }]}
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
      <View style={[styles.icon, { backgroundColor: theme.primarySoft }]}>
        <FileText size={20} color={theme.primary} />
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

/** Attachments of one message: image previews and file cards. */
export function MessageFiles({
  api,
  files,
}: {
  api: MessengerAPI;
  files: FileMetadata[];
}) {
  const { t } = useTranslation();
  const [viewing, setViewing] = useState<FileMetadata | null>(null);
  const viewerSource = useFileSource(viewing?.id);
  const images = files.filter(
    (file) => file.mime.startsWith("image/") && file.status === "ready",
  );
  const others = files.filter((file) => !images.includes(file));
  return (
    <View style={styles.files}>
      {images.length > 0 && (
        <View style={styles.gallery}>
          {images.map((file) => (
            <ImageAttachment
              key={file.id}
              api={api}
              file={file}
              onOpen={() => setViewing(file)}
            />
          ))}
        </View>
      )}
      {others.map((file) => (
        <FileCard key={file.id} api={api} file={file} />
      ))}
      <Modal
        visible={viewing !== null}
        animationType="fade"
        onRequestClose={() => setViewing(null)}
      >
        <SafeAreaView style={styles.viewer}>
          <View style={styles.viewerBar}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("close")}
              hitSlop={12}
              onPress={() => setViewing(null)}
            >
              <X size={26} color="#ffffff" />
            </Pressable>
            {viewing && (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("share")}
                hitSlop={12}
                onPress={() =>
                  void openAttachment(api, viewing).catch(() =>
                    Alert.alert(t("fileUnavailable")),
                  )
                }
              >
                <Share2 size={24} color="#ffffff" />
              </Pressable>
            )}
          </View>
          {viewerSource && (
            <Image
              source={viewerSource}
              contentFit="contain"
              cachePolicy="disk"
              style={styles.grow}
              accessibilityLabel={viewing?.name}
            />
          )}
        </SafeAreaView>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  files: { gap: spacing[2] },
  gallery: { flexDirection: "row", flexWrap: "wrap", gap: spacing[1] },
  image: {
    width: 220,
    height: 160,
    borderRadius: radius.lg,
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
  },
  icon: {
    width: 36,
    height: 36,
    borderRadius: radius.md,
    alignItems: "center",
    justifyContent: "center",
  },
  grow: { flex: 1 },
  viewer: { flex: 1, backgroundColor: "#000000" },
  viewerBar: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[3],
  },
});
