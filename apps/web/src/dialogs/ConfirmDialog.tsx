import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button, Dialog, cx } from "../ui";

export function ConfirmDialog({
  title,
  description,
  confirmLabel,
  cancelLabel,
  danger = false,
  pending = false,
  icon,
  onConfirm,
  onClose,
}: {
  title: string;
  description?: string;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
  pending?: boolean;
  icon?: ReactNode;
  onConfirm(): void;
  onClose(): void;
}) {
  const { t } = useTranslation();
  return (
    <Dialog
      title={title}
      onClose={onClose}
      size="sm"
      sheet
      plain
      hideClose
      className={cx("confirm-dialog", danger && "confirm-dialog--danger")}
      bodyClassName="confirm-dialog__body"
      footer={
        <>
          <Button onClick={onClose} disabled={pending}>
            {cancelLabel ?? t("cancel")}
          </Button>
          <Button
            variant={danger ? "danger" : "primary"}
            pending={pending}
            onClick={onConfirm}
            autoFocus
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {icon && (
        <span className="confirm-dialog__icon" aria-hidden="true">
          {icon}
        </span>
      )}
      {description && <p className="confirm-dialog__text">{description}</p>}
    </Dialog>
  );
}
