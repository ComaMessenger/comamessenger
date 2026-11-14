import type { ReactNode } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import { spacing } from "@comamessenger/tokens";
import { isNetworkError, messageOf } from "@/lib/errors";
import { useTheme } from "@/lib/theme";
import { Notice } from "@/ui/Notice";
import { ScreenHeader } from "@/ui/ScreenHeader";

type Loadable = {
  isPending: boolean;
  isError: boolean;
  error: unknown;
  data: unknown;
  refetch(): unknown;
};

/**
 * A settings screen: header, then the content, or what stands in for it —
 * no access, loading, or a failed load with «Повторить» (offline says so).
 * Content scrolls and keeps clear of the keyboard.
 */
export function SettingsScreen({
  title,
  subtitle,
  trailing,
  testID,
  allowed = true,
  query,
  scroll = true,
  children,
}: {
  title: string;
  subtitle?: string;
  trailing?: ReactNode;
  testID?: string;
  /** False shows «no access» instead of the content. */
  allowed?: boolean;
  /** The data the screen needs; its state replaces the content until loaded. */
  query?: Loadable | Loadable[];
  /** False lets the content manage its own scrolling (lists). */
  scroll?: boolean;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const queries = query ? (Array.isArray(query) ? query : [query]) : [];
  const failed = queries.find(
    (item) => item.isError && item.data === undefined,
  );
  const pending = queries.some((item) => item.isPending && !item.isError);
  let body: ReactNode = children;
  if (!allowed)
    body = (
      <View style={styles.state}>
        <Notice
          tone="neutral"
          title={t("settingsNoAccess")}
          hint={t("settingsNoAccessHint")}
        />
      </View>
    );
  else if (failed)
    body = (
      <View style={styles.state}>
        <Notice
          title={
            isNetworkError(failed.error)
              ? t("settingsOffline")
              : t("settingsLoadFailed")
          }
          hint={
            isNetworkError(failed.error)
              ? t("settingsOfflineHint")
              : messageOf(failed.error)
          }
          actionLabel={t("retry")}
          onAction={() => {
            for (const item of queries) if (item.isError) void item.refetch();
          }}
        />
      </View>
    );
  else if (pending)
    body = <ActivityIndicator style={styles.loader} color={theme.muted} />;
  else if (scroll)
    body = (
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
      >
        {children}
      </ScrollView>
    );
  return (
    <SafeAreaView
      testID={testID}
      edges={["bottom"]}
      style={[styles.screen, { backgroundColor: theme.canvas }]}
    >
      <ScreenHeader title={title} subtitle={subtitle} trailing={trailing} />
      <KeyboardAvoidingView
        style={styles.screen}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        {body}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

/** Padding and width of settings content outside `SettingsScreen` scrolling. */
export const settingsContent = {
  padding: spacing[4],
  gap: spacing[5],
  width: "100%",
  maxWidth: 640,
  alignSelf: "center",
} as const;

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: settingsContent,
  state: { padding: spacing[4] },
  loader: { marginTop: spacing[10] },
});
