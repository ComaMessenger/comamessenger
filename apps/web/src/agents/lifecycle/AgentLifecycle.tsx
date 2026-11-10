import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Agent, MessengerAPI } from "@comamessenger/core";
import { Activity, Play, RotateCcw, Save } from "lucide-react";
import { useTranslation } from "react-i18next";
import { messageOf } from "../../errors";
import { Badge, Button, FormError } from "../../ui";
import { SettingsSection } from "../../settings/components/SettingsPrimitives";

export function AgentLifecycle({
  api,
  agent,
  canPublish,
  onChanged,
}: {
  api: MessengerAPI;
  agent: Agent;
  canPublish: boolean;
  onChanged(agent: Agent): Promise<void>;
}) {
  const { t } = useTranslation();
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const versions = useQuery({
    queryKey: ["agent-versions", agent.id],
    queryFn: () => api.agentVersions(agent.id),
  });

  async function act(
    action: "publish" | "pause" | "resume",
    request: () => Promise<Agent>,
  ) {
    setPending(action);
    setError("");
    setNotice("");
    try {
      await onChanged(await request());
      await versions.refetch();
      setNotice(
        t(
          action === "publish"
            ? "agentPublishedNotice"
            : action === "pause"
              ? "agentPausedNotice"
              : "agentResumedNotice",
        ),
      );
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setPending("");
    }
  }

  return (
    <SettingsSection
      title={t("agentLifecycleTitle")}
      description={t("agentLifecycleDescription")}
      icon={<Activity />}
      wide
    >
      <div className="agent-lifecycle">
        <div className="agent-lifecycle__status">
          <div>
            <strong>
              {agent.draft_version
                ? t("agentDraftVersion", { version: agent.draft_version })
                : agent.published_version
                  ? t("agentPublishedVersion", {
                      version: agent.published_version,
                    })
                  : t("agentNeverPublished")}
            </strong>
            <small>
              {agent.published_version
                ? t("agentPublishedVersion", {
                    version: agent.published_version,
                  })
                : t("agentNeverPublished")}
            </small>
          </div>
          {canPublish && (
            <div className="agent-lifecycle__actions">
              {agent.has_unpublished_changes && (
                <Button
                  disabled={Boolean(pending) || !agent.readiness.ready}
                  onClick={() =>
                    void act("publish", () => api.publishAgent(agent.id))
                  }
                >
                  <Save />
                  {t("agentPublish")}
                </Button>
              )}
              {agent.operational_status === "active" && (
                <Button
                  variant="ghost"
                  disabled={Boolean(pending)}
                  onClick={() =>
                    void act("pause", () => api.pauseAgent(agent.id))
                  }
                >
                  {t("agentPause")}
                </Button>
              )}
              {agent.operational_status === "paused" && (
                <Button
                  disabled={Boolean(pending)}
                  onClick={() =>
                    void act("resume", () => api.resumeAgent(agent.id))
                  }
                >
                  <Play />
                  {t("agentResume")}
                </Button>
              )}
            </div>
          )}
        </div>
        <FormError message={error} />
        {notice && <Badge tone="success">{notice}</Badge>}
        {(versions.data?.length ?? 0) > 0 && (
          <div className="agent-version-list">
            <h3>{t("agentVersionHistory")}</h3>
            {versions.data?.map((version) => (
              <div key={version.id}>
                <span>
                  <strong>v{version.version}</strong>
                  <small>
                    {new Date(version.published_at).toLocaleString()}
                  </small>
                </span>
                {canPublish && version.version !== agent.published_version && (
                  <Button
                    variant="ghost"
                    disabled={Boolean(pending)}
                    onClick={() => {
                      setPending(`rollback-${version.id}`);
                      setError("");
                      setNotice("");
                      void api
                        .rollbackAgent(agent.id, version.id)
                        .then(async (updated) => {
                          await onChanged(updated);
                          setNotice(t("agentRollbackNotice"));
                        })
                        .catch((cause) => setError(messageOf(cause)))
                        .finally(() => setPending(""));
                    }}
                  >
                    <RotateCcw />
                    {t("agentRollback")}
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </SettingsSection>
  );
}
