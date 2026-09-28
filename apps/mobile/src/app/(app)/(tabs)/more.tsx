import { Alert, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import Constants from "expo-constants";
import { ChevronRight, ExternalLink, LogOut } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { radius, spacing } from "@comamessenger/tokens";
import { useSession, useSignedIn } from "@/session/SessionProvider";
import { displayServer } from "@/lib/server";
import { useTheme } from "@/lib/theme";
import { openWebClient } from "@/lib/web";
import { Avatar } from "@/ui/Avatar";
import { Text } from "@/ui/Text";

export default function MoreScreen() {
  const { t } = useTranslation();
  const theme = useTheme();
  const { api, user } = useSignedIn();
  const { signOut } = useSession();

  function confirmSignOut() {
    Alert.alert(t("signOutConfirm"), undefined, [
      { text: t("cancel"), style: "cancel" },
      {
        text: t("signOut"),
        style: "destructive",
        onPress: () => void signOut(),
      },
    ]);
  }

  return (
    <SafeAreaView edges={["top"]} style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={[styles.card, { backgroundColor: theme.surface }]}>
          <Avatar name={user.display_name} seed={user.id} size={56} />
          <View style={styles.grow}>
            <Text weight="semibold" size={18} numberOfLines={1}>
              {user.display_name}
            </Text>
            <Text tone="muted" size={15} numberOfLines={1}>
              @{user.handle} · {user.organization_name}
            </Text>
            <Text tone="subtle" size={13} numberOfLines={1}>
              {displayServer(api.apiURL)}
            </Text>
          </View>
        </View>

        <View style={[styles.group, { backgroundColor: theme.surface }]}>
          <Pressable
            accessibilityRole="link"
            onPress={() => void openWebClient(api.apiURL)}
            style={styles.item}
          >
            <ExternalLink size={22} color={theme.primary} />
            <View style={styles.grow}>
              <Text weight="medium" size={17}>
                {t("openWeb")}
              </Text>
              <Text tone="muted" size={14}>
                {t("openWebHint")}
              </Text>
            </View>
            <ChevronRight size={20} color={theme.subtle} />
          </Pressable>
          <View style={[styles.divider, { backgroundColor: theme.border }]} />
          <Pressable
            accessibilityRole="button"
            onPress={confirmSignOut}
            style={styles.item}
          >
            <LogOut size={22} color={theme.danger} />
            <Text weight="medium" size={17} tone="danger" style={styles.grow}>
              {t("signOut")}
            </Text>
          </Pressable>
        </View>

        <Text tone="subtle" size={13} style={styles.version}>
          {t("appVersion", { version: Constants.expoConfig?.version ?? "" })}
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: { padding: spacing[4], gap: spacing[4] },
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing[3],
    padding: spacing[4],
    borderRadius: radius.xl,
  },
  group: { borderRadius: radius.xl, overflow: "hidden" },
  item: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing[3],
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[3],
    minHeight: 56,
  },
  divider: { height: StyleSheet.hairlineWidth, marginLeft: 54 },
  grow: { flex: 1 },
  version: { textAlign: "center" },
});
