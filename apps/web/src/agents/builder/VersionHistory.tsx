import { useQuery } from "@tanstack/react-query";
import type { Agent, MessengerAPI } from "@comamessenger/core";
import { RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button, Tag } from "../../ui";

/** Published versions; any older one can become the new draft (phase 5.2). */
export function VersionHistory({
  api,
  agent,
  canPublish,
  pending,
  onRollback,
}: {
  api: MessengerAPI;
  agent: Agent;
  canPublish: boolean;
  pending: boolean;
  onRollback(versionID: string): void;
}) {
  const { t, i18n } = useTranslation();
  const versions = useQuery({
    queryKey: ["agent-versions", agent.id, agent.published_version],
    queryFn: () => api.agentVersions(agent.id),
  });
  if (!versions.data?.length) return null;
  return (
    <section className="agent-versions">
      <h4>{t("agentVersionHistory")}</h4>
      <p className="agent-muted">{t("agentVersionsLead")}</p>
      {versions.data.map((version) => (
        <div key={version.id} className="agent-line">
          <span className="agent-line__text">
            <strong>
              {t("agentVersionShort", { version: version.version })}
            </strong>
            <small>
              {new Date(version.published_at).toLocaleString(i18n.language, {
                day: "numeric",
                month: "long",
                hour: "2-digit",
                minute: "2-digit",
              })}
            </small>
          </span>
          <span className="agent-line__control">
            {version.version === agent.published_version ? (
              <Tag>{t("agentVersionCurrent")}</Tag>
            ) : (
              canPublish && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={pending}
                  onClick={() => onRollback(version.id)}
                >
                  <RotateCcw />
                  {t("agentRollback")}
                </Button>
              )
            )}
          </span>
        </div>
      ))}
    </section>
  );
}
