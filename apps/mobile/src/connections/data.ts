import { useCallback } from "react";
import { useFocusEffect } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  apiErrorKey,
  connectionErrorKey,
  connectionRequestErrorKey,
  connectionsAccess,
  knowledgeCollectionsKey,
  type AgentLlmConnection,
  type IntegrationWebhook,
  type McpConnection,
} from "@comamessenger/core";
import { agentKeys } from "@/agents/data";
import i18n from "@/i18n";
import { useSignedIn } from "@/session/SessionProvider";
import "./strings";

/*
 * Query keys are the web's, so both clients name the same data alike. The
 * lists carry only hints of secrets (`key_hint`, `secret_hint`); a webhook
 * secret from creation or rotation never enters the cache.
 */
export const modelsKey = agentKeys.connections;
export const mcpKey = agentKeys.mcpConnections;
export const webhooksKey = agentKeys.webhooks;

export function useConnectionsAccess() {
  const { user } = useSignedIn();
  return connectionsAccess(user);
}

/** Refetches when the screen comes back into view (after a pushed screen). */
function useRefetchOnFocus(refetch: () => unknown, enabled: boolean) {
  useFocusEffect(
    useCallback(() => {
      if (enabled) void refetch();
    }, [enabled, refetch]),
  );
}

export function useModels() {
  const { api } = useSignedIn();
  const access = useConnectionsAccess();
  const query = useQuery({
    queryKey: modelsKey,
    queryFn: () => api.agentLlmConnections(),
    enabled: access.viewModels,
  });
  useRefetchOnFocus(query.refetch, access.viewModels);
  return query;
}

export function useMcpConnections() {
  const { api } = useSignedIn();
  const access = useConnectionsAccess();
  const query = useQuery({
    queryKey: mcpKey,
    queryFn: () => api.mcpConnections(),
    enabled: access.viewIntegrations,
  });
  useRefetchOnFocus(query.refetch, access.viewIntegrations);
  return query;
}

export function useWebhooks() {
  const { api } = useSignedIn();
  const access = useConnectionsAccess();
  const query = useQuery({
    queryKey: webhooksKey,
    queryFn: () => api.integrationWebhooks(),
    enabled: access.manage,
  });
  useRefetchOnFocus(query.refetch, access.manage);
  return query;
}

/**
 * Who uses a model connection: published agents and knowledge collections
 * the person may see. Best effort — the server's refusal on delete decides.
 */
export function useModelUsage(id: string) {
  const { api } = useSignedIn();
  const agents = useQuery({
    queryKey: agentKeys.agents,
    queryFn: () => api.agents(),
    retry: false,
  });
  const collections = useQuery({
    queryKey: knowledgeCollectionsKey,
    queryFn: () => api.knowledgeCollections(),
    retry: false,
  });
  const usedBy = (agents.data ?? []).filter(
    (agent) => agent.llm_connection_id === id,
  );
  const embeddedIn = (collections.data ?? []).filter(
    (collection) => collection.embedding_connection_id === id,
  );
  return {
    agents: usedBy,
    collections: embeddedIn,
    known: agents.isSuccess,
  };
}

/** Puts a changed item into its list so every screen shows it at once. */
export function useStore() {
  const client = useQueryClient();
  return {
    model(item: AgentLlmConnection) {
      client.setQueryData<AgentLlmConnection[]>(modelsKey, (list) =>
        upsert(list, item),
      );
    },
    mcp(item: McpConnection) {
      client.setQueryData<McpConnection[]>(mcpKey, (list) =>
        upsert(list, item),
      );
    },
    webhook(item: IntegrationWebhook) {
      // Strip a secret a creation or rotation response carries.
      const { secret: _secret, ...plain } = item as IntegrationWebhook & {
        secret?: string;
      };
      client.setQueryData<IntegrationWebhook[]>(webhooksKey, (list) =>
        upsert(list, plain),
      );
    },
    remove(key: readonly string[], id: string) {
      client.setQueryData<{ id: string }[]>(key, (list) =>
        list?.filter((item) => item.id !== id),
      );
    },
  };
}

function upsert<T extends { id: string }>(list: T[] | undefined, item: T) {
  if (!list) return [item];
  return list.some((entry) => entry.id === item.id)
    ? list.map((entry) => (entry.id === item.id ? item : entry))
    : [...list, item];
}

/** Human text of a failed request here; the request body is never part of it. */
export function errorText(
  cause: unknown,
  kind: "model" | "mcp" | "webhook",
): string {
  return i18n.t(
    connectionRequestErrorKey(cause, kind) ??
      apiErrorKey(cause) ??
      "errorNetwork",
  );
}

/** «Работает», «Ошибка: ключ не подошёл», «Выключено». */
export function healthText(item: {
  enabled: boolean;
  health_status: "untested" | "healthy" | "unhealthy";
}): string {
  if (!item.enabled) return i18n.t("connDisabled");
  return i18n.t(`connHealth_${item.health_status}`);
}

export function healthErrorText(code: string): string {
  return code ? i18n.t(connectionErrorKey(code)) : "";
}

export function dateTime(value: string): string {
  return new Intl.DateTimeFormat(i18n.language, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
