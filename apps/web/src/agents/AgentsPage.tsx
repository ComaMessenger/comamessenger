import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { MessengerAPI, User } from "@comamessenger/core";
import { useTranslation } from "react-i18next";
import { EmptyState, Skeleton } from "../ui";
import { SettingsAccessDenied } from "../settings/components/SettingsPrimitives";
import { AgentActivityPage } from "./activity/AgentActivityPage";
import { AgentPlatformHeader } from "./AgentPlatformHeader";
import type { AgentTemplate } from "./agentTemplates";
import { AgentBuilder } from "./builder/AgentBuilder";
import { AgentCatalog } from "./catalog/AgentCatalog";
import { CreateAgentDialog } from "./catalog/CreateAgentDialog";
import { AgentConnectionsPage } from "./connections/AgentConnectionsPage";
import { agentRoute, builderAnchor } from "./routes";
import { agentAccess } from "./shared/access";
import { userTimezone } from "./shared/format";

/** Agent platform shell: `/agents/*` routing and the shared queries. */
export function AgentsPage({
  api,
  user,
  path,
  navigate,
}: {
  api: MessengerAPI;
  user: User;
  path: string;
  navigate(to: string): void;
}) {
  const { t } = useTranslation();
  const access = agentAccess(user);
  const { canBuild, canApprove, allowed } = access;
  const route = agentRoute(path);
  const agents = useQuery({
    queryKey: ["agents"],
    queryFn: () => api.agents(),
    enabled: allowed,
  });
  const chats = useQuery({
    queryKey: ["agent-chats"],
    queryFn: () => api.chats(),
    enabled: allowed,
  });
  const connections = useQuery({
    queryKey: ["agent-llm-connections"],
    queryFn: () => api.agentLlmConnections(),
    enabled: allowed,
  });
  const approvals = useQuery({
    queryKey: ["agent-tool-confirmations"],
    queryFn: () => api.agentToolConfirmations("pending"),
    enabled: canApprove,
    refetchInterval: 15_000,
  });
  const [creating, setCreating] = useState<AgentTemplate | null>(null);
  const timezone = userTimezone(user.timezone);
  const selected =
    route.kind === "agent"
      ? agents.data?.find((agent) => agent.id === route.agentID)
      : undefined;
  const showActivity =
    (route.kind === "global" &&
      (route.section === "activity" || route.section === "approvals")) ||
    (route.kind === "agent" && route.section === "activity");
  const globalTab =
    route.kind === "global"
      ? route.section === "approvals"
        ? "activity"
        : route.section
      : showActivity
        ? "activity"
        : "overview";

  function content() {
    if (!allowed) return <SettingsAccessDenied />;
    if (agents.isLoading || chats.isLoading) return <Skeleton />;
    if (route.kind === "global" && route.section === "connections")
      return <AgentConnectionsPage api={api} canManage={access.canIntegrate} />;
    if (showActivity)
      return (
        <AgentActivityPage
          api={api}
          access={access}
          agents={agents.data ?? []}
          chats={chats.data ?? []}
          initialAgentID={route.kind === "agent" ? route.agentID : ""}
          focusApprovals={
            route.kind === "global" && route.section === "approvals"
          }
          navigate={navigate}
        />
      );
    if (route.kind === "agent") {
      if (!selected)
        return (
          <EmptyState
            title={t("agentNotFound")}
            hint={t("agentNotFoundHint")}
          />
        );
      return (
        <AgentBuilder
          key={selected.id}
          api={api}
          agent={selected}
          access={access}
          chats={chats.data ?? []}
          connections={connections.data ?? []}
          timezone={timezone}
          anchor={builderAnchor(route.section)}
          refetchAgents={agents.refetch}
          navigate={navigate}
        />
      );
    }
    return (
      <AgentCatalog
        agents={agents.data ?? []}
        chats={chats.data ?? []}
        approvals={approvals.data ?? []}
        access={access}
        onCreate={setCreating}
        navigate={navigate}
      />
    );
  }

  return (
    <section className="agent-platform">
      <AgentPlatformHeader
        globalTab={route.kind === "agent" && !showActivity ? null : globalTab}
        access={access}
        pendingApprovals={approvals.data?.length ?? 0}
        navigate={navigate}
      />
      <div className="agent-platform__content">{content()}</div>
      {canBuild && creating && (
        <CreateAgentDialog
          api={api}
          template={creating}
          chats={chats.data ?? []}
          connections={connections.data ?? []}
          timezone={timezone}
          onClose={() => setCreating(null)}
          onCreated={async (created) => {
            setCreating(null);
            await agents.refetch();
            navigate(`/agents/${created.id}`);
          }}
        />
      )}
    </section>
  );
}
