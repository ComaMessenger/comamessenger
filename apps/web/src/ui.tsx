import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from "react";
import { X } from "lucide-react";

export function cx(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md" | "icon";
};

export function Button({ className, variant = "secondary", size = "md", type = "button", ...props }: ButtonProps) {
  return <button type={type} className={cx("ui-button", `ui-button--${variant}`, `ui-button--${size}`, className)} {...props} />;
}

export function IconButton({ label, className, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; children: ReactNode }) {
  return <Button size="icon" variant="ghost" className={className} aria-label={label} title={label} {...props}>{children}</Button>;
}

export function Field({ label, hint, ...props }: InputHTMLAttributes<HTMLInputElement> & { label: string; name: string; hint?: string }) {
  return (
    <label className="ui-field">
      <span className="ui-field__label">{label}</span>
      <input {...props} required />
      {hint && <small>{hint}</small>}
    </label>
  );
}

export function TextareaField({ label, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement> & { label: string; name: string }) {
  return <label className="ui-field"><span className="ui-field__label">{label}</span><textarea {...props} /></label>;
}

export function SelectField({ label, name, children }: { label: string; name: string; children: ReactNode }) {
  return <label className="ui-field"><span className="ui-field__label">{label}</span><select name={name}>{children}</select></label>;
}

export function Dialog({ title, description, onClose, children }: { title: string; description?: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="ui-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="ui-dialog" role="dialog" aria-modal="true" aria-label={title}>
        <header className="ui-dialog__head">
          <div><h2>{title}</h2>{description && <p>{description}</p>}</div>
          <IconButton label="Закрыть" onClick={onClose}><X size={18} /></IconButton>
        </header>
        {children}
      </section>
    </div>
  );
}

export function Avatar({ name, size = "md", online = false }: { name: string; size?: "sm" | "md" | "lg"; online?: boolean }) {
  const initials = name.split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
  return <span className={cx("ui-avatar", `ui-avatar--${size}`)}>{initials || "U"}{online && <i aria-label="В сети" />}</span>;
}

export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "primary" | "success" }) {
  return <span className={cx("ui-badge", `ui-badge--${tone}`)}>{children}</span>;
}

export function FormError({ message }: { message: string }) {
  return message ? <div className="ui-form-error form-span" role="alert">{message}</div> : null;
}
