import {
  useCallback,
  useEffect,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useQuery } from "@tanstack/react-query";
import type {
  MessengerAPI,
  OrganizationSettings,
  User,
} from "@comamessenger/core";
import { Image, Trash2, Upload } from "lucide-react";
import { useTranslation } from "react-i18next";
import { messageOf } from "../../errors";
import { Button, Field, Skeleton } from "../../ui";
import { AutosaveStatus } from "../components/AutosaveStatus";
import {
  SettingsAccessDenied,
  SettingsSection,
} from "../components/SettingsPrimitives";
import {
  SettingsShell,
  type SettingsNavigate,
} from "../components/SettingsShell";
import { useAutosave } from "../hooks/useAutosave";
import { canAccessSettingsPage } from "../registry";

export function CustomizationSettingsPage({
  api,
  user,
  navigate,
  renderLogo,
}: {
  api: MessengerAPI;
  user: User;
  navigate: SettingsNavigate;
  renderLogo(size: "small" | "medium" | "large"): ReactNode;
}) {
  const { t } = useTranslation();
  const allowed = canAccessSettingsPage(user, "customization");
  const query = useQuery({
    queryKey: ["organization-settings"],
    queryFn: () => api.organization(),
    enabled: allowed,
  });
  const [settings, setSettings] = useState<OrganizationSettings | null>(null);
  const [message, setMessage] = useState("");
  const [assetVersion, setAssetVersion] = useState(Date.now());
  useEffect(() => {
    if (query.data) setSettings(query.data);
  }, [query.data]);
  const accentFingerprint = useCallback(
    (value: OrganizationSettings) => value.accent_color,
    [],
  );
  const autosave = useAutosave({
    value: settings,
    fingerprint: accentFingerprint,
    save: (snapshot) =>
      api.updateOrganization({
        name: snapshot.name,
        slug: snapshot.slug,
        expected_version: snapshot.version,
        invitation_default_role: snapshot.invitation_default_role,
        invitation_ttl_hours: snapshot.invitation_ttl_hours,
        default_timezone: snapshot.default_timezone,
        allow_member_invitations: snapshot.allow_member_invitations,
        allow_public_chat_creation: snapshot.allow_public_chat_creation,
        allow_channel_creation: snapshot.allow_channel_creation,
        accent_color: snapshot.accent_color,
      }),
    onSaved: (updated, snapshot) => {
      setSettings((current) =>
        current && accentFingerprint(current) !== accentFingerprint(snapshot)
          ? { ...current, version: updated.version }
          : updated,
      );
      window.dispatchEvent(new Event("coma-branding-changed"));
    },
  });
  async function upload(kind: "logo" | "favicon", files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    try {
      await api.putBrandingAsset(kind, file);
      setAssetVersion(Date.now());
      await query.refetch();
      setMessage(t("assetSaved"));
      window.dispatchEvent(new Event("coma-branding-changed"));
    } catch (cause) {
      setMessage(messageOf(cause));
    }
  }
  async function removeAsset(kind: "logo" | "favicon") {
    try {
      await api.deleteBrandingAsset(kind);
      setAssetVersion(Date.now());
      await query.refetch();
      setMessage(t("assetRemoved"));
      window.dispatchEvent(new Event("coma-branding-changed"));
    } catch (cause) {
      setMessage(messageOf(cause));
    }
  }
  return (
    <SettingsShell
      user={user}
      active="customization"
      title={t("customizationSettings")}
      navigate={navigate}
    >
      {!allowed ? (
        <SettingsAccessDenied />
      ) : !settings ? (
        <Skeleton />
      ) : (
        <div className="settings-page__body settings-page__body--appearance">
          <AutosaveStatus
            phase={autosave.phase}
            error={autosave.error}
            onRetry={autosave.retry}
          />
          <SettingsSection
            title={t("brandIdentity")}
            description={t("brandIdentityHint")}
            wide
          >
            <div className="branding-assets">
              <BrandingAssetCard
                title={t("workspaceLogo")}
                hint={t("workspaceLogoHint")}
                imageURL={
                  settings.has_logo
                    ? `${api.apiURL}/api/v1/branding/logo?v=${assetVersion}`
                    : ""
                }
                accept="image/png,image/jpeg,image/webp"
                onUpload={(files) => void upload("logo", files)}
                onRemove={
                  settings.has_logo ? () => void removeAsset("logo") : undefined
                }
              />
              <BrandingAssetCard
                title={t("workspaceFavicon")}
                hint={t("workspaceFaviconHint")}
                imageURL={
                  settings.has_favicon
                    ? `${api.apiURL}/api/v1/branding/favicon?v=${assetVersion}`
                    : ""
                }
                accept="image/png,image/x-icon,image/vnd.microsoft.icon"
                onUpload={(files) => void upload("favicon", files)}
                onRemove={
                  settings.has_favicon
                    ? () => void removeAsset("favicon")
                    : undefined
                }
              />
            </div>
          </SettingsSection>
          <SettingsSection
            title={t("accentColor")}
            description={t("accentColorHint")}
            wide
          >
            <div className="accent-editor">
              <input
                type="color"
                aria-label={t("accentColor")}
                value={settings.accent_color}
                onChange={(event) =>
                  setSettings({
                    ...settings,
                    accent_color: event.target.value.toUpperCase(),
                  })
                }
              />
              <Field
                label={t("hexColor")}
                name="accent-hex"
                value={settings.accent_color}
                onChange={(event) =>
                  setSettings({
                    ...settings,
                    accent_color: event.target.value.toUpperCase(),
                  })
                }
              />
              <div
                className="accent-preview"
                style={
                  { "--preview-accent": settings.accent_color } as CSSProperties
                }
              >
                {renderLogo("small")}
                <button>{t("previewAction")}</button>
              </div>
            </div>
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

function BrandingAssetCard({
  title,
  hint,
  imageURL,
  accept,
  onUpload,
  onRemove,
}: {
  title: string;
  hint: string;
  imageURL: string;
  accept: string;
  onUpload(files: FileList | null): void;
  onRemove?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <article className="branding-asset-card">
      <div className="branding-asset-preview">
        {imageURL ? <img src={imageURL} alt="" /> : <Image />}
      </div>
      <span>
        <strong>{title}</strong>
        <small>{hint}</small>
      </span>
      <label className="ui-button ui-button--sm">
        <Upload />
        {t("upload")}
        <input
          type="file"
          accept={accept}
          onChange={(event) => onUpload(event.target.files)}
        />
      </label>
      {onRemove && (
        <Button size="sm" onClick={onRemove}>
          <Trash2 />
          {t("remove")}
        </Button>
      )}
    </article>
  );
}
