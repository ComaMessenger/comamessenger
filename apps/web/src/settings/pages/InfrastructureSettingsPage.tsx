import { useCallback, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type {
  InfrastructureSettings,
  MessengerAPI,
  User,
} from "@comamessenger/core";
import { HardDrive, Mail, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { messageOf } from "../../errors";
import { Button, Field, SelectField, Skeleton } from "../../ui";
import { AutosaveStatus } from "../components/AutosaveStatus";
import {
  SettingsAccessDenied,
  SettingsSection,
  SettingsToggle,
} from "../components/SettingsPrimitives";
import {
  SettingsShell,
  type SettingsNavigate,
} from "../components/SettingsShell";
import { useAutosave } from "../hooks/useAutosave";
import { canAccessSettingsPage } from "../registry";

type InfrastructureDraft = {
  settings: InfrastructureSettings;
  s3AccessKey: string;
  s3SecretKey: string;
  smtpPassword: string;
};

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
  const [s3AccessKey, setS3AccessKey] = useState("");
  const [s3SecretKey, setS3SecretKey] = useState("");
  const [smtpPassword, setSMTPPassword] = useState("");
  const [message, setMessage] = useState("");
  useEffect(() => {
    if (query.data)
      setValue({
        ...query.data,
        smtp: {
          ...query.data.smtp,
          security: query.data.smtp.security || "starttls",
          port: query.data.smtp.port || 587,
        },
      });
  }, [query.data]);
  const draft: InfrastructureDraft | null = value
    ? {
        settings: value,
        s3AccessKey,
        s3SecretKey,
        smtpPassword,
      }
    : null;
  const infrastructureFingerprint = useCallback(
    (item: InfrastructureDraft) =>
      JSON.stringify({
        s3: {
          endpoint: item.settings.s3.endpoint,
          region: item.settings.s3.region,
          bucket: item.settings.s3.bucket,
          prefix: item.settings.s3.prefix,
          force_path_style: item.settings.s3.force_path_style,
          access_key: item.s3AccessKey,
          secret_key: item.s3SecretKey,
        },
        smtp: {
          host: item.settings.smtp.host,
          port: item.settings.smtp.port,
          username: item.settings.smtp.username,
          password: item.smtpPassword,
          from_address: item.settings.smtp.from_address,
          from_name: item.settings.smtp.from_name,
          security: item.settings.smtp.security,
        },
      }),
    [],
  );
  const autosave = useAutosave({
    value: draft,
    fingerprint: infrastructureFingerprint,
    save: async (snapshot) => {
      const updated = await api.updateInfrastructure({
        expected_version: snapshot.settings.version,
        s3: {
          endpoint: snapshot.settings.s3.endpoint,
          region: snapshot.settings.s3.region,
          bucket: snapshot.settings.s3.bucket,
          prefix: snapshot.settings.s3.prefix,
          force_path_style: snapshot.settings.s3.force_path_style,
          access_key: snapshot.s3AccessKey || null,
          secret_key: snapshot.s3SecretKey || null,
          clear_credentials: false,
        },
        smtp: {
          host: snapshot.settings.smtp.host,
          port: snapshot.settings.smtp.port,
          username: snapshot.settings.smtp.username,
          password: snapshot.smtpPassword || null,
          from_address: snapshot.settings.smtp.from_address,
          from_name: snapshot.settings.smtp.from_name,
          security: snapshot.settings.smtp.security,
          clear_credentials: false,
        },
      });
      return {
        settings: updated,
        s3AccessKey: "",
        s3SecretKey: "",
        smtpPassword: "",
      };
    },
    onSaved: (result, snapshot) => {
      const unchanged =
        draft &&
        infrastructureFingerprint(draft) ===
          infrastructureFingerprint(snapshot);
      if (unchanged) {
        setValue(result.settings);
      } else {
        setValue((current) =>
          current
            ? {
                ...current,
                version: result.settings.version,
                s3: {
                  ...current.s3,
                  credentials_configured:
                    result.settings.s3.credentials_configured,
                  access_key_hint: result.settings.s3.access_key_hint,
                },
                smtp: {
                  ...current.smtp,
                  credentials_configured:
                    result.settings.smtp.credentials_configured,
                },
              }
            : result.settings,
        );
      }
      if (s3AccessKey === snapshot.s3AccessKey) setS3AccessKey("");
      if (s3SecretKey === snapshot.s3SecretKey) setS3SecretKey("");
      if (smtpPassword === snapshot.smtpPassword) setSMTPPassword("");
    },
  });
  async function test(kind: "s3" | "smtp") {
    try {
      const result = await api.testInfrastructure(kind);
      setMessage(result.ok ? t("connectionSuccessful") : result.message);
    } catch (cause) {
      setMessage(messageOf(cause));
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
          <AutosaveStatus
            phase={autosave.phase}
            error={autosave.error}
            onRetry={autosave.retry}
          />
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
            <Button onClick={() => void test("s3")}>
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
            <Button onClick={() => void test("smtp")}>
              <RefreshCw />
              {t("testConnection")}
            </Button>
          </SettingsSection>
          {message && (
            <span className="settings-success settings-section--wide">
              {message}
            </span>
          )}
        </div>
      )}
    </SettingsShell>
  );
}
