import { useEffect, useState } from "react";
import { Alert, Platform, StyleSheet, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { Copy } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { radius, spacing } from "@comamessenger/tokens";
import { useTheme } from "@/lib/theme";
import { Button } from "@/ui/Button";
import { ActionRow, Divider, GroupBody, SettingsGroup } from "@/ui/Settings";
import { Text } from "@/ui/Text";

/** Copies text, saying so for a moment on the row. */
export function CopyRow({
  label,
  text,
  secret = false,
  testID,
}: {
  label: string;
  text: string;
  /** Asks first: a secret in the clipboard is readable by other apps. */
  secret?: boolean;
  testID?: string;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  const copy = async () => {
    await Clipboard.setStringAsync(text);
    setCopied(true);
  };
  return (
    <ActionRow
      testID={testID}
      icon={Copy}
      label={copied ? t("connCopied") : label}
      onPress={() => {
        if (!secret) return void copy();
        Alert.alert(
          t("connWebhookCopyWarnTitle"),
          t("connWebhookCopyWarnText"),
          [
            { text: t("cancel"), style: "cancel" },
            { text: t("connCopy"), onPress: () => void copy() },
          ],
        );
      }}
    />
  );
}

/** Monospace value the person may select and read aloud. */
export function CodeValue({
  label,
  value,
  testID,
}: {
  label: string;
  value: string;
  testID?: string;
}) {
  const theme = useTheme();
  return (
    <View style={styles.value}>
      <Text tone="muted" size={13} weight="medium">
        {label}
      </Text>
      <Text
        testID={testID}
        selectable
        size={14.5}
        style={[
          styles.code,
          { backgroundColor: theme.sidebar, borderColor: theme.border },
        ]}
      >
        {value}
      </Text>
    </View>
  );
}

/**
 * The webhook secret right after creation or rotation: shown once, in this
 * component's props only — never cached, stored or put into a route. The
 * app switcher snapshot is covered by `PrivacyCover` of the signed-in layout.
 */
export function SecretOnce({
  url,
  secret,
  onDone,
}: {
  url: string;
  secret: string;
  onDone(): void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <SettingsGroup
        title={t("connWebhookSecretOnce")}
        hint={t("connWebhookSigning")}
      >
        <GroupBody>
          <Text tone="muted" size={14}>
            {t("connWebhookSecretOnceHint")}
          </Text>
          <CodeValue label={t("connWebhookURL")} value={url} />
          <CodeValue
            label={t("connWebhookSecret")}
            value={secret}
            testID="webhook-secret"
          />
        </GroupBody>
        <Divider />
        <CopyRow label={t("connWebhookCopyURL")} text={url} />
        <Divider />
        <CopyRow
          testID="webhook-secret-copy"
          label={t("connWebhookCopySecret")}
          text={secret}
          secret
        />
      </SettingsGroup>
      <Button
        testID="webhook-secret-saved"
        label={t("connWebhookSecretSaved")}
        onPress={onDone}
      />
    </>
  );
}

const styles = StyleSheet.create({
  value: { gap: spacing[1] },
  code: {
    fontFamily: Platform.select({ ios: "Menlo", default: "monospace" }),
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
  },
});
