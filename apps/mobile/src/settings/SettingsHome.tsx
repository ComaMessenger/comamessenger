import { Pressable, StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { ChevronRight } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { radius, spacing } from "@comamessenger/tokens";
import { useSignedIn } from "@/session/SessionProvider";
import { useTheme } from "@/lib/theme";
import { Avatar } from "@/ui/Avatar";
import { Divider, NavRow, SettingsGroup } from "@/ui/Settings";
import { Text } from "@/ui/Text";
import { roleLabelKey } from "@comamessenger/core";
import { SettingsScreen } from "./SettingsScreen";
import {
  personalLinks,
  securityLinks,
  workspaceLinks,
  type SettingsLink,
} from "./sections";

/**
 * «Настройки»: personal pages, security and — by permissions — the workspace.
 * A section the user may not open is not listed at all.
 */
export function SettingsHome() {
  const { t } = useTranslation();
  const theme = useTheme();
  const { user } = useSignedIn();
  const workspace = workspaceLinks(user);
  const links = (items: SettingsLink[], hints = false) =>
    items.map((item, index) => (
      <View key={item.id}>
        {index > 0 && <Divider />}
        <NavRow
          testID={`settings-${item.id}`}
          icon={item.icon}
          label={t(item.labelKey)}
          hint={hints && item.hintKey ? t(item.hintKey) : undefined}
          onPress={() => router.push(item.href as never)}
        />
      </View>
    ));
  return (
    <SettingsScreen title={t("settingsTitle")} testID="settings-home">
      <Pressable
        testID="settings-account"
        accessibilityRole="button"
        accessibilityLabel={`${user.display_name}, ${user.email}`}
        accessibilityHint={t("openProfileHint")}
        onPress={() => router.push("/settings/profile")}
        style={({ pressed }) => [
          styles.card,
          {
            backgroundColor: pressed ? theme.surfaceSelected : theme.surface,
            borderColor: theme.border,
          },
        ]}
      >
        <Avatar
          name={user.display_name}
          seed={user.id}
          size={52}
          actorID={user.id}
          avatarVersion={user.avatar_version}
        />
        <View style={styles.grow}>
          <Text weight="semibold" size={17} numberOfLines={1}>
            {user.display_name}
          </Text>
          <Text tone="muted" size={14} numberOfLines={1}>
            {user.email}
          </Text>
          <Text tone="subtle" size={13} numberOfLines={1}>
            {user.organization_name} · {t(roleLabelKey(user.role))}
          </Text>
        </View>
        <ChevronRight size={20} color={theme.subtle} />
      </Pressable>
      <SettingsGroup title={t("settingsPersonal")}>
        {links(personalLinks)}
      </SettingsGroup>
      <SettingsGroup title={t("settingsSecurity")}>
        {links(securityLinks)}
      </SettingsGroup>
      {workspace.length > 0 && (
        <SettingsGroup title={t("settingsWorkspace")}>
          {links(workspace, true)}
        </SettingsGroup>
      )}
    </SettingsScreen>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing[3],
    padding: spacing[4],
    borderRadius: radius.lg,
    borderWidth: 1,
  },
  grow: { flex: 1, minWidth: 0 },
});
