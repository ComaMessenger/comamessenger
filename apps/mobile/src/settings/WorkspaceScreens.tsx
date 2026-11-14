import { StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import {
  canAccessSettingsPage,
  fieldErrorKey,
  organizationFields,
  roleLabelKey,
  validateWorkspaceGeneral,
} from "@comamessenger/core";
import { radius, spacing } from "@comamessenger/tokens";
import { useTheme } from "@/lib/theme";
import { useSignedIn } from "@/session/SessionProvider";
import {
  Divider,
  GroupBody,
  NavRow,
  SettingsGroup,
  SwitchRow,
} from "@/ui/Settings";
import { Text } from "@/ui/Text";
import { TextField } from "@/ui/TextField";
import { AutosaveStatus } from "./AutosaveStatus";
import { SettingsScreen } from "./SettingsScreen";
import { WorkspaceLogo } from "./WorkspaceLogo";
import { useOrganizationAutosave } from "./organization";
import { workspaceOverviewLinks } from "./sections";

/** The workspace card and the pages of the workspace this user may open. */
export function WorkspaceOverview() {
  const { t } = useTranslation();
  const theme = useTheme();
  const { user } = useSignedIn();
  const pages = workspaceOverviewLinks(user);
  return (
    <SettingsScreen
      title={t("workspaceSettings")}
      allowed={canAccessSettingsPage(user, "workspace")}
      testID="settings-workspace-screen"
    >
      <View
        style={[
          styles.card,
          { backgroundColor: theme.surface, borderColor: theme.border },
        ]}
      >
        <WorkspaceLogo name={user.organization_name} size={52} />
        <View style={styles.grow}>
          <Text weight="semibold" size={17} numberOfLines={2}>
            {user.organization_name}
          </Text>
          <Text tone="muted" size={14}>
            {t("workspaceRole", { role: t(roleLabelKey(user.role)) })}
          </Text>
        </View>
      </View>
      <SettingsGroup
        title={t("currentWorkspace")}
        hint={t("workspaceSettingsHint")}
      >
        {pages.map((page, index) => (
          <View key={page.id}>
            {index > 0 && <Divider />}
            <NavRow
              testID={`workspace-${page.id}`}
              icon={page.icon}
              label={t(page.labelKey)}
              hint={page.hintKey ? t(page.hintKey) : undefined}
              onPress={() => router.push(page.href as never)}
            />
          </View>
        ))}
      </SettingsGroup>
    </SettingsScreen>
  );
}

/** Name, short address and time zone of the workspace; saved as you type. */
export function WorkspaceGeneral() {
  const { t } = useTranslation();
  const { user } = useSignedIn();
  const allowed = canAccessSettingsPage(user, "workspace-general");
  const { query, draft, setDraft, autosave } = useOrganizationAutosave(
    organizationFields.general,
    allowed,
    (value) => Object.keys(validateWorkspaceGeneral(value)).length === 0,
  );
  const errors = draft ? validateWorkspaceGeneral(draft) : {};
  const error = (field: keyof typeof errors) =>
    errors[field] ? t(fieldErrorKey(errors[field]!)) : undefined;
  return (
    <SettingsScreen
      title={t("workspaceGeneral")}
      allowed={allowed}
      query={query}
      testID="settings-workspace-general-screen"
    >
      {draft && (
        <>
          <AutosaveStatus {...autosave} onRetry={autosave.retry} />
          <SettingsGroup hint={t("workspaceGeneralHint")}>
            <GroupBody>
              <TextField
                testID="workspace-name"
                label={t("organization")}
                value={draft.name}
                maxLength={120}
                onChangeText={(name) => setDraft({ ...draft, name })}
                error={error("name")}
              />
              <TextField
                testID="workspace-slug"
                label={t("slug")}
                value={draft.slug}
                autoCapitalize="none"
                autoCorrect={false}
                onChangeText={(slug) =>
                  setDraft({ ...draft, slug: slug.toLowerCase() })
                }
                error={error("slug")}
                hint={t("slugHint")}
              />
              <TextField
                testID="workspace-timezone"
                label={t("defaultWorkspaceTimezone")}
                value={draft.default_timezone}
                autoCapitalize="none"
                autoCorrect={false}
                maxLength={64}
                onChangeText={(default_timezone) =>
                  setDraft({ ...draft, default_timezone })
                }
                error={error("default_timezone")}
                hint={t("timezoneExample")}
              />
            </GroupBody>
          </SettingsGroup>
        </>
      )}
    </SettingsScreen>
  );
}

/** What regular members may create on their own. */
export function WorkspacePolicies() {
  const { t } = useTranslation();
  const { user } = useSignedIn();
  const allowed = canAccessSettingsPage(user, "workspace-policies");
  const { query, draft, setDraft, autosave } = useOrganizationAutosave(
    organizationFields.policies,
    allowed,
  );
  return (
    <SettingsScreen
      title={t("creationPolicy")}
      allowed={allowed}
      query={query}
      testID="settings-workspace-policies-screen"
    >
      {draft && (
        <>
          <AutosaveStatus {...autosave} onRetry={autosave.retry} />
          <SettingsGroup hint={t("creationPolicyHint")}>
            <SwitchRow
              testID="policy-public-chats"
              label={t("allowPublicChats")}
              hint={t("allowPublicChatsHint")}
              value={draft.allow_public_chat_creation}
              onChange={(allow_public_chat_creation) =>
                setDraft({ ...draft, allow_public_chat_creation })
              }
            />
            <Divider />
            <SwitchRow
              testID="policy-channels"
              label={t("allowChannels")}
              hint={t("allowChannelsHint")}
              value={draft.allow_channel_creation}
              onChange={(allow_channel_creation) =>
                setDraft({ ...draft, allow_channel_creation })
              }
            />
          </SettingsGroup>
        </>
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
