import { useTranslation } from "react-i18next";

/** "AUTO-REPLY" next to the author of an auto-reply (decision 4). */
export function AutoReplyTag() {
  const { t } = useTranslation();
  return <span className="auto-reply-tag">{t("autoReplyTag")}</span>;
}
