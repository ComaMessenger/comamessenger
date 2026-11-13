import { useEffect, useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  StyleSheet,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Image } from "expo-image";
import { Share2, X } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import type { FileMetadata, MessengerAPI } from "@comamessenger/core";
import { spacing } from "@comamessenger/tokens";
import { openAttachment } from "@/files/open";
import { useFileSource } from "@/files/sources";
import { Text } from "@/ui/Text";

/**
 * Full-screen photo of a message, used by the feed and by the chat's media
 * archive. The one place a photo opens in the app: a richer viewer (swipes,
 * zoom, video) replaces this component, and every caller gets it.
 */
export function PhotoViewer({
  api,
  file,
  onClose,
  actions,
}: {
  api: MessengerAPI;
  /** The photo to show, or null when closed. */
  file: FileMetadata | null;
  onClose(): void;
  /** Extra buttons on the bar, before «share» (e.g. «show in chat»). */
  actions?: ReactNode;
}) {
  const { t } = useTranslation();
  // A modal is a new native window where SafeAreaView reads zero insets
  // (the close button sat under the status bar): pad from the app's insets.
  const insets = useSafeAreaInsets();
  const viewerSource = useFileSource(file?.id);
  // The full-size file can take seconds: the preview stands in meanwhile,
  // so the viewer is never a black screen.
  const previewSource = useFileSource(file?.preview_file_id ?? undefined);
  const [state, setState] = useState<"loading" | "loaded" | "failed">(
    "loading",
  );
  useEffect(() => setState("loading"), [file?.id]);
  return (
    <Modal
      visible={file !== null}
      animationType="fade"
      onRequestClose={onClose}
    >
      <View
        testID="photo-viewer"
        style={[
          styles.viewer,
          { paddingTop: insets.top, paddingBottom: insets.bottom },
        ]}
      >
        <View style={styles.viewerBar}>
          <Pressable
            testID="photo-viewer-close"
            accessibilityRole="button"
            accessibilityLabel={t("close")}
            style={styles.viewerButton}
            onPress={onClose}
          >
            <X size={26} color="#ffffff" />
          </Pressable>
          <View style={styles.actions}>
            {actions}
            {file && (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("share")}
                style={styles.viewerButton}
                onPress={() =>
                  void openAttachment(api, file).catch(() =>
                    Alert.alert(t("fileUnavailable")),
                  )
                }
              >
                <Share2 size={24} color="#ffffff" />
              </Pressable>
            )}
          </View>
        </View>
        <View
          testID={state === "loaded" ? "photo-viewer-loaded" : undefined}
          style={styles.grow}
        >
          {viewerSource && (
            <Image
              source={viewerSource}
              placeholder={previewSource ?? undefined}
              placeholderContentFit="contain"
              contentFit="contain"
              cachePolicy="disk"
              style={styles.grow}
              accessibilityLabel={file?.name}
              onLoad={() => setState("loaded")}
              onError={() => setState("failed")}
            />
          )}
          {state === "loading" && (
            <ActivityIndicator
              testID="photo-viewer-loading"
              color="#ffffff"
              style={styles.viewerOverlay}
            />
          )}
          {state === "failed" && (
            <View style={styles.viewerOverlay}>
              <Text size={15} style={styles.viewerText}>
                {t("photoLoadFailed")}
              </Text>
            </View>
          )}
        </View>
      </View>
    </Modal>
  );
}

/** A white bar button of the viewer. */
export const viewerButtonStyle = {
  width: 44,
  height: 44,
  alignItems: "center",
  justifyContent: "center",
} as const;

const styles = StyleSheet.create({
  viewerOverlay: {
    ...StyleSheet.absoluteFill,
    alignItems: "center",
    justifyContent: "center",
  },
  viewerText: { color: "#ffffff", textAlign: "center" },
  grow: { flex: 1 },
  viewerButton: viewerButtonStyle,
  actions: { flexDirection: "row", gap: spacing[1] },
  viewer: { flex: 1, backgroundColor: "#000000" },
  viewerBar: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[3],
  },
});
