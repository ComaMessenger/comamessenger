import type { ReactNode } from "react";
import { ChevronLeft } from "lucide-react";
import { useTranslation } from "react-i18next";
import { IconButton, cx } from "../ui";

/**
 * Utility screens (threads, important, members) are master-detail on desktop:
 * a 360px list where the chat list normally sits, and the selected item on the right.
 * On phones only the list renders; details live on their own routes.
 */
export function DirectorySplit({
  list,
  detail,
  detailOpen,
  className,
}: {
  list: ReactNode;
  detail: ReactNode;
  /** An explicit selection (URL param) — on narrow desktops it replaces the list. */
  detailOpen: boolean;
  className?: string;
}) {
  return (
    <div className={cx("directory", detailOpen && "directory--detail-open", className)}>
      {list}
      <section className="directory__detail">{detail}</section>
    </div>
  );
}

export function DirectoryList({
  title,
  lead,
  action,
  toolbar,
  chips,
  children,
  className,
}: {
  title: string;
  lead?: ReactNode;
  /** Trailing control in the title row (refresh, invite). */
  action?: ReactNode;
  toolbar?: ReactNode;
  chips?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cx("directory-list", className)}>
      <header className="directory-list__head">
        <div className="directory-list__title">
          <h1>{title}</h1>
          {action}
        </div>
        {lead && <p className="directory-list__lead">{lead}</p>}
        {toolbar && <div className="directory-list__toolbar">{toolbar}</div>}
        {chips && <div className="directory-list__chips">{chips}</div>}
      </header>
      <div className="directory-list__scroll">{children}</div>
    </section>
  );
}

/** Detail pane header: avatar, title + meta, trailing actions. */
export function DirectoryDetailHead({
  leading,
  title,
  meta,
  actions,
  onBack,
}: {
  leading?: ReactNode;
  title: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  onBack?(): void;
}) {
  const { t } = useTranslation();
  return (
    <header className="directory-detail__head">
      {onBack && (
        <IconButton className="mobile-back" size="icon-lg" label={t("back")} onClick={onBack}>
          <ChevronLeft />
        </IconButton>
      )}
      {leading}
      <div className="directory-detail__title">
        <strong className="truncate">{title}</strong>
        {meta && <span className="truncate">{meta}</span>}
      </div>
      {actions && <div className="directory-detail__actions">{actions}</div>}
    </header>
  );
}

export function DirectoryRow({
  leading,
  top,
  title,
  text,
  meta,
  trailing,
  selected,
  onClick,
  label,
  className,
  disabled,
}: {
  leading: ReactNode;
  /** First line with its own trailing part (chat name + time). */
  top?: ReactNode;
  /** Single-line title (members). */
  title?: ReactNode;
  /** Two-line clamped body (threads, important). */
  text?: ReactNode;
  meta?: ReactNode;
  trailing?: ReactNode;
  selected?: boolean;
  onClick?(): void;
  label?: string;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={cx("directory-row", selected && "directory-row--selected", className)}
      onClick={onClick}
      aria-label={label}
      aria-current={selected ? "true" : undefined}
      disabled={disabled}
    >
      <span className="directory-row__leading">{leading}</span>
      <span className="directory-row__body">
        {top && <span className="directory-row__top">{top}</span>}
        {title && <span className="directory-row__title">{title}</span>}
        {text && <span className="directory-row__text clamp-2">{text}</span>}
        {meta && <span className="directory-row__meta">{meta}</span>}
      </span>
      {trailing && <span className="directory-row__trailing">{trailing}</span>}
    </button>
  );
}
