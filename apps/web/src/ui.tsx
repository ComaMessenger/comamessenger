import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";
import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { stableAvatarIndex } from "@comamessenger/tokens";

export function cx(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md" | "icon";
};

export function Button({
  className,
  variant = "secondary",
  size = "md",
  type = "button",
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cx(
        "ui-button",
        `ui-button--${variant}`,
        `ui-button--${size}`,
        className,
      )}
      {...props}
    />
  );
}

export function IconButton({
  label,
  className,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  children: ReactNode;
}) {
  return (
    <Button
      size="icon"
      variant="ghost"
      className={className}
      aria-label={label}
      title={label}
      {...props}
    >
      {children}
    </Button>
  );
}

export function Field({
  label,
  hint,
  required = true,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  name: string;
  hint?: string;
}) {
  return (
    <label className="ui-field">
      <span className="ui-field__label">{label}</span>
      <input {...props} required={required} />
      {hint && <small>{hint}</small>}
    </label>
  );
}

export function RadioOption({
  label,
  description,
  disabled,
  className,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & {
  label: ReactNode;
  description?: ReactNode;
}) {
  return (
    <label
      className={cx("ui-radio", disabled && "ui-radio--disabled", className)}
    >
      <input type="radio" disabled={disabled} {...props} />
      <span className="ui-radio__control" aria-hidden="true" />
      <span className="ui-radio__copy">
        <strong>{label}</strong>
        {description && <small>{description}</small>}
      </span>
    </label>
  );
}

export function TextareaField({
  label,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement> & {
  label: string;
  name: string;
}) {
  return (
    <label className="ui-field">
      <span className="ui-field__label">{label}</span>
      <textarea {...props} />
    </label>
  );
}

export function SelectField({
  label,
  name,
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & {
  label: string;
  name: string;
  children: ReactNode;
}) {
  return (
    <label className="ui-field">
      <span className="ui-field__label">{label}</span>
      <select name={name} {...props}>
        {children}
      </select>
    </label>
  );
}

export function Dialog({
  title,
  description,
  onClose,
  children,
  className,
}: {
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  className?: string;
}) {
  const { t } = useTranslation();
  const dialog = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const first = dialog.current?.querySelector<HTMLElement>(
      "button, input, textarea, select, [href], [tabindex]:not([tabindex='-1'])",
    );
    first?.focus();
    function keyboard(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") onClose();
      if (event.key !== "Tab" || !dialog.current) return;
      const focusable = [
        ...dialog.current.querySelectorAll<HTMLElement>(
          "button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [href], [tabindex]:not([tabindex='-1'])",
        ),
      ];
      if (!focusable.length) return;
      const firstItem = focusable[0]!;
      const lastItem = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === firstItem) {
        event.preventDefault();
        lastItem.focus();
      } else if (!event.shiftKey && document.activeElement === lastItem) {
        event.preventDefault();
        firstItem.focus();
      }
    }
    document.addEventListener("keydown", keyboard);
    return () => {
      document.removeEventListener("keydown", keyboard);
      previous?.focus();
    };
  }, [onClose]);
  return (
    <div
      className="ui-dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={dialog}
        className={cx("ui-dialog", className)}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header className="ui-dialog__head">
          <div>
            <h2>{title}</h2>
            {description && <p>{description}</p>}
          </div>
          <IconButton label={t("close")} onClick={onClose}>
            <X size={18} />
          </IconButton>
        </header>
        {children}
      </section>
    </div>
  );
}

export function Avatar({
  name,
  seed,
  size = "md",
  online = false,
}: {
  name: string;
  seed?: string;
  size?: "sm" | "md" | "lg" | "xl";
  online?: boolean;
}) {
  const initials = name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
  return (
    <span
      className={cx("ui-avatar", `ui-avatar--${size}`)}
      data-avatar-color={stableAvatarIndex(seed || name)}
    >
      {initials || "U"}
      {online && <i aria-hidden="true" />}
    </span>
  );
}

export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "primary" | "success";
}) {
  return (
    <span className={cx("ui-badge", `ui-badge--${tone}`)}>{children}</span>
  );
}

export function FormError({ message }: { message: string }) {
  return message ? (
    <div className="ui-form-error form-span" role="alert">
      {message}
    </div>
  ) : null;
}

export function Menu({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="ui-menu" role="menu" aria-label={label}>
      {children}
    </div>
  );
}

export function Popover({ children }: { children: ReactNode }) {
  return <div className="ui-popover">{children}</div>;
}

export function Tooltip({
  text,
  children,
}: {
  text: string;
  children: ReactNode;
}) {
  return (
    <span className="ui-tooltip" data-tooltip={text}>
      {children}
    </span>
  );
}

export function Toast({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "danger" | "success";
}) {
  return (
    <div className={cx("ui-toast", `ui-toast--${tone}`)} role="status">
      {children}
    </div>
  );
}

export function Skeleton() {
  return <span className="ui-skeleton" aria-hidden="true" />;
}
