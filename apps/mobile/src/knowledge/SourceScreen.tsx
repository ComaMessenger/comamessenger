import {
  ActivityIndicator,
  Platform,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import * as Sharing from "expo-sharing";
import { WebView } from "@expo/dom-webview";
import { Share } from "lucide-react-native";
import { fileLabel, sourceView, type KnowledgeDocument } from "@comamessenger/core";
import { radius, spacing } from "@comamessenger/tokens";
import { isNetworkError, messageOf } from "@/lib/errors";
import { useTheme } from "@/lib/theme";
import { useSignedIn } from "@/session/SessionProvider";
import { Button } from "@/ui/Button";
import { IconButton } from "@/ui/IconButton";
import { Notice } from "@/ui/Notice";
import { ScreenHeader } from "@/ui/ScreenHeader";
import { Text } from "@/ui/Text";
import { bytes } from "./format";
import { useDocument } from "./queries";
import { downloadSource, textPreviewBytes, textPreviewChars } from "./source";

const monospace = Platform.select({ ios: "Menlo", default: "monospace" });

/**
 * The original file of a document. PDF, DOCX and XLSX open in the built-in
 * viewer on iOS; text formats show as plain text (an uploaded HTML file never
 * renders as a page); anything the phone cannot show goes to other apps.
 */
export function SourceScreen({ documentID }: { documentID: string }) {
  const { t } = useTranslation();
  const theme = useTheme();
  const { api } = useSignedIn();
  const document = useDocument(documentID);
  const value = document.data;
  const view = value ? sourceView(value) : "other";
  const file = useQuery({
    queryKey: ["knowledge-source", documentID, value?.content_version],
    queryFn: () => downloadSource(api, value!),
    enabled: Boolean(value && value.kind === "file"),
    staleTime: Infinity,
    retry: false,
  });
  const showText =
    view === "text" && (value?.file_size ?? 0) <= textPreviewBytes;
  const text = useQuery({
    queryKey: ["knowledge-source-text", documentID, value?.content_version],
    queryFn: async () => {
      const content = await file.data!.text();
      return {
        content: content.slice(0, textPreviewChars),
        truncated: content.length > textPreviewChars,
      };
    },
    enabled: Boolean(file.data && showText),
    staleTime: Infinity,
  });
  const inline =
    Platform.OS === "ios" && (view === "pdf" || view === "office");

  async function share() {
    if (!file.data || !value) return;
    await Sharing.shareAsync(file.data.uri, {
      mimeType: value.file_mime ?? undefined,
      dialogTitle: value.file_name ?? value.title,
    }).catch(() => undefined);
  }

  const failure = document.isError ? document.error : file.isError ? file.error : null;
  let body;
  if (failure)
    body = (
      <View style={styles.state}>
        <Notice
          title={t("kbSourceFailed")}
          hint={isNetworkError(failure) ? t("kbOfflineHint") : messageOf(failure)}
          actionLabel={t("retry")}
          onAction={() => {
            if (document.isError) void document.refetch();
            else void file.refetch();
          }}
        />
      </View>
    );
  else if (!file.data || (showText && !text.data))
    body = (
      <View style={styles.loading} accessibilityLiveRegion="polite">
        <ActivityIndicator color={theme.muted} />
        <Text tone="muted" size={14}>
          {t("kbSourceLoading")}
        </Text>
      </View>
    );
  else if (inline)
    body = (
      <WebView
        testID="kb-source-viewer"
        source={{ uri: file.data.uri }}
        style={[styles.flex, { backgroundColor: theme.canvas }]}
        containerStyle={styles.flex}
      />
    );
  else if (showText && text.data)
    body = (
      <ScrollView
        testID="kb-source-text"
        contentContainerStyle={styles.text}
      >
        {text.data.truncated ? (
          <Text tone="muted" size={13}>
            {t("kbSourceTruncated")}
          </Text>
        ) : null}
        <Text
          selectable
          size={14}
          style={value?.file_name?.toLowerCase().endsWith(".csv") ? { fontFamily: monospace } : undefined}
        >
          {text.data.content}
        </Text>
      </ScrollView>
    );
  else
    body = (
      <View style={styles.state}>
        <Notice
          tone="neutral"
          title={t("kbSourceNoPreview")}
          hint={t("kbSourceNoPreviewHint")}
        />
        <Button
          testID="kb-source-open-in"
          label={t("kbSourceOpenIn")}
          onPress={() => void share()}
        />
      </View>
    );

  return (
    <SafeAreaView
      testID="kb-source-screen"
      edges={["bottom"]}
      style={[styles.flex, { backgroundColor: theme.canvas }]}
    >
      <ScreenHeader
        title={value?.title ?? t("kbOpenSource")}
        subtitle={
          value
            ? [fileLabel(value as KnowledgeDocument), value.file_size ? bytes(value.file_size) : ""]
                .filter(Boolean)
                .join(" · ")
            : undefined
        }
        backTestID="kb-back"
        trailing={
          <IconButton
            testID="kb-source-share"
            label={t("share")}
            disabled={!file.data}
            onPress={() => void share()}
            icon={(color) => <Share size={21} color={color} />}
          />
        }
      />
      {body}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  state: { padding: spacing[4], gap: spacing[3] },
  loading: {
    alignItems: "center",
    gap: spacing[2],
    marginTop: spacing[10],
  },
  text: {
    padding: spacing[4],
    gap: spacing[3],
    borderRadius: radius.md,
  },
});
