import { useEffect, useState } from "react";
import { Alert, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  canAccessSettingsPage,
  infrastructureDirty,
  infrastructureUpdate,
  normalizeInfrastructure,
  validPort,
  type InfrastructureSettings,
} from "@comamessenger/core";
import { messageOf } from "@/lib/errors";
import { useSignedIn } from "@/session/SessionProvider";
import { Button } from "@/ui/Button";
import { Notice } from "@/ui/Notice";
import { PickerSheet } from "@/ui/PickerSheet";
import {
  ActionRow,
  Divider,
  GroupBody,
  NavRow,
  SettingsGroup,
  SwitchRow,
} from "@/ui/Settings";
import { TextField } from "@/ui/TextField";
import { SettingsScreen } from "./SettingsScreen";

type Security = InfrastructureSettings["smtp"]["security"];

/**
 * S3 storage and SMTP mail of the workspace. Saved with an explicit button,
 * as on the web: secrets are never shown, an empty field keeps the stored one.
 * «Check connection» works on saved settings only.
 */
export function InfrastructureScreen() {
  const { t } = useTranslation();
  const { api, user } = useSignedIn();
  const allowed = canAccessSettingsPage(user, "infrastructure");
  const query = useQuery({
    queryKey: ["infrastructure-settings"],
    queryFn: () => api.infrastructure(),
    enabled: allowed,
  });
  const [value, setValue] = useState<InfrastructureSettings | null>(null);
  const [baseline, setBaseline] = useState<InfrastructureSettings | null>(null);
  const [secrets, setSecrets] = useState({
    s3AccessKey: "",
    s3SecretKey: "",
    smtpPassword: "",
  });
  const [pending, setPending] = useState(false);
  const [testing, setTesting] = useState<"s3" | "smtp" | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(
    null,
  );
  const [securityPicker, setSecurityPicker] = useState(false);
  useEffect(() => {
    if (!query.data) return;
    const normalized = normalizeInfrastructure(query.data);
    setValue(normalized);
    setBaseline(normalized);
  }, [query.data]);
  const dirty = infrastructureDirty(value, baseline, secrets);
  const portValid = value ? validPort(value.smtp.port) : true;

  async function save() {
    if (!value) return;
    setPending(true);
    setResult(null);
    try {
      const updated = normalizeInfrastructure(
        await api.updateInfrastructure(infrastructureUpdate(value, secrets)),
      );
      setValue(updated);
      setBaseline(updated);
      setSecrets({ s3AccessKey: "", s3SecretKey: "", smtpPassword: "" });
      setResult({ ok: true, text: t("changesSaved") });
    } catch (cause) {
      setResult({ ok: false, text: messageOf(cause) });
    } finally {
      setPending(false);
    }
  }

  async function test(kind: "s3" | "smtp") {
    setTesting(kind);
    try {
      const outcome = await api.testInfrastructure(kind);
      Alert.alert(
        outcome.ok ? t("connectionSuccessful") : t("connectionFailed"),
        outcome.ok ? undefined : outcome.message,
      );
    } catch (cause) {
      Alert.alert(t("connectionFailed"), messageOf(cause));
    } finally {
      setTesting(null);
    }
  }

  const s3 = (change: Partial<InfrastructureSettings["s3"]>) =>
    value && setValue({ ...value, s3: { ...value.s3, ...change } });
  const smtp = (change: Partial<InfrastructureSettings["smtp"]>) =>
    value && setValue({ ...value, smtp: { ...value.smtp, ...change } });
  const securityLabel = (security: Security) =>
    security === "none" ? t("noEncryption") : security.toUpperCase();
  const plain = { autoCapitalize: "none", autoCorrect: false } as const;

  return (
    <SettingsScreen
      title={t("connections")}
      allowed={allowed}
      query={query}
      testID="settings-infrastructure-screen"
    >
      {value && (
        <>
          <SettingsGroup title={t("s3Storage")} hint={t("s3StorageHint")}>
            <GroupBody>
              <TextField
                testID="s3-endpoint"
                label={t("endpoint")}
                placeholder="https://s3.example.com"
                keyboardType="url"
                value={value.s3.endpoint}
                onChangeText={(endpoint) => s3({ endpoint })}
                {...plain}
              />
              <TextField
                label={t("region")}
                placeholder="ru-central1"
                value={value.s3.region}
                onChangeText={(region) => s3({ region })}
                {...plain}
              />
              <TextField
                testID="s3-bucket"
                label={t("bucket")}
                value={value.s3.bucket}
                onChangeText={(bucket) => s3({ bucket })}
                {...plain}
              />
              <TextField
                label={t("prefix")}
                placeholder="coma"
                value={value.s3.prefix}
                onChangeText={(prefix) => s3({ prefix })}
                {...plain}
              />
              <TextField
                label={t("accessKey")}
                placeholder={value.s3.access_key_hint || t("notConfigured")}
                value={secrets.s3AccessKey}
                onChangeText={(s3AccessKey) =>
                  setSecrets({ ...secrets, s3AccessKey })
                }
                {...plain}
              />
              <TextField
                label={t("secretKey")}
                secureTextEntry
                placeholder={
                  value.s3.credentials_configured
                    ? "••••••••"
                    : t("notConfigured")
                }
                value={secrets.s3SecretKey}
                onChangeText={(s3SecretKey) =>
                  setSecrets({ ...secrets, s3SecretKey })
                }
                {...plain}
              />
            </GroupBody>
            <Divider />
            <SwitchRow
              label={t("forcePathStyle")}
              hint={t("forcePathStyleHint")}
              value={value.s3.force_path_style}
              onChange={(force_path_style) => s3({ force_path_style })}
            />
            <Divider />
            <ActionRow
              testID="s3-test"
              label={t("testConnection")}
              hint={dirty ? t("testNeedsSave") : undefined}
              pending={testing === "s3"}
              disabled={dirty || pending || testing !== null}
              onPress={() => void test("s3")}
            />
          </SettingsGroup>

          <SettingsGroup title={t("smtpDelivery")} hint={t("smtpDeliveryHint")}>
            <GroupBody>
              <TextField
                testID="smtp-host"
                label={t("host")}
                value={value.smtp.host}
                onChangeText={(host) => smtp({ host })}
                {...plain}
              />
              <TextField
                testID="smtp-port"
                label={t("port")}
                keyboardType="number-pad"
                value={value.smtp.port ? String(value.smtp.port) : ""}
                onChangeText={(port) =>
                  smtp({ port: Number(port.replace(/\D/g, "")) || 0 })
                }
                error={portValid ? undefined : t("fieldPort")}
              />
              <TextField
                label={t("username")}
                value={value.smtp.username}
                onChangeText={(username) => smtp({ username })}
                {...plain}
              />
              <TextField
                label={t("password")}
                secureTextEntry
                placeholder={
                  value.smtp.credentials_configured
                    ? "••••••••"
                    : t("notConfigured")
                }
                value={secrets.smtpPassword}
                onChangeText={(smtpPassword) =>
                  setSecrets({ ...secrets, smtpPassword })
                }
                {...plain}
              />
              <TextField
                label={t("fromAddress")}
                keyboardType="email-address"
                value={value.smtp.from_address}
                onChangeText={(from_address) => smtp({ from_address })}
                {...plain}
              />
              <TextField
                label={t("fromName")}
                value={value.smtp.from_name}
                onChangeText={(from_name) => smtp({ from_name })}
              />
            </GroupBody>
            <Divider />
            <NavRow
              testID="smtp-security"
              label={t("smtpSecurity")}
              value={securityLabel(value.smtp.security)}
              onPress={() => setSecurityPicker(true)}
            />
            <Divider />
            <ActionRow
              testID="smtp-test"
              label={t("testConnection")}
              hint={dirty ? t("testNeedsSave") : undefined}
              pending={testing === "smtp"}
              disabled={dirty || pending || testing !== null}
              onPress={() => void test("smtp")}
            />
          </SettingsGroup>

          {result && (
            <Notice
              tone={result.ok ? "success" : "danger"}
              title={result.text}
            />
          )}
          <View>
            <Button
              testID="infrastructure-save"
              label={t("saveInfrastructure")}
              pending={pending}
              disabled={!dirty || !portValid}
              onPress={() => void save()}
            />
          </View>
          <PickerSheet<Security>
            visible={securityPicker}
            title={t("smtpSecurity")}
            value={value.smtp.security}
            options={(["starttls", "tls", "none"] as const).map((security) => ({
              value: security,
              label: securityLabel(security),
            }))}
            onSelect={(security) => smtp({ security })}
            onClose={() => setSecurityPicker(false)}
          />
        </>
      )}
    </SettingsScreen>
  );
}
