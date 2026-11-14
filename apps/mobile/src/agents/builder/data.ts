import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useStore } from "zustand";
import {
  chatName,
  userTimezone,
  type AgentBuilderStep,
  type Chat,
} from "@comamessenger/core";
import { useMessenger } from "@/messenger/MessengerProvider";
import { useSignedIn } from "@/session/SessionProvider";

/*
 * Data of the agent builder screens: the same requests and query keys as the
 * web builder (`apps/web/src/agents`), so a change saved on one screen is
 * seen by the others.
 */

import { agentKeys } from "../data";

export { agentKeys, useAgentAccess, useAgents, useRecipes } from "../data";
export type { AgentAccess } from "@comamessenger/core";

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

export function useTimezone(): string {
  const { user } = useSignedIn();
  return userTimezone(user.timezone);
}

export function useConnections() {
  const { api } = useSignedIn();
  return useQuery({
    queryKey: agentKeys.connections,
    queryFn: () => api.agentLlmConnections(),
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
    queryKey: agentKeys.knowledgeCollections,
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
