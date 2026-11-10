import { useQuery } from "@tanstack/react-query";
import type {
  AgentMcpBinding,
  McpConnection,
  MessengerAPI,
} from "@comamessenger/core";
import { Plug, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { IconButton, SelectField, Switch, Tag } from "../../ui";
import { externalMode } from "../shared/confirmation";
import { ModeChoice } from "./SkillsBlock";

type Tool = { name: string; description: string; readOnly: boolean };

/**
 * Tools of a connection an agent may be given: the assignable ones, and once
 * Core knows the catalog only those the server offers. A tool missing from
 * the catalog is treated as changing data, as the server does.
 */
export function assignableTools(connection: McpConnection): Tool[] {
  const catalog = connection.tools ?? [];
  const known = new Map(catalog.map((tool) => [tool.name, tool]));
  const names = connection.assignable_tools ?? catalog.map((tool) => tool.name);
  return names
    .filter((name) => !connection.tools_refreshed_at || known.has(name))
    .map((name) => ({
      name,
      description: known.get(name)?.description ?? "",
      readOnly: known.get(name)?.read_only === true,
    }));
}

/**
 * External systems in block «Что умеет»: workspace connections released for
 * agents, the tools the agent may call within the connection policy, and for
 * each tool that changes data — «сам» or «после подтверждения».
 */
export function ExternalSystems({
  api,
  bindings,
  onChange,
}: {
  api: MessengerAPI;
  bindings: AgentMcpBinding[];
  onChange(bindings: AgentMcpBinding[]): void;
}) {
  const { t } = useTranslation();
  const connections = useQuery({
    queryKey: ["mcp-connections"],
    queryFn: () => api.mcpConnections(),
    retry: false,
  });
  if (connections.isError) return null;
  const byID = new Map(
    (connections.data ?? []).map((connection) => [connection.id, connection]),
  );
  const available = (connections.data ?? []).filter(
    (connection) =>
      connection.agent_use_allowed &&
      connection.enabled &&
      !bindings.some((binding) => binding.connection_id === connection.id),
  );
  if (bindings.length === 0 && available.length === 0) return null;
  const update = (index: number, binding: AgentMcpBinding) =>
    onChange(bindings.map((item, at) => (at === index ? binding : item)));
  return (
    <div className="agent-external">
      <div className="agent-block__sub">
        <Plug aria-hidden="true" />
        <span>
          <strong>{t("agentExternalTitle")}</strong>
          <small>{t("agentExternalHint")}</small>
        </span>
      </div>
      {bindings.map((binding, index) => {
        const connection = byID.get(binding.connection_id);
        const requires = connection?.writes_require_confirmation ?? true;
        const tools = connection ? assignableTools(connection) : [];
        const name = connection?.name ?? t("agentExternalMissing");
        return (
          <section key={binding.connection_id} className="agent-external__system">
            <header className="agent-line">
              <span className="agent-line__text">
                <strong>{name}</strong>
                {connection?.description && <small>{connection.description}</small>}
              </span>
              <span className="agent-line__control">
                <IconButton
                  size="icon-sm"
                  label={t("agentExternalRemove", { name })}
                  onClick={() =>
                    onChange(bindings.filter((_, at) => at !== index))
                  }
                >
                  <X />
                </IconButton>
              </span>
            </header>
            {tools.length === 0 && (
              <p className="agent-block__empty">{t("agentExternalNoTools")}</p>
            )}
            {tools.map((tool) => {
              const allowed = binding.allowed_tools.includes(tool.name);
              return (
                <div key={tool.name} className="agent-line agent-line--action">
                  <span className="agent-line__text">
                    <span>
                      {tool.name}{" "}
                      <Tag>
                        {t(tool.readOnly ? "agentToolReads" : "agentToolWrites")}
                      </Tag>
                    </span>
                    {tool.description && <small>{tool.description}</small>}
                  </span>
                  <span className="agent-line__control">
                    {allowed && !tool.readOnly && (
                      <ModeChoice
                        label={tool.name}
                        mode={externalMode(binding, tool.name, requires)}
                        locked={requires}
                        lockedReason={t("agentActionLockedConnection")}
                        onChange={(mode) =>
                          update(index, {
                            ...binding,
                            confirmation_policy: {
                              ...(binding.confirmation_policy ?? {}),
                              [tool.name]: mode,
                            },
                          })
                        }
                      />
                    )}
                    <Switch
                      label={t("agentExternalTool", { tool: tool.name })}
                      checked={allowed}
                      onChange={(value) => {
                        const policy = { ...(binding.confirmation_policy ?? {}) };
                        if (!value) delete policy[tool.name];
                        update(index, {
                          ...binding,
                          allowed_tools: value
                            ? [...binding.allowed_tools, tool.name]
                            : binding.allowed_tools.filter(
                                (item) => item !== tool.name,
                              ),
                          confirmation_policy: policy,
                        });
                      }}
                    />
                  </span>
                </div>
              );
            })}
          </section>
        );
      })}
      {available.length > 0 && (
        <SelectField
          required={false}
          label={t("agentExternalAdd")}
          name="agent-external-add"
          value=""
          onChange={(event) => {
            if (!event.target.value) return;
            onChange([
              ...bindings,
              {
                connection_id: event.target.value,
                allowed_tools: [],
                require_write_confirmation: true,
              },
            ]);
          }}
        >
          <option value="">{t("agentExternalChoose")}</option>
          {available.map((connection) => (
            <option key={connection.id} value={connection.id}>
              {connection.name}
            </option>
          ))}
        </SelectField>
      )}
    </div>
  );
}
