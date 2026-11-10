import type { ReactNode } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { radius, spacing } from "@comamessenger/tokens";
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
          <View style={styles.panel}>
            <View style={styles.brand}>
              <WorkspaceMark name={markName} size={36} />
              <Text weight="semibold" size={18} style={styles.brandName}>
                {markName}
              </Text>
            </View>
            <View
              style={[
                styles.card,
                { backgroundColor: theme.surface, borderColor: theme.border },
              ]}
            >
              <View style={styles.heading}>
                <Text
                  accessibilityRole="header"
                  weight="semibold"
                  size={26}
                  style={styles.title}
                >
                  {title}
                </Text>
                {lead ? (
                  <Text tone="muted" size={16}>
                    {lead}
                  </Text>
                ) : null}
              </View>
              <View style={styles.form}>{children}</View>
            </View>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  content: {
    flexGrow: 1,
    paddingHorizontal: spacing[4],
    paddingTop: spacing[8],
    paddingBottom: spacing[8],
    justifyContent: "center",
  },
  panel: { width: "100%", maxWidth: 480, alignSelf: "center", gap: spacing[6] },
  brand: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing[3],
    paddingHorizontal: spacing[1],
  },
  brandName: { flex: 1 },
  card: {
    borderWidth: 1,
    borderRadius: radius.xl,
    padding: spacing[5],
    gap: spacing[6],
  },
  title: { letterSpacing: -0.6 },
  heading: { gap: spacing[2] },
  form: { gap: spacing[4] },
});
