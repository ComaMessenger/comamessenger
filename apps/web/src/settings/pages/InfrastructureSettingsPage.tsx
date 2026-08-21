import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type {
  InfrastructureSettings,
  MessengerAPI,
  User,
} from "@comamessenger/core";
import { HardDrive, Mail, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { messageOf } from "../../errors";
import { Button, Field, FormError, SelectField, Skeleton } from "../../ui";
import {
  SettingsAccessDenied,
  SettingsSection,
  SettingsToggle,
} from "../components/SettingsPrimitives";
import {
  SettingsShell,
  type SettingsNavigate,
} from "../components/SettingsShell";
import { canAccessSettingsPage } from "../registry";

function normalizeInfrastructure(value: InfrastructureSettings) {
  return {
    ...value,
    smtp: {
      ...value.smtp,
      security: value.smtp.security || ("starttls" as const),
      port: value.smtp.port || 587,
    },
  };
}

function infrastructureFingerprint(value: InfrastructureSettings) {
  return JSON.stringify({
    s3: {
      endpoint: value.s3.endpoint,
      region: value.s3.region,
      bucket: value.s3.bucket,
      prefix: value.s3.prefix,
      force_path_style: value.s3.force_path_style,
    },
    smtp: {
      host: value.smtp.host,
      port: value.smtp.port,
      username: value.smtp.username,
      from_address: value.smtp.from_address,
      from_name: value.smtp.from_name,
      security: value.smtp.security,
    },
  });
}

export function InfrastructureSettingsPage({
  api,
  user,
  navigate,
}: {
  api: MessengerAPI;
  user: User;
  navigate: SettingsNavigate;
}) {
  const { t } = useTranslation();
  const allowed = canAccessSettingsPage(user, "infrastructure");
  const query = useQuery({
    queryKey: ["infrastructure-settings"],
    queryFn: () => api.infrastructure(),
    enabled: allowed,
  });
  const [value, setValue] = useState<InfrastructureSettings | null>(null);
  const [baseline, setBaseline] = useState<InfrastructureSettings | null>(null);
  const [s3AccessKey, setS3AccessKey] = useState("");
  const [s3SecretKey, setS3SecretKey] = useState("");
  const [smtpPassword, setSMTPPassword] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  useEffect(() => {
    if (!query.data) return;
    const normalized = normalizeInfrastructure(query.data);
    setValue(normalized);
    setBaseline(normalized);
  }, [query.data]);
  const dirty = Boolean(
    value &&
      baseline &&
      (infrastructureFingerprint(value) !==
        infrastructureFingerprint(baseline) ||
        s3AccessKey ||
        s3SecretKey ||
        smtpPassword),
  );
  async function save() {
    if (!value || !dirty) return;
    setPending(true);
    setError("");
    setMessage("");
    try {
      const updated = await api.updateInfrastructure({
        expected_version: value.version,
        s3: {
          endpoint: value.s3.endpoint,
          region: value.s3.region,
          bucket: value.s3.bucket,
          prefix: value.s3.prefix,
          force_path_style: value.s3.force_path_style,
          access_key: s3AccessKey || null,
          secret_key: s3SecretKey || null,
          clear_credentials: false,
        },
        smtp: {
          host: value.smtp.host,
          port: value.smtp.port,
          username: value.smtp.username,
          password: smtpPassword || null,
          from_address: value.smtp.from_address,
          from_name: value.smtp.from_name,
          security: value.smtp.security,
          clear_credentials: false,
        },
      });
      const normalized = normalizeInfrastructure(updated);
      setValue(normalized);
      setBaseline(normalized);
      setS3AccessKey("");
      setS3SecretKey("");
      setSMTPPassword("");
      setMessage(t("changesSaved"));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setPending(false);
    }
  }
  async function test(kind: "s3" | "smtp") {
    setError("");
    setMessage("");
    try {
      const result = await api.testInfrastructure(kind);
      setMessage(result.ok ? t("connectionSuccessful") : result.message);
    } catch (cause) {
      setError(messageOf(cause));
    }
  }
  return (
    <SettingsShell
      user={user}
      active="infrastructure"
      title={t("infrastructureSettings")}
      navigate={navigate}
    >
      {!allowed ? (
        <SettingsAccessDenied />
      ) : !value ? (
        <Skeleton />
      ) : (
        <div className="settings-page__body settings-page__body--columns">
          <div className="settings-actions settings-section--wide settings-actions--save">
            <Button
              variant="primary"
              disabled={!dirty || pending}
              onClick={() => void save()}
            >
              {pending ? t("autosaveSaving") : t("saveInfrastructure")}
            </Button>
          </div>
          <SettingsSection
            title={t("s3Storage")}
            description={t("s3StorageHint")}
            icon={<HardDrive />}
          >
            <div className="settings-form-grid">
              <Field
                label={t("endpoint")}
                name="s3-endpoint"
                placeholder="https://s3.example.com"
                value={value.s3.endpoint}
                onChange={(event) =>
                  setValue({
                    ...value,
                    s3: { ...value.s3, endpoint: event.target.value },
                  })
                }
              />
              <Field
                label={t("region")}
                name="s3-region"
                placeholder="ru-central1"
                value={value.s3.region}
                onChange={(event) =>
                  setValue({
                    ...value,
                    s3: { ...value.s3, region: event.target.value },
                  })
                }
              />
              <Field
                label={t("bucket")}
                name="s3-bucket"
                value={value.s3.bucket}
                onChange={(event) =>
                  setValue({
                    ...value,
                    s3: { ...value.s3, bucket: event.target.value },
                  })
                }
              />
              <Field
                label={t("prefix")}
                name="s3-prefix"
                placeholder="coma"
                value={value.s3.prefix}
                onChange={(event) =>
                  setValue({
                    ...value,
                    s3: { ...value.s3, prefix: event.target.value },
                  })
                }
              />
              <Field
                label={t("accessKey")}
                name="s3-access"
                placeholder={value.s3.access_key_hint || t("notConfigured")}
                value={s3AccessKey}
                onChange={(event) => setS3AccessKey(event.target.value)}
              />
              <Field
                label={t("secretKey")}
                name="s3-secret"
                type="password"
                placeholder={
                  value.s3.credentials_configured
                    ? "••••••••"
                    : t("notConfigured")
                }
                value={s3SecretKey}
                onChange={(event) => setS3SecretKey(event.target.value)}
              />
            </div>
            <SettingsToggle
              label={t("forcePathStyle")}
              hint={t("forcePathStyleHint")}
              checked={value.s3.force_path_style}
              onChange={(checked) =>
                setValue({
                  ...value,
                  s3: { ...value.s3, force_path_style: checked },
                })
              }
            />
            <Button disabled={dirty || pending} onClick={() => void test("s3")}>
              <RefreshCw />
              {t("testConnection")}
            </Button>
          </SettingsSection>
          <SettingsSection
            title={t("smtpDelivery")}
            description={t("smtpDeliveryHint")}
            icon={<Mail />}
          >
            <div className="settings-form-grid">
              <Field
                label={t("host")}
                name="smtp-host"
                value={value.smtp.host}
                onChange={(event) =>
                  setValue({
                    ...value,
                    smtp: { ...value.smtp, host: event.target.value },
                  })
                }
              />
              <Field
                label={t("port")}
                name="smtp-port"
                type="number"
                min={1}
                max={65535}
                value={String(value.smtp.port)}
                onChange={(event) =>
                  setValue({
                    ...value,
                    smtp: { ...value.smtp, port: Number(event.target.value) },
                  })
                }
              />
              <Field
                label={t("username")}
                name="smtp-user"
                value={value.smtp.username}
                onChange={(event) =>
                  setValue({
                    ...value,
                    smtp: { ...value.smtp, username: event.target.value },
                  })
                }
              />
              <Field
                label={t("password")}
                name="smtp-password"
                type="password"
                placeholder={
                  value.smtp.credentials_configured
                    ? "••••••••"
                    : t("notConfigured")
                }
                value={smtpPassword}
                onChange={(event) => setSMTPPassword(event.target.value)}
              />
              <Field
                label={t("fromAddress")}
                name="smtp-from"
                value={value.smtp.from_address}
                onChange={(event) =>
                  setValue({
                    ...value,
                    smtp: { ...value.smtp, from_address: event.target.value },
                  })
                }
              />
              <Field
                label={t("fromName")}
                name="smtp-name"
                value={value.smtp.from_name}
                onChange={(event) =>
                  setValue({
                    ...value,
                    smtp: { ...value.smtp, from_name: event.target.value },
                  })
                }
              />
              <SelectField
                label={t("security")}
                name="smtp-security"
                value={value.smtp.security}
                onChange={(event) =>
                  setValue({
                    ...value,
                    smtp: {
                      ...value.smtp,
                      security: event.target.value as
                        | "none"
                        | "starttls"
                        | "tls",
                    },
                  })
                }
              >
                <option value="starttls">STARTTLS</option>
                <option value="tls">TLS</option>
                <option value="none">{t("noEncryption")}</option>
              </SelectField>
            </div>
            <Button
              disabled={dirty || pending}
              onClick={() => void test("smtp")}
            >
              <RefreshCw />
              {t("testConnection")}
            </Button>
          </SettingsSection>
          {message && (
            <span className="settings-success settings-section--wide">
              {message}
            </span>
          )}
          {error && <FormError message={error} />}
        </div>
      )}
    </SettingsShell>
  );
}
