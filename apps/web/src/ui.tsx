import type {
  ButtonHTMLAttributes,
  CSSProperties,
  InputHTMLAttributes,
  ReactElement,
  ReactNode,
  RefObject,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";
import {
  Children,
  createContext,
  isValidElement,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { stableAvatarIndex } from "@comamessenger/tokens";
import type { MessengerAPI } from "@comamessenger/core";
import { AvatarObjectURLs } from "./objectURLs";

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

export function FloatingPopover({
  anchorRef,
  children,
  className,
  matchAnchorWidth = false,
  placement = "bottom-start",
  width,
  gap = 8,
  onDismiss,
}: {
  anchorRef: RefObject<HTMLElement | null>;
  children: ReactNode;
  className?: string;
  matchAnchorWidth?: boolean;
  placement?: "bottom-start" | "side-start";
  width?: number;
  gap?: number;
  onDismiss(): void;
}) {
  const layer = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>({
    left: -10_000,
    top: -10_000,
    visibility: "hidden",
  });

  useLayoutEffect(() => {
    function position() {
      const anchor = anchorRef.current;
      const popover = layer.current;
      if (!anchor || !popover) return;
      const viewportGap = 16;
      const anchorBox = anchor.getBoundingClientRect();
      const targetWidth = matchAnchorWidth
        ? anchorBox.width
        : (width ?? popover.offsetWidth);
      const measuredHeight = popover.offsetHeight;
      if (placement === "side-start") {
        const availableLeft = anchorBox.left - gap - viewportGap;
        const availableRight =
          window.innerWidth - anchorBox.right - gap - viewportGap;
        if (availableLeft >= targetWidth || availableRight >= targetWidth) {
          const openLeft = availableLeft >= targetWidth;
          const left = openLeft
            ? anchorBox.left - gap - targetWidth
            : anchorBox.right + gap;
          const maxHeight = window.innerHeight - viewportGap * 2;
          const top = Math.min(
            Math.max(anchorBox.top, viewportGap),
            Math.max(
              viewportGap,
              window.innerHeight - measuredHeight - viewportGap,
            ),
          );
          setStyle({
            left,
            top,
            width: targetWidth,
            maxHeight,
            visibility: "visible",
          });
          return;
        }
      }
      const below = window.innerHeight - anchorBox.bottom - gap - viewportGap;
      const above = anchorBox.top - gap - viewportGap;
      const openAbove = measuredHeight > below && above > below;
      const availableHeight = Math.max(openAbove ? above : below, 120);
      const left = Math.min(
        Math.max(anchorBox.left, viewportGap),
        Math.max(viewportGap, window.innerWidth - targetWidth - viewportGap),
      );
      const top = openAbove
        ? Math.max(viewportGap, anchorBox.top - gap - measuredHeight)
        : anchorBox.bottom + gap;
      setStyle({
        left,
        top,
        width: targetWidth,
        maxHeight: availableHeight,
        visibility: "visible",
      });
    }

    position();
    const frame = window.requestAnimationFrame(position);
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
    };
  }, [anchorRef, gap, matchAnchorWidth, placement, width]);

  useEffect(() => {
    function dismiss(event: PointerEvent) {
      const target = event.target as Node;
      if (
        anchorRef.current?.contains(target) ||
        layer.current?.contains(target)
      )
        return;
      onDismiss();
    }
    function keyboard(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      onDismiss();
    }
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", keyboard, true);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", keyboard, true);
    };
  }, [anchorRef, onDismiss]);

  return createPortal(
    <div
      ref={layer}
      className={cx("ui-popover-layer", className)}
      style={style}
    >
      {children}
    </div>,
    document.body,
  );
}

