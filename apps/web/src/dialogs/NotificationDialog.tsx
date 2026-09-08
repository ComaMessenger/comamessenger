import { useState } from "react";
import { Bell, BellOff, Info } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button, Dialog, InlineError } from "../ui";
import { messageOf } from "../errors";
import { base64Key } from "../lib/forms";
import { useMessenger } from "../shell/MessengerContext";

const browserHelpURL =
  "https://support.google.com/chrome/answer/3220216?hl=ru";

export function NotificationDialog({ onClose }: { onClose(): void }) {
  const { t } = useTranslation();
  const { api } = useMessenger();
  const supported =
    "Notification" in window &&
    "serviceWorker" in navigator &&
    "PushManager" in window;
  const [permission, setPermission] = useState<NotificationPermission>(
    supported ? Notification.permission : "denied",
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  async function enable() {
    setPending(true);
    setError("");
    try {
      const config = await api.pushConfig();
      if (!config.enabled) throw new Error(t("notificationUnavailable"));
      const registration = await navigator.serviceWorker.register("/sw.js");
      const result = await Notification.requestPermission();
      setPermission(result);
      if (result !== "granted") return;
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: base64Key(config.public_key),
      });
      const json = subscription.toJSON();
      await api.registerPush({
        endpoint: subscription.endpoint,
        keys: { p256dh: json.keys?.p256dh ?? "", auth: json.keys?.auth ?? "" },
      });
      await api.updatePreferences({ push_enabled: true });
      window.dispatchEvent(new Event("coma-notifications-changed"));
      onClose();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setPending(false);
    }
  }
  const variant = !supported
    ? "unsupported"
    : permission === "denied"
      ? "denied"
      : "default";
  return (
    <Dialog
      title={t("notificationEnable")}
      onClose={onClose}
      size="sm"
      sheet
      plain
      hideClose
      className={`notify-dialog notify-dialog--${variant}`}
      footer={
        variant === "unsupported" ? (
          <>
            <Button variant="primary" disabled>
              {t("enable")}
            </Button>
            <Button onClick={onClose}>{t("understood")}</Button>
          </>
        ) : variant === "denied" ? (
          <>
            <Button variant="primary" disabled>
              {t("enable")}
            </Button>
            <a className="ui-button ui-button--ghost ui-button--md" href={browserHelpURL} target="_blank" rel="noreferrer">
              {t("howToAllow")}
            </a>
          </>
        ) : (
          <>
            <Button onClick={onClose} disabled={pending}>
              {t("skip")}
            </Button>
            <Button variant="primary" pending={pending} onClick={() => void enable()}>
              {t("enable")}
            </Button>
          </>
        )
      }
    >
      <span className="notify-dialog__icon" aria-hidden="true">
        {variant === "denied" ? <BellOff /> : variant === "unsupported" ? <Info /> : <Bell />}
      </span>
      <h3 className="notify-dialog__title">
        {variant === "denied"
          ? t("notificationDenied")
          : variant === "unsupported"
            ? t("pushUnsupportedTitle")
            : t("enableNotificationsTitle")}
      </h3>
      <p className="notify-dialog__text">
        {variant === "denied"
          ? t("notificationDeniedHint")
          : variant === "unsupported"
            ? t("pushUnsupportedHint")
            : t("enableNotificationsHint")}
      </p>
      {error && <InlineError title={error} />}
    </Dialog>
  );
}
