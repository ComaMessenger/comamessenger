import { Stack, useLocalSearchParams } from "expo-router";
import { useTranslation } from "react-i18next";
import { useTheme } from "@/lib/theme";
import { AgentBuilderProvider } from "@/agents/builder/AgentBuilderProvider";
import { useAgentAccess, useAgents } from "@/agents/builder/data";
import { SettingsScreen } from "@/settings/SettingsScreen";
import { Notice } from "@/ui/Notice";

export { RouteError as ErrorBoundary } from "@/ui/RouteError";

/** The builder of one agent: its steps share one draft and its autosave. */
export default function AgentEditLayout() {
  const { t } = useTranslation();
  const theme = useTheme();
  const { agentId } = useLocalSearchParams<{ agentId: string }>();
  const access = useAgentAccess();
  const agents = useAgents();
  const agent = agents.data?.find((item) => item.id === agentId);
  if (!agent || !(access.canBuild || access.canPublish))
    return (
      <SettingsScreen
        title={t("agentBuilderTitle")}
        query={agents}
        allowed={access.canBuild || access.canPublish}
        testID="agent-builder-missing"
      >
        <Notice title={t("agentNotFound")} hint={t("agentNotFoundHint")} />
      </SettingsScreen>
    );
  return (
    <AgentBuilderProvider
      key={agent.id}
      agent={agent}
      refetchAgents={agents.refetch}
    >
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: theme.canvas },
        }}
      />
    </AgentBuilderProvider>
  );
}
