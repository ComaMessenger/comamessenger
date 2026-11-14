import { useCallback, useEffect, useMemo, useRef } from "react";
import { useFocusEffect } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { agentAccess, type Chat, type Agent } from "@comamessenger/core";
import { useMessenger } from "@/messenger/MessengerProvider";
import { useSignedIn } from "@/session/SessionProvider";

/*
 * Data of the agent section. Keys match the web client, so both read the
 * same server answers the same way.
 */
export const agentKeys = {
  agents: ["agents"] as const,
  approvals: ["agent-tool-confirmations"] as const,
  recipes: (locale: string) => ["agent-recipes", locale] as const,
  runs: ["agent-runs"] as const,
  workspaceRuns: (agentID: string) =>
    ["agent-runs", "workspace", agentID] as const,
  agentRuns: (agentID: string) => ["agent-runs", agentID] as const,
  run: (runID: string) => ["agent-run", runID] as const,
  steps: (runID: string) => ["agent-run-steps", runID] as const,
  fragments: (runID: string) => ["agent-run-fragments", runID] as const,
  triggers: (agentID: string) => ["agent-triggers", agentID] as const,
  collections: (agentID: string) =>
    ["agent-response-collections", agentID] as const,
  followups: (agentID: string) => ["agent-followups", agentID] as const,
};

export function useAgentAccess() {
  const { user } = useSignedIn();
  return useMemo(() => agentAccess(user), [user]);
}

/** Every agent of the workspace; only for people who may view the platform. */
export function useAgents() {
  const { api } = useSignedIn();
  const { canView } = useAgentAccess();
  return useQuery({
    queryKey: agentKeys.agents,
    queryFn: () => api.agents(),
    enabled: canView,
    refetchInterval: 60_000,
  });
}

/** Actions waiting for a decision; polled as on the web. */
export function useApprovals() {
  const { api } = useSignedIn();
  const { canApprove } = useAgentAccess();
  return useQuery({
    queryKey: agentKeys.approvals,
    queryFn: () => api.agentToolConfirmations("pending"),
    enabled: canApprove,
    refetchInterval: 15_000,
  });
}

/** Built-in roles in the interface language (Core keeps the texts). */
export function useRecipes(enabled = true) {
  const { api } = useSignedIn();
  const { i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language ?? "en";
  return useQuery({
    queryKey: agentKeys.recipes(locale),
    queryFn: () => api.agentRecipes(locale),
    enabled,
    staleTime: Infinity,
  });
}

/** Chats the reader belongs to: names of the places agents work in. */
export function useKnownChats(): Chat[] {
  const { store } = useMessenger();
  const chats = useStore(store, (state) => state.chats);
  return useMemo(() => Object.values(chats), [chats]);
}

export function useAgent(agentID: string): {
  agent: Agent | undefined;
  query: ReturnType<typeof useAgents>;
} {
  const query = useAgents();
  return {
    agent: query.data?.find((agent) => agent.id === agentID),
    query,
  };
}

/** Refetches on every return to a screen; the first visit already loads. */
export function useRefetchOnFocus(refetch: () => unknown) {
  const visited = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (visited.current) void refetch();
      visited.current = true;
    }, [refetch]),
  );
}

/**
 * Keeps agent data current from realtime: a run that starts, changes state
 * or ends (`agent.status`) may have produced a pending action, a new run or
 * a new status. A reconnect refreshes everything that is on screen.
 */
export function useAgentLiveRefresh() {
  const queryClient = useQueryClient();
  const { store } = useMessenger();
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const refresh = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        for (const key of [
          agentKeys.approvals,
          agentKeys.runs,
          ["agent-run"],
          agentKeys.agents,
        ])
          void queryClient.invalidateQueries({ queryKey: key });
      }, 1_500);
    };
    const unsubscribe = store.subscribe((state, previous) => {
      if (state.agentStatuses !== previous.agentStatuses) refresh();
      if (state.realtime === "live" && previous.realtime !== "live") refresh();
    });
    return () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, [queryClient, store]);
}
