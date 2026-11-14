import { useState } from "react";
import {
  createAgentProblem,
  defaultConnection,
  newAgentRequest,
  triggersToLocalize,
} from "@comamessenger/core";
import type {
  Agent,
  AgentLlmConnection,
  AgentRecipe,
  Chat,
  MessengerAPI,
} from "@comamessenger/core";
import { Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { messageOf } from "../../errors";
import { Button, Dialog, Field, FormError, SelectField } from "../../ui";
import { chatName } from "../shared/format";

export { defaultConnection };

/**
 * A short start: name and first chat. Everything else is set in the builder,
 * which opens right after the draft is created. A recipe agent gets its
 * instructions, scopes and rules from Core.
 */
export function CreateAgentDialog({
  api,
  recipe,
  chats,
  connections,
  timezone,
  onClose,
  onCreated,
}: {
  api: MessengerAPI;
  /** The catalog recipe, or null for a custom agent. */
  recipe: AgentRecipe | null;
  chats: Chat[];
  connections: AgentLlmConnection[];
  timezone: string;
  onClose(): void;
  onCreated(agent: Agent): Promise<void>;
}) {
  const { t, i18n } = useTranslation();
  const [name, setName] = useState(() => recipe?.name ?? "");
  const [chatID, setChatID] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const chatRequired = recipe !== null;

  async function create() {
    setError("");
    const problem = createAgentProblem({ name, chatID, recipe });
    if (problem) {
      setError(t(problem));
      return;
    }
    setPending(true);
    try {
      const created = await api.createAgent(
        newAgentRequest({
          recipe,
          name,
          chatID,
          connections,
          locale: i18n.resolvedLanguage ?? i18n.language,
        }),
      );
      // Recipe rules are created by the server in UTC; they belong to the
      // creator's timezone so «every day at 09:00» means local 09:00.
      if (recipe && timezone !== "UTC") {
        const triggers = await api.agentTriggers(created.id);
        await Promise.all(
          triggersToLocalize(triggers, timezone).map((trigger) =>
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
        recipe
          ? t("agentCreateTitle", { role: recipe.name })
          : t("agentCreateTitleCustom")
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
