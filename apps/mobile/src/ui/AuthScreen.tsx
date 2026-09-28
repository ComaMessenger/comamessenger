import type { ReactNode } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { spacing } from "@comamessenger/tokens";
import { useTheme } from "@/lib/theme";
import { Text } from "./Text";
import { WorkspaceMark } from "./WorkspaceMark";

/** Layout of the screens outside the messenger: mark, title, lead and a form. */
export function AuthScreen({
  title,
  lead,
  markName,
  children,
}: {
  title: string;
  lead?: string;
  markName: string;
  children: ReactNode;
}) {
  const theme = useTheme();
  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: theme.canvas }]}>
      <KeyboardAvoidingView
        style={styles.safe}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
        >
          <WorkspaceMark name={markName} />
          <View style={styles.heading}>
            <Text accessibilityRole="header" weight="bold" size={32}>
              {title}
            </Text>
            {lead ? (
              <Text tone="muted" size={16}>
                {lead}
              </Text>
            ) : null}
          </View>
          <View style={styles.form}>{children}</View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  content: {
    paddingHorizontal: spacing[5],
    paddingTop: spacing[8],
    paddingBottom: spacing[8],
    gap: spacing[6],
  },
  heading: { gap: spacing[2] },
  form: { gap: spacing[4] },
});
