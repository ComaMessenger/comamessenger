import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import {
  chatName,
  hasPermission,
  userTimezone,
  type AgentBuilderStep,
  type Chat,
  type User,
} from "@comamessenger/core";
import { useMessenger } from "@/messenger/MessengerProvider";
import { useSignedIn } from "@/session/SessionProvider";

/*
 * Data of the agent builder screens: the same requests and query keys as the
 * web builder (`apps/web/src/agents`), so a change saved on one screen is
 * seen by the others.
 */

export const agentKeys = {
  agents: ["agents"] as const,
  connections: ["agent-llm-connections"] as const,
  recipes: (locale: string) => ["agent-recipes", locale] as const,
  triggers: (agentID: string) => ["agent-triggers", agentID] as const,
  collections: ["knowledge", "collections"] as const,
  documents: (collectionID: string) =>
    ["knowledge", "documents", collectionID] as const,
  mcpConnections: ["mcp-connections"] as const,
  webhooks: ["integration-webhooks"] as const,
  versions: (agentID: string) => ["agent-versions", agentID] as const,
  keys: (agentID: string) => ["agent-keys", agentID] as const,
};

/** Paths of the builder screens; the agents tab links here. */
export const agentBuilderPaths = {
  create: "/agents/new",
  architect: "/agents/new/architect",
  templates: "/agents/new/templates",
  template: (recipeID: string) =>
    `/agents/new/${encodeURIComponent(recipeID)}` as const,
  edit: (agentID: string) =>
    `/agents/${encodeURIComponent(agentID)}/edit` as const,
  step: (agentID: string, step: AgentBuilderStep) =>
    `/agents/${encodeURIComponent(agentID)}/edit/${step}` as const,
  rule: (agentID: string) =>
    `/agents/${encodeURIComponent(agentID)}/edit/rule` as const,
  advanced: (agentID: string) =>
    `/agents/${encodeURIComponent(agentID)}/edit/advanced` as const,
  editArchitect: (agentID: string) =>
    `/agents/${encodeURIComponent(agentID)}/edit/architect` as const,
};

export type AgentAccess = {
  canBuild: boolean;
  canPublish: boolean;
  canIntegrate: boolean;
  canManageKnowledge: boolean;
};

/** The same permissions the web builder asks for. */
export function agentAccess(user: User): AgentAccess {
  return {
    canBuild: hasPermission(user, "agents.build"),
    canPublish: hasPermission(user, "agents.publish"),
    canIntegrate: hasPermission(user, "integrations.manage"),
    canManageKnowledge: hasPermission(user, "knowledge.manage"),
  };
}

export function useAgentAccess(): AgentAccess {
  const { user } = useSignedIn();
  return useMemo(() => agentAccess(user), [user]);
}

export function useTimezone(): string {
  const { user } = useSignedIn();
  return userTimezone(user.timezone);
}

export function useAgents() {
  const { api } = useSignedIn();
  return useQuery({ queryKey: agentKeys.agents, queryFn: () => api.agents() });
}

export function useConnections() {
  const { api } = useSignedIn();
  return useQuery({
    queryKey: agentKeys.connections,
    queryFn: () => api.agentLlmConnections(),
  });
}

/** Built-in roles from Core in the interface language. */
export function useRecipes() {
  const { api } = useSignedIn();
  const { i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language ?? "en";
  return useQuery({
    queryKey: agentKeys.recipes(locale),
    queryFn: () => api.agentRecipes(locale),
    staleTime: Infinity,
  });
}

export function useTriggers(agentID: string | undefined) {
  const { api } = useSignedIn();
  return useQuery({
    queryKey: agentKeys.triggers(agentID ?? ""),
    queryFn: () => api.agentTriggers(agentID!),
    enabled: Boolean(agentID),
  });
}

export function useCollections(enabled = true) {
  const { api } = useSignedIn();
  return useQuery({
    queryKey: agentKeys.collections,
    queryFn: () => api.knowledgeCollections(),
    enabled,
  });
}

/** Chats of the workspace the person is in, by name. */
export function useChats(): Chat[] {
  const { store } = useMessenger();
  const chats = useStore(store, (state) => state.chats);
  return useMemo(
    () =>
      Object.values(chats).sort((a, b) =>
        chatName(a).localeCompare(chatName(b)),
      ),
    [chats],
  );
}
