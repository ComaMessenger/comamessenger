import type {
  ButtonHTMLAttributes,
  CSSProperties,
  InputHTMLAttributes,
  ReactElement,
  ReactNode,
  Ref,
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
import {
  AlertCircle,
  Bot,
  Check,
  CheckCircle2,
  ChevronDown,
  Eye,
  EyeOff,
  Inbox,
  Search,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { stableAvatarIndex } from "@comamessenger/tokens";
import type { MessengerAPI } from "@comamessenger/core";
import { AvatarObjectURLs } from "./objectURLs";

export function cx(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

/* Buttons ------------------------------------------------------------------ */

export type ButtonVariant =
  | "primary"
  | "secondary"
  | "ghost"
  | "danger"
  | "danger-ghost"
  | "ink"
  | "ink-soft";
export type ButtonSize =
  | "xs"
  | "sm"
  | "md"
  | "lg"
  | "icon"
  | "icon-sm"
  | "icon-lg";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  ref?: Ref<HTMLButtonElement>;
  variant?: ButtonVariant;
  size?: ButtonSize;
  pending?: boolean;
  block?: boolean;
  neutral?: boolean;
};

export function Button({
  className,
  variant = "secondary",
  size = "md",
  type = "button",
  pending = false,
  block = false,
  neutral = false,
  disabled,
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cx(
        "ui-button",
        `ui-button--${variant}`,
        `ui-button--${size}`,
        pending && "ui-button--pending",
        block && "ui-button--block",
        neutral && "ui-button--neutral",
        className,
      )}
      disabled={disabled || pending}
      aria-busy={pending || undefined}
      {...props}
    >
      {pending && <Spinner />}
      {children}
    </button>
  );
}

export function IconButton({
  label,
  className,
  children,
  size = "icon",
  variant = "ghost",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  ref?: Ref<HTMLButtonElement>;
  label: string;
  children: ReactNode;
  size?: "icon" | "icon-sm" | "icon-lg";
  variant?: ButtonVariant;
}) {
  return (
    <Button
      size={size}
      variant={variant}
      className={className}
      aria-label={label}
      title={label}
      {...props}
    >
      {children}
    </Button>
  );
}

export function Spinner({ size = "md" }: { size?: "md" | "lg" }) {
  return (
    <span
      className={cx("ui-spinner", size === "lg" && "ui-spinner--lg")}
      aria-hidden="true"
    />
  );
}

/* Fields ------------------------------------------------------------------- */

export type FieldTone = "default" | "error" | "success";

export function Field({
  label,
  hint,
  error,
  success,
  optional,
  prefix,
  suffix,
  mono = false,
  compact = false,
  required = true,
  className,
  disabled,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  name: string;
  hint?: ReactNode;
  error?: ReactNode;
  success?: ReactNode;
  optional?: ReactNode;
  prefix?: ReactNode;
  suffix?: ReactNode;
  mono?: boolean;
  compact?: boolean;
}) {
  const labelID = useId();
  return (
    <label
      className={cx(
        "ui-field",
        Boolean(error) && "ui-field--error",
        Boolean(success) && "ui-field--success",
        disabled && "ui-field--disabled",
        compact && "ui-field--compact",
        className,
      )}
    >
      <span className="ui-field__label">
        <span id={labelID}>{label}</span>
        {optional && <span className="ui-field__optional">{optional}</span>}
      </span>
      <span className={cx("ui-field__control", mono && "ui-field__control--mono")}>
        {prefix && <span className="ui-field__affix">{prefix}</span>}
        <input
          {...props}
          aria-labelledby={labelID}
          required={required}
          disabled={disabled}
        />
        {suffix}
      </span>
      {error ? (
        <span className="ui-field__hint ui-field__hint--error" role="alert">
          <AlertCircle aria-hidden="true" />
          <span>{error}</span>
        </span>
      ) : success ? (
        <span className="ui-field__hint ui-field__hint--success">
          <Check aria-hidden="true" />
          <span>{success}</span>
        </span>
      ) : hint ? (
        <span className="ui-field__hint">{hint}</span>
      ) : null}
    </label>
  );
}

export function PasswordField({
  showLabel,
  hideLabel,
  ...props
}: Omit<Parameters<typeof Field>[0], "type" | "suffix"> & {
  showLabel: string;
  hideLabel: string;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <Field
      {...props}
      type={visible ? "text" : "password"}
      suffix={
        <IconButton
          size="icon-sm"
          label={visible ? hideLabel : showLabel}
          aria-pressed={visible}
          tabIndex={-1}
          onClick={() => setVisible((value) => !value)}
        >
          {visible ? <EyeOff /> : <Eye />}
        </IconButton>
      }
    />
  );
}

export function PasswordMeter({
  value,
  minimum,
  label,
  strongLabel,
}: {
  value: string;
  minimum: number;
  label: string;
  strongLabel: string;
}) {
  const ratio = Math.min(1, value.length / minimum);
  const strong = value.length >= minimum;
  return (
    <span className={cx("ui-meter", strong && "ui-meter--strong")}>
      <span className="ui-meter__track">
        <span style={{ width: `${Math.round(ratio * 100)}%` }} />
      </span>
      <span className="ui-meter__label">{strong ? strongLabel : label}</span>
    </span>
  );
}

export function TextareaField({
  label,
  hint,
  optional,
  className,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement> & {
  label: string;
  name: string;
  hint?: ReactNode;
  optional?: ReactNode;
}) {
  return (
    <label className={cx("ui-field", className)}>
      <span className="ui-field__label">
        <span>{label}</span>
        {optional && <span className="ui-field__optional">{optional}</span>}
      </span>
      <span className="ui-field__control ui-field__control--textarea">
        <textarea {...props} />
      </span>
      {hint && <span className="ui-field__hint">{hint}</span>}
    </label>
  );
}

export function SearchField({
  value,
  onChange,
  placeholder,
  label,
  size = "md",
  autoFocus,
  inputRef,
  clearLabel,
  className,
  onKeyDown,
}: {
  value: string;
  onChange(value: string): void;
  placeholder: string;
  label?: string;
  size?: "md" | "lg";
  autoFocus?: boolean;
  inputRef?: RefObject<HTMLInputElement | null>;
  clearLabel?: string;
  className?: string;
  onKeyDown?: InputHTMLAttributes<HTMLInputElement>["onKeyDown"];
}) {
  return (
    <label className={cx("ui-search", size === "lg" && "ui-search--lg", className)}>
      <Search aria-hidden="true" />
      <input
        ref={inputRef}
        type="search"
        value={value}
        autoFocus={autoFocus}
        onChange={(event) => onChange(event.currentTarget.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        aria-label={label ?? placeholder}
      />
      {value && clearLabel && (
        <button
          type="button"
          className="ui-search__clear"
          aria-label={clearLabel}
          onClick={() => onChange("")}
        >
          <X aria-hidden="true" />
        </button>
      )}
    </label>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="ui-kbd">{children}</kbd>;
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

export function CheckMark({ checked }: { checked: boolean }) {
  return (
    <span className={cx("ui-check", checked && "ui-check--on")} aria-hidden="true">
      <Check strokeWidth={3} />
    </span>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange(value: boolean): void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      className="ui-switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    />
  );
}

export function Chip({
  active = false,
  outline = false,
  size = "md",
  dot,
  onRemove,
  removeLabel,
  className,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  active?: boolean;
  outline?: boolean;
  size?: "md" | "lg" | "xl";
  dot?: string;
  onRemove?(): void;
  removeLabel?: string;
}) {
  return (
    <button
      type="button"
      className={cx(
        "ui-chip",
        active && "ui-chip--active",
        outline && "ui-chip--outline",
        size !== "md" && `ui-chip--${size}`,
        className,
      )}
      aria-pressed={
        props["aria-pressed"] ?? (onRemove || props.role ? undefined : active)
      }
      {...props}
    >
      {dot && <span className="ui-chip__dot" data-folder-color={dot} />}
      {children}
      {onRemove && (
        <span
          role="button"
          tabIndex={0}
          className="ui-chip__remove"
          aria-label={removeLabel}
          onClick={(event) => {
            event.stopPropagation();
            onRemove();
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              event.stopPropagation();
              onRemove();
            }
          }}
        >
          <X aria-hidden="true" />
        </span>
      )}
    </button>
  );
}

export function Tabs<T extends string>({
  value,
  onChange,
  items,
  label,
  underline = false,
  className,
}: {
  value: T;
  onChange(value: T): void;
  items: Array<{ id: T; label: ReactNode; icon?: ReactNode }>;
  label: string;
  underline?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cx("ui-tabs", underline && "ui-tabs--underline", className)}
      role="tablist"
      aria-label={label}
    >
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="tab"
          aria-selected={item.id === value}
          onClick={() => onChange(item.id)}
        >
          {item.icon}
          {item.label}
        </button>
      ))}
    </div>
  );
}

export function Segmented<T extends string>({
  value,
  onChange,
  items,
  label,
}: {
  value: T;
  onChange(value: T): void;
  items: Array<{ id: T; label: ReactNode }>;
  label: string;
}) {
  return (
    <div className="ui-segmented" role="radiogroup" aria-label={label}>
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="radio"
          aria-checked={item.id === value}
          onClick={() => onChange(item.id)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

/* Popovers ----------------------------------------------------------------- */

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
  placement?: "bottom-start" | "bottom-end" | "side-start" | "top-start";
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
            ["--popover-max-height" as string]: `${maxHeight}px`,
            visibility: "visible",
          });
          return;
        }
      }
      const below = window.innerHeight - anchorBox.bottom - gap - viewportGap;
      const above = anchorBox.top - gap - viewportGap;
      const openAbove =
        placement === "top-start"
          ? above >= Math.min(measuredHeight, below) || above > below
          : measuredHeight > below && above > below;
      const availableHeight = Math.max(openAbove ? above : below, 120);
      const preferredLeft =
        placement === "bottom-end" ? anchorBox.right - targetWidth : anchorBox.left;
      const left = Math.min(
        Math.max(preferredLeft, viewportGap),
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
        ["--popover-max-height" as string]: `${availableHeight}px`,
        visibility: "visible",
      });
    }

    position();
    const frame = window.requestAnimationFrame(position);
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    // Lazy content (emoji picker, query results) changes the height after mount.
    const observer =
      typeof ResizeObserver === "undefined" || !layer.current
        ? null
        : new ResizeObserver(() => position());
    if (layer.current) observer?.observe(layer.current);
    // The anchor itself can move without a scroll event (layout shifts in a
    // bottom-anchored feed); follow it while the popover is open.
    let lastAnchor = "";
    let watcher = window.requestAnimationFrame(function watch() {
      const box = anchorRef.current?.getBoundingClientRect();
      const key = box ? `${box.left},${box.top},${box.width},${box.height}` : "";
      if (key !== lastAnchor) {
        lastAnchor = key;
        position();
      }
      watcher = window.requestAnimationFrame(watch);
    });
    return () => {
      window.cancelAnimationFrame(frame);
      window.cancelAnimationFrame(watcher);
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
      observer?.disconnect();
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
  hideLabel = false,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & {
  label: string;
  name: string;
  children: ReactNode;
  hideLabel?: boolean;
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
      <span
        className={cx("ui-field__label", hideLabel && "visually-hidden")}
        id={labelID}
      >
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

/* Dialog ------------------------------------------------------------------- */

export function Dialog({
  title,
  description,
  onClose,
  children,
  className,
  size = "md",
  sheet = false,
  plain = false,
  footer,
  hideClose = false,
  bodyClassName,
}: {
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  size?: "sm" | "md" | "lg";
  /** On phones render as a bottom sheet instead of a full-screen dialog. */
  sheet?: boolean;
  /** Header without a bottom border (for short confirmations). */
  plain?: boolean;
  footer?: ReactNode;
  hideClose?: boolean;
  bodyClassName?: string;
}) {
  const { t } = useTranslation();
  const dialog = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const first = dialog.current?.querySelector<HTMLElement>(
      "[autofocus], input, textarea, select, button:not([data-dialog-close]), [href], [tabindex]:not([tabindex='-1'])",
    );
    (first ?? dialog.current)?.focus();
    function keyboard(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
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
  return createPortal(
    <div
      className="ui-dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={dialog}
        tabIndex={-1}
        className={cx(
          "ui-dialog",
          size !== "md" && `ui-dialog--${size}`,
          sheet && "ui-dialog--sheet",
          plain && "ui-dialog--plain",
          className,
        )}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <span className="ui-dialog__handle" aria-hidden="true" />
        <header className="ui-dialog__head">
          <div>
            <h2>{title}</h2>
            {description && <p>{description}</p>}
          </div>
          {!hideClose && (
            <IconButton
              size="icon-sm"
              label={t("close")}
              data-dialog-close
              onClick={onClose}
            >
              <X />
            </IconButton>
          )}
        </header>
        <div className={cx("ui-dialog__body", bodyClassName)}>{children}</div>
        {footer && <footer className="ui-dialog__foot">{footer}</footer>}
      </section>
    </div>,
    document.body,
  );
}

/* Avatar ------------------------------------------------------------------- */

export type Presence = "online" | "away" | "offline";

export function Avatar({
  name,
  seed,
  size = "md",
  online = false,
  presence,
  agent = false,
  square = false,
  actorID,
  avatarVersion = 0,
  className,
  glyph,
}: {
  name: string;
  seed?: string;
  /** Overrides the initials, e.g. "#" for channels. */
  glyph?: string;
  size?: "xs" | "sm" | "md" | "lg" | "xl" | "xxl";
  /** Legacy boolean form of `presence="online"`. */
  online?: boolean;
  presence?: Presence;
  agent?: boolean;
  square?: boolean;
  actorID?: string;
  avatarVersion?: number;
  className?: string;
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
  const initials = initialsOf(name);
  const resolvedPresence = presence ?? (online ? "online" : undefined);
  return (
    <span
      className={cx(
        "ui-avatar",
        `ui-avatar--${size}`,
        agent && "ui-avatar--agent",
        square && "ui-avatar--square",
        className,
      )}
      data-avatar-color={stableAvatarIndex(seed || name)}
    >
      <span className="ui-avatar__face">
        {source ? <img src={source} alt="" /> : glyph || initials || "U"}
      </span>
      {agent && !square && (
        <span className="ui-avatar__badge" aria-hidden="true">
          <Bot strokeWidth={3} />
        </span>
      )}
      {resolvedPresence && !agent && (
        <i
          aria-hidden="true"
          className={cx(
            resolvedPresence !== "online" &&
              `ui-avatar__presence--${resolvedPresence}`,
          )}
        />
      )}
    </span>
  );
}

export function initialsOf(name: string) {
  const words = name
    .trim()
    .split(/[\s-]+/)
    .filter((word) => /[\p{L}\p{N}]/u.test(word));
  if (words.length === 0) return "";
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return words
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}

export function AvatarStack({ children }: { children: ReactNode }) {
  return <span className="ui-avatar-stack">{children}</span>;
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

/* Badges & status ---------------------------------------------------------- */

export function Badge({
  children,
  tone = "neutral",
  size = "md",
  className,
}: {
  children: ReactNode;
  tone?: "neutral" | "primary" | "success" | "danger" | "soft";
  size?: "md" | "lg";
  className?: string;
}) {
  return (
    <span
      className={cx(
        "ui-badge",
        `ui-badge--${tone}`,
        size === "lg" && "ui-badge--lg",
        className,
      )}
    >
      {children}
    </span>
  );
}

export function countLabel(value: number) {
  return value > 99 ? "99+" : String(value);
}

export function Tag({
  children,
  tone = "neutral",
  size = "md",
}: {
  children: ReactNode;
  tone?: "neutral" | "agent" | "primary";
  size?: "md" | "lg";
}) {
  return (
    <span
      className={cx(
        "ui-tag",
        tone !== "neutral" && `ui-tag--${tone}`,
        size === "lg" && "ui-tag--lg",
      )}
    >
      {children}
    </span>
  );
}

export function PresenceDot({
  state,
  pulse = false,
}: {
  state?: Presence;
  pulse?: boolean;
}) {
  return (
    <span
      className={cx(
        "ui-presence",
        state && `ui-presence--${state}`,
        pulse && "ui-presence--pulse",
      )}
      aria-hidden="true"
    />
  );
}

/* Feedback ----------------------------------------------------------------- */

export function FormError({ message }: { message: string }) {
  return message ? <InlineError title={message} /> : null;
}

export function InlineError({
  title,
  hint,
  onRetry,
  retryLabel,
  center = false,
}: {
  title: string;
  hint?: string;
  onRetry?(): void;
  retryLabel?: string;
  center?: boolean;
}) {
  return (
    <div
      className={cx("ui-inline-error", center && "ui-inline-error--center")}
      role="alert"
    >
      <AlertCircle aria-hidden="true" />
      <span className="ui-inline-error__copy">
        <span>{title}</span>
        {hint && <small>{hint}</small>}
      </span>
      {onRetry && retryLabel && (
        <button type="button" className="ui-inline-error__action" onClick={onRetry}>
          {retryLabel}
        </button>
      )}
    </div>
  );
}

export function InlineSuccess({
  title,
  hint,
}: {
  title: string;
  hint?: string;
}) {
  return (
    <div className="ui-inline-success" role="status">
      <CheckCircle2 aria-hidden="true" />
      <span>
        {title}
        {hint && <small>{hint}</small>}
      </span>
    </div>
  );
}

export function InkCard({
  icon,
  title,
  children,
  className,
}: {
  icon?: ReactNode;
  title: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx("ui-ink-card", className)}>
      {icon}
      <div>
        <strong>{title}</strong>
        {children && <p>{children}</p>}
      </div>
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  hint,
  action,
  compact = false,
  className,
}: {
  icon?: ReactNode;
  title: ReactNode;
  hint?: ReactNode;
  action?: ReactNode;
  compact?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cx("ui-empty", compact && "ui-empty--compact", className)}
      role="status"
    >
      {!compact && (
        <span className="ui-empty__icon" aria-hidden="true">
          {icon ?? <Inbox />}
        </span>
      )}
      <strong>{title}</strong>
      {hint && <p>{hint}</p>}
      {action}
    </div>
  );
}

export function Menu({
  label,
  children,
  className,
  touch = false,
}: {
  label: string;
  children: ReactNode;
  className?: string;
  touch?: boolean;
}) {
  return (
    <div
      className={cx("ui-menu", touch && "ui-menu--touch", className)}
      role="menu"
      aria-label={label}
    >
      {children}
    </div>
  );
}

export function MenuItem({
  icon,
  children,
  meta,
  danger = false,
  checked,
  active = false,
  className,
  role = "menuitem",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  icon?: ReactNode;
  meta?: ReactNode;
  danger?: boolean;
  checked?: boolean;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      role={role}
      aria-checked={checked}
      className={cx(
        "ui-menu__item",
        danger && "ui-menu__item--danger",
        active && "ui-menu__item--active",
        className,
      )}
      {...props}
    >
      {icon}
      <span>{children}</span>
      {meta && <span className="ui-menu__meta">{meta}</span>}
      {checked && <Check className="ui-menu__check" aria-hidden="true" />}
    </button>
  );
}

export function MenuDivider() {
  return <div className="ui-menu__divider" role="separator" />;
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <div className="ui-menu__label">{children}</div>;
}

export function Popover({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={cx("ui-popover", className)}>{children}</div>;
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
  ink = false,
  icon,
  action,
  className,
}: {
  children: ReactNode;
  tone?: "neutral" | "danger" | "success";
  ink?: boolean;
  icon?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cx(
        "ui-toast",
        `ui-toast--${tone}`,
        ink && "ui-toast--ink",
        className,
      )}
      role="status"
    >
      {icon}
      <span className="ui-toast__text">{children}</span>
      {action}
    </div>
  );
}

export function Skeleton({
  width,
  height,
  shape = "text",
  className,
}: {
  width?: number | string;
  height?: number | string;
  shape?: "text" | "circle" | "rect";
  className?: string;
}) {
  return (
    <span
      className={cx(
        "ui-skeleton",
        shape !== "text" && `ui-skeleton--${shape}`,
        className,
      )}
      style={{ width, height: height ?? (shape === "circle" ? width : undefined) }}
      aria-hidden="true"
    />
  );
}

export function SkeletonRow({
  avatar = 40,
  lines = ["62%", "80%"],
}: {
  avatar?: number;
  lines?: [string, string];
}) {
  return (
    <div className="ui-skeleton-row" aria-hidden="true">
      <Skeleton shape="circle" width={avatar} />
      <div>
        <span className="ui-skeleton-row__lines">
          <Skeleton width={lines[0]} height={14} />
          <Skeleton width={32} height={12} />
        </span>
        <Skeleton width={lines[1]} />
      </div>
    </div>
  );
}
