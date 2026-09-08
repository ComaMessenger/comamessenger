import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { cx } from "../ui";
import { useMessenger } from "./MessengerContext";

export function ConnectionPill({ className }: { className?: string }) {
  const { t } = useTranslation();
  const { store } = useMessenger();
  const realtime = useStore(store, (state) => state.realtime);
  const live = realtime === "live";
  return (
    <div
      className={cx("connection-pill", live ? "connection-pill--live" : "connection-pill--offline", className)}
      role="status"
    >
      <i aria-hidden="true" />
      {live ? t("live") : t("offlineReconnecting")}
    </div>
  );
}
