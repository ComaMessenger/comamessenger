import { useState } from "react";
import { Alert, Pressable, Share, StyleSheet, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  canAccessSettingsPage,
  hasPermission,
  invitationTTLRange,
  organizationFields,
  roleLabelKey,
  validEmail,
  validInvitationTTL,
  type InvitationSummary,
} from "@comamessenger/core";
import { radius, spacing } from "@comamessenger/tokens";
import { messageOf } from "@/lib/errors";
import { useTheme } from "@/lib/theme";
import { useSignedIn } from "@/session/SessionProvider";
import { Button } from "@/ui/Button";
import { Notice } from "@/ui/Notice";
import { PickerSheet } from "@/ui/PickerSheet";
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
import { useOrganizationAutosave } from "./organization";

type Role = "admin" | "member";

/**
 * Invitations, as on the web: anyone allowed to invite creates one for an
 * email and gets the link to share; with invitations.manage also the
 * invitation policy and the list of active invitations (new link, revoke).
 */
export function InvitationsScreen() {
  const { t, i18n } = useTranslation();
  const theme = useTheme();
  const { api, user } = useSignedIn();
  const allowed = canAccessSettingsPage(user, "workspace-invitations");
  const canManage = hasPermission(user, "invitations.manage");
  const { query, draft, setDraft, autosave } = useOrganizationAutosave(
    organizationFields.invitations,
    canManage,
    (value) => validInvitationTTL(value.invitation_ttl_hours),
  );
  const invitations = useQuery({
    queryKey: ["invitations"],
    queryFn: () => api.invitations(),
    enabled: canManage,
  });
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [picker, setPicker] = useState<"invite" | "default" | null>(null);
  const [ttl, setTTL] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [link, setLink] = useState<{ url: string; note: string } | null>(null);
  const [error, setError] = useState("");
  const emailInvalid = email.length > 0 && !validEmail(email);

  const roleOptions: { value: Role; label: string }[] = [
    { value: "member", label: t("roleMember") },
    { value: "admin", label: t("roleAdmin") },
  ];
  const format = (iso: string) =>
    new Intl.DateTimeFormat(i18n.language, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(iso));

  async function create() {
    setPending(true);
    setError("");
    setLink(null);
    try {
      const invitation = await api.createInvitation({
        email: email.trim(),
        ...(canManage ? { role } : {}),
      });
      setEmail("");
      setLink({
        url: invitation.accept_url ?? "",
        note: invitation.email_sent
          ? t("invitationCreatedAndSent")
          : t("invitationCreated"),
      });
      if (canManage) void invitations.refetch();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setPending(false);
    }
  }

  async function rotate(invitation: InvitationSummary) {
    setBusy(invitation.id);
    try {
      const replacement = await api.rotateInvitation(invitation.id);
      setLink({
        url: replacement.accept_url ?? "",
        note: replacement.email_sent
          ? t("invitationRotatedAndSent")
          : t("invitationRotated"),
      });
      await invitations.refetch();
    } catch (cause) {
      Alert.alert(messageOf(cause));
    } finally {
      setBusy(null);
    }
  }

  function revoke(invitation: InvitationSummary) {
    Alert.alert(
      t("revokeInvitationConfirm", { email: invitation.email }),
      t("revokeInvitationConfirmHint"),
      [
        { text: t("cancel"), style: "cancel" },
        {
          text: t("revokeInvitation"),
          style: "destructive",
          onPress: () => {
            setBusy(invitation.id);
            void api
              .revokeInvitation(invitation.id)
              .then(() => invitations.refetch())
              .catch((cause) => Alert.alert(messageOf(cause)))
              .finally(() => setBusy(null));
          },
        },
      ],
    );
  }

  function manage(invitation: InvitationSummary) {
    Alert.alert(invitation.email, undefined, [
      { text: t("rotateInvitation"), onPress: () => void rotate(invitation) },
      {
        text: t("revokeInvitation"),
        style: "destructive",
        onPress: () => revoke(invitation),
      },
      { text: t("cancel"), style: "cancel" },
    ]);
  }

  return (
    <SettingsScreen
      title={t("invitations")}
      allowed={allowed}
      query={canManage ? [query, invitations] : undefined}
      testID="settings-invitations-screen"
    >
      {canManage && draft && (
        <AutosaveStatus {...autosave} onRetry={autosave.retry} />
      )}

      <SettingsGroup
        title={t("createInvitation")}
        hint={t("createInvitationHint")}
      >
        <GroupBody>
          <TextField
            testID="invite-email"
            label={t("inviteEmail")}
            value={email}
            onChangeText={(value) => {
              setEmail(value);
              setError("");
            }}
            keyboardType="email-address"
            autoComplete="email"
            autoCapitalize="none"
            autoCorrect={false}
            error={emailInvalid ? t("fieldEmail") : undefined}
          />
        </GroupBody>
        {canManage && (
          <>
            <Divider />
            <NavRow
              testID="invite-role"
              label={t("inviteRole")}
              value={t(roleLabelKey(role))}
              onPress={() => setPicker("invite")}
            />
            <Divider />
          </>
        )}
        <GroupBody>
          {error ? <Notice title={error} /> : null}
          <Button
            testID="invite-submit"
            label={t("createInvitation")}
            pending={pending}
            disabled={!email || emailInvalid}
            onPress={() => void create()}
          />
        </GroupBody>
      </SettingsGroup>

      {link && (
        <View
          testID="invite-result"
          style={[
            styles.result,
            {
              backgroundColor: theme.successSoft,
              borderColor: theme.successBorder,
            },
          ]}
        >
          <Text
            weight="semibold"
            size={15}
            style={{ color: theme.successText }}
          >
            {link.note}
          </Text>
          {link.url ? (
            <>
              <Text tone="muted" size={14}>
                {t("invitationLinkHint")}
              </Text>
              <Text
                testID="invite-link"
                selectable
                size={14}
                numberOfLines={3}
                style={[styles.link, { backgroundColor: theme.surface }]}
              >
                {link.url}
              </Text>
              <View style={styles.actions}>
                <View style={styles.grow}>
                  <Button
                    testID="invite-share"
                    label={t("shareLink")}
                    onPress={() =>
                      void Share.share({
                        message: t("invitationShareText", {
                          workspace: user.organization_name,
                          url: link.url,
                        }),
                      })
                    }
                  />
                </View>
                <View style={styles.grow}>
                  <Button
                    testID="invite-copy"
                    variant="secondary"
                    label={t("copyLink")}
                    onPress={() =>
                      void Clipboard.setStringAsync(link.url).then(() =>
                        Alert.alert(t("linkCopied")),
                      )
                    }
                  />
                </View>
              </View>
            </>
          ) : null}
        </View>
      )}

      {canManage && draft && (
        <SettingsGroup
          title={t("invitationPolicy")}
          hint={t("invitationPolicyHint")}
        >
          <NavRow
            testID="invite-default-role"
            label={t("defaultRole")}
            value={t(roleLabelKey(draft.invitation_default_role))}
            onPress={() => setPicker("default")}
          />
          <Divider />
          <GroupBody>
            <TextField
              testID="invite-ttl"
              label={t("invitationTTL")}
              keyboardType="number-pad"
              value={ttl ?? String(draft.invitation_ttl_hours)}
              onChangeText={(value) => {
                const digits = value.replace(/\D/g, "");
                setTTL(digits);
                setDraft({
                  ...draft,
                  invitation_ttl_hours: digits ? Number(digits) : 0,
                });
              }}
              onBlur={() => setTTL(null)}
              error={
                validInvitationTTL(draft.invitation_ttl_hours)
                  ? undefined
                  : t("fieldInvitationTTL", invitationTTLRange)
              }
            />
          </GroupBody>
          <Divider />
          <SwitchRow
            testID="invite-allow-members"
            label={t("allowMemberInvitations")}
            hint={t("allowMemberInvitationsHint")}
            value={draft.allow_member_invitations}
            onChange={(allow_member_invitations) =>
              setDraft({ ...draft, allow_member_invitations })
            }
          />
        </SettingsGroup>
      )}

      {canManage && (
        <SettingsGroup
          title={t("activeInvitations")}
          hint={t("activeInvitationsHint")}
        >
          {invitations.data?.length ? (
            invitations.data.map((invitation, index) => (
              <View key={invitation.id}>
                {index > 0 && <Divider />}
                <Pressable
                  testID={`invitation-row-${index}`}
                  accessibilityRole="button"
                  accessibilityHint={t("invitationActionsHint")}
                  disabled={busy !== null}
                  onPress={() => manage(invitation)}
                  style={({ pressed }) => [
                    styles.row,
                    pressed && { backgroundColor: theme.surfaceSelected },
                  ]}
                >
                  <View style={styles.grow}>
                    <Text size={16} numberOfLines={1}>
                      {invitation.email}
                    </Text>
                    <Text tone="muted" size={13.5}>
                      {[
                        t(roleLabelKey(invitation.role)),
                        t("invitationCreatedBy", {
                          name: invitation.created_by_name,
                        }),
                        t("invitationExpires", {
                          time: format(invitation.expires_at),
                        }),
                      ].join(" · ")}
                    </Text>
                    <Text
                      size={13.5}
                      tone={
                        invitation.status === "expired" ? "danger" : "subtle"
                      }
                    >
                      {t(
                        invitation.status === "expired"
                          ? "invitationStatusExpired"
                          : "invitationStatusActive",
                      )}
                    </Text>
                  </View>
                  <Text tone="primary" weight="semibold" size={15}>
                    {t("manage")}
                  </Text>
                </Pressable>
              </View>
            ))
          ) : (
            <GroupBody>
              <Text tone="muted" size={14}>
                {t("noActiveInvitations")}
              </Text>
            </GroupBody>
          )}
        </SettingsGroup>
      )}

      <PickerSheet<Role>
        testID="role-picker"
        visible={picker !== null}
        title={picker === "default" ? t("defaultRole") : t("inviteRole")}
        value={
          picker === "default" && draft ? draft.invitation_default_role : role
        }
        options={roleOptions}
        onSelect={(value) =>
          picker === "default" && draft
            ? setDraft({ ...draft, invitation_default_role: value })
            : setRole(value)
        }
        onClose={() => setPicker(null)}
      />
    </SettingsScreen>
  );
}

const styles = StyleSheet.create({
  grow: { flex: 1, minWidth: 0 },
  result: {
    gap: spacing[2],
    padding: spacing[4],
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
  },
  link: { padding: spacing[2], borderRadius: radius.md },
  actions: { flexDirection: "row", gap: spacing[2], flexWrap: "wrap" },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing[3],
    minHeight: 64,
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[2],
  },
});