export function SelectField({
  label,
  name,
  children,
  value,
  defaultValue,
  disabled,
  onChange,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & {
  label: string;
  name: string;
  children: ReactNode;
}) {
  const labelID = useId();
  const selectedLabelID = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const nativeSelect = useRef<HTMLSelectElement>(null);
  const [open, setOpen] = useState(false);
  const options = Children.toArray(children)
    .filter(
      (
        child,
      ): child is ReactElement<{
        value?: string | number;
        disabled?: boolean;
        children?: ReactNode;
      }> => isValidElement(child) && child.type === "option",
    )
    .map((option) => ({
      value: String(option.props.value ?? ""),
      label: option.props.children,
      disabled: option.props.disabled,
    }));
  const fallbackValue = String(defaultValue ?? options[0]?.value ?? "");
  const [uncontrolledValue, setUncontrolledValue] = useState(fallbackValue);
  const selectedValue = String(value ?? uncontrolledValue);
  const selected =
    options.find((option) => option.value === selectedValue) ?? options[0];

  function choose(nextValue: string) {
    setUncontrolledValue(nextValue);
    setOpen(false);
    const select = nativeSelect.current;
    if (!select) return;
    const setter = Object.getOwnPropertyDescriptor(
      HTMLSelectElement.prototype,
      "value",
    )?.set;
    setter?.call(select, nextValue);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }

  return (
    <div className="ui-field ui-select-field">
      <span className="ui-field__label" id={labelID}>
        {label}
      </span>
      <div className="ui-select">
        <select
          ref={nativeSelect}
          className="ui-select__native"
          name={name}
          aria-hidden="true"
          value={selectedValue}
          disabled={disabled}
          onChange={(event) => {
            setUncontrolledValue(event.target.value);
            onChange?.(event);
          }}
          tabIndex={-1}
          {...props}
        >
          {children}
        </select>
        <button
          ref={trigger}
          type="button"
          className="ui-select__trigger"
          aria-labelledby={`${labelID} ${selectedLabelID}`}
          aria-haspopup="listbox"
          aria-expanded={open}
          disabled={disabled}
          onClick={() => setOpen((current) => !current)}
        >
          <span id={selectedLabelID}>{selected?.label}</span>
          <ChevronDown aria-hidden="true" />
        </button>
        {open && (
          <FloatingPopover
            anchorRef={trigger}
            className="ui-select__menu"
            matchAnchorWidth
            onDismiss={() => setOpen(false)}
          >
            <div role="listbox" aria-label={label}>
              {options.map((option) => (
                <button
                  type="button"
                  role="option"
                  aria-selected={option.value === selectedValue}
                  disabled={option.disabled}
                  key={option.value}
                  onClick={() => choose(option.value)}
                >
                  <span>{option.label}</span>
                  {option.value === selectedValue && (
                    <Check aria-hidden="true" />
                  )}
                </button>
              ))}
            </div>
          </FloatingPopover>
        )}
      </div>
    </div>
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
  actorID,
  avatarVersion = 0,
}: {
  name: string;
  seed?: string;
  size?: "sm" | "md" | "lg" | "xl";
  online?: boolean;
  actorID?: string;
  avatarVersion?: number;
}) {
  const objectURLs = useContext(avatarObjectURLContext);
  const [source, setSource] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    setSource(null);
    if (!objectURLs || !actorID || avatarVersion < 1) return;
    void objectURLs
      .get(actorID, avatarVersion)
      .then((url) => {
        if (active) setSource(url);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [actorID, avatarVersion, objectURLs]);
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
      <span className="ui-avatar__face">
        {source ? <img src={source} alt="" /> : initials || "U"}
      </span>
      {online && <i aria-hidden="true" />}
    </span>
  );
}

const avatarObjectURLContext = createContext<AvatarObjectURLs | null>(null);

export function AvatarProvider({
  api,
  children,
}: {
  api: MessengerAPI;
  children: ReactNode;
}) {
  const objectURLs = useMemo(() => new AvatarObjectURLs(api), [api]);
  useEffect(() => () => objectURLs.dispose(), [objectURLs]);
  return (
    <avatarObjectURLContext.Provider value={objectURLs}>
      {children}
    </avatarObjectURLContext.Provider>
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
