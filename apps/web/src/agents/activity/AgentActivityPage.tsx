import { useEffect, useRef, useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import type { Agent, AgentRun, Chat, MessengerAPI } from "@comamessenger/core";
import { CalendarClock, ListChecks } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Avatar, Button, SelectField, Skeleton, cx } from "../../ui";
import { ApprovalQueue } from "../approvals/ApprovalQueue";
import type { AgentAccess } from "../shared/access";
import {
  chatName,
  formatCost,
  formatDateTime,
  formatTime,
} from "../shared/format";
import { runSentence } from "./feed";

/** Runs of how many agents the feed reads at most, newest agents first. */
const feedAgents = 20;

const today = (value: string) =>
  new Date(value).toDateString() === new Date().toDateString();

/**
 * `/agents/activity`: what agents did, in words, and what waits for a person
 * next to it. `/agents/approvals` and `/agents/:id/activity` open the same
 * page focused on the queue or filtered by one agent.
 */
export function AgentActivityPage({
  api,
  access,
  agents,
  chats,
  initialAgentID,
  focusApprovals,
  navigate,
}: {
  api: MessengerAPI;
  access: AgentAccess;
  agents: Agent[];
  chats: Chat[];
  initialAgentID: string;
  focusApprovals: boolean;
  navigate(to: string): void;
}) {
  const { t, i18n } = useTranslation();
  const { canApprove, canObserve, canBuild, canPublish } = access;
  const canView = canObserve || canBuild || canPublish || canApprove;
  const [agentID, setAgentID] = useState(initialAgentID);
  const queue = useRef<HTMLElement>(null);
  const shown = agentID
    ? agents.filter((agent) => agent.id === agentID)
    : agents.slice(0, feedAgents);
  const runs = useQueries({
    queries: shown.map((agent) => ({
      queryKey: ["agent-runs", agent.id],
      queryFn: () => api.agentRuns(agent.id),
      enabled: canView,
      refetchInterval: 30_000,
    })),
  });
  const approvals = useQuery({
    queryKey: ["agent-tool-confirmations"],
    queryFn: () => api.agentToolConfirmations("pending"),
    enabled: canApprove,
    refetchInterval: 15_000,
  });
  const collections = useQuery({
    queryKey: ["agent-response-collections", agentID],
    queryFn: () => api.agentResponseCollections("open", agentID || undefined),
    enabled: canObserve,
    refetchInterval: 30_000,
  });
  const followups = useQuery({
    queryKey: ["agent-followups", agentID],
    queryFn: () => api.agentFollowups("pending", agentID || undefined),
    enabled: canObserve,
    refetchInterval: 30_000,
  });

  useEffect(() => {
    if (focusApprovals) queue.current?.scrollIntoView({ block: "start" });
  }, [focusApprovals]);

  const agentByID = new Map(agents.map((agent) => [agent.id, agent]));
  const nameOf = (id: string) =>
    agentByID.get(id)?.display_name ?? t("agentUnknown");
  const chatOf = (id: string) => {
    const chat = chats.find((item) => item.id === id);
    return chat ? chatName(chat) : t("agentChatHidden");
  };
  const feed: AgentRun[] = runs
    .flatMap((query) => query.data?.runs ?? [])
    .sort(
      (left, right) =>
        new Date(right.created_at).getTime() -
        new Date(left.created_at).getTime(),
    )
    .slice(0, 40);
  const pendingApprovals = (approvals.data ?? []).filter(
    (item) => !agentID || item.agent_id === agentID,
  );
  const todayRuns = feed.filter(
    (run) => today(run.created_at) && !run.dry_run,
  );
  const failures = todayRuns.filter((run) =>
    ["failed", "timed_out"].includes(run.status),
  ).length;
  const spending = new Map<string, number>();
  for (const run of todayRuns)
    spending.set(
      run.currency,
      (spending.get(run.currency) ?? 0) + Number(run.cost || 0),
    );
  const spent = [...spending.entries()]
    .map(([currency, amount]) => formatCost(amount, currency, i18n.language))
    .join(" + ");

  return (
    <div className="agent-page">
      <div className="agent-page__head">
        <div>
          <h2>{t("agentActivityTitle")}</h2>
          <p>{t("agentActivityLead")}</p>
        </div>
        {agents.length > 1 && (
          <SelectField
            hideLabel
            required={false}
            label={t("agentActivityFilter")}
            name="agent-activity-filter"
            value={agentID}
            onChange={(event) => setAgentID(event.target.value)}
          >
            <option value="">{t("agentActivityAll")}</option>
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.display_name}
              </option>
            ))}
          </SelectField>
        )}
      </div>

      <div className="agent-stats">
        {canView && (
          <span>
            <strong>{todayRuns.length}</strong>
            <small>{t("agentStatRuns")}</small>
          </span>
        )}
        {canApprove && (
          <span>
            <strong>{pendingApprovals.length}</strong>
            <small>{t("agentStatApprovals")}</small>
          </span>
        )}
        {canView && (
          <span className={cx(failures > 0 && "is-danger")}>
            <strong>{failures}</strong>
            <small>{t("agentStatFailures")}</small>
          </span>
        )}
        {canView && (
          <span>
            <strong>{spent || formatCost(0, "USD", i18n.language)}</strong>
            <small>{t("agentStatSpent")}</small>
          </span>
        )}
      </div>

      <div className="agent-activity">
        <div className="agent-activity__side">
          {canApprove && (
            <section className="agent-section" ref={queue} id="agent-approvals">
              <div className="agent-section__title">
                <h3>{t("agentApprovalsTitle")}</h3>
              </div>
              <ApprovalQueue
                api={api}
                agents={agents}
                chats={chats}
                confirmations={pendingApprovals}
                onDecided={() => approvals.refetch()}
              />
            </section>
          )}
          {canObserve && (collections.data?.length ?? 0) > 0 && (
            <section className="agent-section">
              <div className="agent-section__title">
                <h3>{t("agentCollectionsTitle")}</h3>
              </div>
              {collections.data!.map((collection) => (
                <div key={collection.id} className="agent-line agent-line--card">
                  <span className="agent-line__icon" aria-hidden="true">
                    <ListChecks />
                  </span>
                  <span className="agent-line__text">
                    <strong>
                      {t("agentCollectionLine", {
                        agent: nameOf(collection.agent_id),
                        chat: chatOf(collection.chat_id),
                      })}
                    </strong>
                    <small>
                      {[
                        t("agentCollectionCount", {
                          responded: collection.responded_count,
                          expected: collection.expected_count,
                        }),
                        t("agentCollectionDeadline", {
                          time: formatDateTime(collection.deadline_at, i18n.language),
                        }),
                        collection.reminders_sent > 0
                          ? t("agentCollectionReminders", {
                              count: collection.reminders_sent,
                            })
                          : "",
                        collection.note,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </small>
                  </span>
                </div>
              ))}
            </section>
          )}
          {canObserve && (followups.data?.length ?? 0) > 0 && (
            <section className="agent-section">
              <div className="agent-section__title">
                <h3>{t("agentFollowupsTitle")}</h3>
              </div>
              {followups.data!.map((followup) => (
                <div key={followup.id} className="agent-line agent-line--card">
                  <span className="agent-line__icon" aria-hidden="true">
                    <CalendarClock />
                  </span>
                  <span className="agent-line__text">
                    <strong>
                      {t("agentFollowupLine", {
                        agent: nameOf(followup.agent_id),
                        time: formatDateTime(followup.due_at, i18n.language),
                        chat: chatOf(followup.chat_id),
                      })}
                    </strong>
                    {followup.note && <small>{followup.note}</small>}
                  </span>
                </div>
              ))}
            </section>
          )}
        </div>

        {canView && (
          <section className="agent-section agent-activity__feed">
            <div className="agent-section__title">
              <h3>{t("agentFeedTitle")}</h3>
            </div>
            {runs.some((query) => query.isLoading) ? (
              <Skeleton />
            ) : feed.length === 0 ? (
              <p className="agent-block__empty">{t("agentFeedEmpty")}</p>
            ) : (
              <ol className="agent-feed">
                {feed.map((run) => {
                  const agent = agentByID.get(run.agent_id);
                  return (
                    <li
                      key={run.id}
                      className={cx(
                        ["failed", "timed_out"].includes(run.status) &&
                          "is-failed",
                      )}
                    >
                      <time dateTime={run.created_at}>
                        {today(run.created_at)
                          ? formatTime(run.created_at, i18n.language)
                          : formatDateTime(run.created_at, i18n.language)}
                      </time>
                      <Avatar
                        name={agent?.display_name ?? "?"}
                        seed={run.agent_id}
                        actorID={run.agent_id}
                        avatarVersion={agent?.avatar_version}
                        size="sm"
                        agent
                      />
                      <span>
                        <Button
                          variant="ghost"
                          size="xs"
                          className="agent-feed__agent"
                          onClick={() => navigate(`/agents/${run.agent_id}`)}
                        >
                          {nameOf(run.agent_id)}
                        </Button>{" "}
                        {runSentence(t, run, chats)}
                      </span>
                    </li>
                  );
                })}
              </ol>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
