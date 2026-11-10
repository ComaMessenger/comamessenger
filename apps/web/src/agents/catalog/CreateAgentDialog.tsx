import { useState } from "react";
import type {
  Agent,
  AgentLlmConnection,
  Chat,
  MessengerAPI,
} from "@comamessenger/core";
import { Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { messageOf } from "../../errors";
import { Button, Dialog, Field, FormError, SelectField } from "../../ui";
import type { AgentTemplate } from "../agentTemplates";
import { emptyDraft } from "../shared/draft";
import { chatName } from "../shared/format";

/** The connection a new agent starts with: one healthy workspace model. */
export function defaultConnection(
  connections: AgentLlmConnection[],
): AgentLlmConnection | undefined {
  const enabled = connections.filter((connection) => connection.enabled);
  return (
    enabled.find((connection) => connection.health_status === "healthy") ??
    enabled[0]
  );
}

/**
 * A short start: name and first chat. Everything else is set in the builder,
 * which opens right after the draft is created.
 */
export function CreateAgentDialog({
  api,
  template,
  chats,
  connections,
  timezone,
  onClose,
  onCreated,
}: {
  api: MessengerAPI;
  template: AgentTemplate;
  chats: Chat[];
  connections: AgentLlmConnection[];
  timezone: string;
  onClose(): void;
  onCreated(agent: Agent): Promise<void>;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(() =>
    template === "custom" ? "" : t(`agentTemplate_${template}`),
  );
  const [chatID, setChatID] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const chatRequired = template !== "custom";

  async function create() {
    setError("");
    if (!name.trim()) {
      setError(t("agentCreateNameRequired"));
      return;
    }
    if (chatRequired && !chatID) {
      setError(t("agentCreateChatRequired"));
      return;
    }
    setPending(true);
    try {
      const draft = emptyDraft(template);
      const connection = defaultConnection(connections);
      const created = await api.createAgent({
        ...draft,
        display_name: name.trim(),
        description:
          template === "custom" ? "" : t(`agentTemplateDescription_${template}`),
        chat_ids: chatID ? [chatID] : [],
        enabled: false,
        ...(connection
          ? {
              llm_connection_id: connection.id,
              provider: connection.provider,
              endpoint_url: "",
              model: connection.default_model || draft.model,
            }
          : { llm_connection_id: undefined }),
      });
      // Recipe rules are created by the server in UTC; they belong to the
      // creator's timezone so «every day at 09:00» means local 09:00.
      if (template !== "custom" && timezone !== "UTC") {
        const triggers = await api.agentTriggers(created.id);
        await Promise.all(
          triggers
            .filter((trigger) => trigger.timezone === "UTC")
            .map((trigger) =>
              api.updateAgentTrigger(created.id, trigger.id, { timezone }),
            ),
        );
      }
      await onCreated(created);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog
      title={
        template === "custom"
          ? t("agentCreateTitleCustom")
          : t("agentCreateTitle", { role: t(`agentTemplate_${template}`) })
      }
      description={t("agentCreateLead")}
      onClose={onClose}
    >
      <form
        className="agent-create"
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
      >
        <Field
          label={t("agentCreateName")}
          name="agent-create-name"
          value={name}
          placeholder={t("agentCreateNamePlaceholder")}
          onChange={(event) => setName(event.target.value)}
        />
        <SelectField
          required={false}
          label={t("agentCreateChat")}
          name="agent-create-chat"
          value={chatID}
          onChange={(event) => setChatID(event.target.value)}
        >
          <option value="">
            {chatRequired ? t("agentChooseChat") : t("agentCreateChatLater")}
          </option>
          {chats.map((chat) => (
            <option key={chat.id} value={chat.id}>
              {chatName(chat)}
            </option>
          ))}
        </SelectField>
        <p className="agent-create__hint">{t("agentCreateSafe")}</p>
        <FormError message={error} />
        <div className="ui-dialog__actions">
          <Button variant="ghost" disabled={pending} onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button type="submit" variant="primary" pending={pending}>
            <Plus />
            {t("agentCreateSubmit")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
