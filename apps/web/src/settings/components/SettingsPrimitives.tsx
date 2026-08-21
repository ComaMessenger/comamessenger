import type { ReactNode } from "react";
import { ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cx } from "../../ui";

export function SettingsSection({
  title,
  description,
  icon,
  wide = false,
  children,
}: {
  title: string;
  description: string;
  icon?: ReactNode;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <section
      className={cx("settings-section", wide && "settings-section--wide")}
    >
      <header>
        {icon}
        <span>
          <h2>{title}</h2>
          <p>{description}</p>
        </span>
      </header>
      <div className="settings-section__content">{children}</div>
    </section>
  );
}

export function SettingsToggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange(value: boolean): void;
}) {
  return (
    <SettingsRow label={label} hint={hint} className="settings-toggle">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
    </SettingsRow>
  );
}

export function SettingsRow({
  label,
  hint,
  className,
  children,
}: {
  label: string;
  hint?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <label className={cx("settings-row", className)}>
      <span>
        <strong>{label}</strong>
        {hint && <small>{hint}</small>}
      </span>
      {children}
    </label>
  );
}

export function SettingsAccessDenied() {
  const { t } = useTranslation();
  return (
    <div className="settings-access-denied">
      <ShieldCheck />
      <h2>{t("adminOnly")}</h2>
      <p>{t("adminOnlyHint")}</p>
    </div>
  );
}
