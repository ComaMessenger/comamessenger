import type { ReactNode } from "react";
import { ChevronLeft } from "lucide-react";
import { useTranslation } from "react-i18next";
import { IconButton, cx } from "../ui";

/** Utility screen layout: centered 640px column with title, lead and a list. */
export function DirectoryPage({
  title,
  lead,
  children,
  toolbar,
  onBack,
  className,
}: {
  title: string;
  lead?: ReactNode;
  children: ReactNode;
  toolbar?: ReactNode;
  onBack?(): void;
  className?: string;
}) {
  const { t } = useTranslation();
  return (
    <section className={cx("directory-page", className)}>
      <div className="directory-page__column">
        <header className="directory-page__header">
          {onBack && (
            <IconButton
              className="mobile-back"
              size="icon-lg"
              label={t("back")}
              onClick={onBack}
            >
              <ChevronLeft />
            </IconButton>
          )}
          <div className="directory-page__heading">
            <h1>{title}</h1>
            {lead && <p>{lead}</p>}
          </div>
        </header>
        {toolbar && <div className="directory-page__toolbar">{toolbar}</div>}
        <div className="directory-page__list">{children}</div>
      </div>
    </section>
  );
}

export function DirectoryRow({
  leading,
  title,
  text,
  meta,
  trailing,
  onClick,
  label,
  className,
  disabled,
}: {
  leading: ReactNode;
  /** Single-line title (members) — alternative to `text`. */
  title?: ReactNode;
  /** Two-line clamped primary text (threads, important). */
  text?: ReactNode;
  meta?: ReactNode;
  trailing?: ReactNode;
  onClick?(): void;
  label?: string;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={cx("directory-row", className)}
      onClick={onClick}
      aria-label={label}
      disabled={disabled}
    >
      <span className="directory-row__leading">{leading}</span>
      <span className="directory-row__body">
        {title && <span className="directory-row__title">{title}</span>}
        {text && <span className="directory-row__text clamp-2">{text}</span>}
        {meta && <span className="directory-row__meta">{meta}</span>}
      </span>
      {trailing && <span className="directory-row__trailing">{trailing}</span>}
    </button>
  );
}
