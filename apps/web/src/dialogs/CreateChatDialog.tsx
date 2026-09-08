import { useState } from "react";
import { Lock, LockOpen, Megaphone, Users } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ActorSummary, Chat } from "@comamessenger/core";
import { Button, Dialog, Field, InlineError, Switch, cx } from "../ui";
import { messageOf } from "../errors";
import { useMessenger } from "../shell/MessengerContext";
import { ActorPicker } from "./ActorPicker";

type Kind = "group" | "channel";

export function CreateChatDialog({
  onClose,
  onCreated,
}: {
  onClose(): void;
  onCreated(chat: Chat): void;
}) {
  const { t } = useTranslation();
  const { api } = useMessenger();
  const [kind, setKind] = useState<Kind>("group");
  const [name, setName] = useState("");
  const [topic, setTopic] = useState("");
  const [members, setMembers] = useState<ActorSummary[]>([]);
  const [restricted, setRestricted] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const isChannel = kind === "channel";
  const publicChat = !restricted;
  async function submit() {
    if (!name.trim() || pending) return;
    setPending(true);
    setError("");
    try {
      onCreated(
        await api.createChat({
          kind,
          visibility: publicChat ? "public" : "private",
          name: name.trim(),
          topic: topic.trim(),
          member_ids: members.map((actor) => actor.actor_id),
        }),
      );
    } catch (cause) {
      setError(messageOf(cause));
      setPending(false);
    }
  }
  const types: Array<{ id: Kind; label: string; hint: string; icon: typeof Users }> = [
    { id: "group", label: t("group"), hint: t("chatTypeGroupHint"), icon: Users },
    { id: "channel", label: t("channel"), hint: t("chatTypeChannelHint"), icon: Megaphone },
  ];
  return (
    <Dialog
      title={t("newChatTitle")}
      onClose={onClose}
      className="create-chat"
      footer={
        <>
          <Button onClick={onClose} disabled={pending}>
            {t("cancel")}
          </Button>
          <Button variant="primary" pending={pending} disabled={!name.trim()} onClick={() => void submit()}>
            {pending ? t("creating") : isChannel ? t("createChannel") : t("createGroup")}
          </Button>
        </>
      }
    >
      <form
        className="create-chat__form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="create-chat__types" role="radiogroup" aria-label={t("kind")}>
          {types.map((type) => {
            const Icon = type.icon;
            const checked = kind === type.id;
            return (
              <button
                key={type.id}
                type="button"
                role="radio"
                aria-checked={checked}
                className={cx("create-chat__type", checked && "create-chat__type--active")}
                onClick={() => setKind(type.id)}
              >
                <span className="create-chat__type-icon">
                  <Icon aria-hidden="true" />
                </span>
                <span>
                  <strong>{type.label}</strong>
                  <small>{type.hint}</small>
                </span>
              </button>
            );
          })}
        </div>
        <Field
          label={t("title")}
          name="name"
          compact
          value={name}
          autoFocus
          maxLength={80}
          onChange={(event) => setName(event.target.value)}
        />
        <Field
          label={t("topic")}
          name="topic"
          compact
          required={false}
          optional={t("optional")}
          value={topic}
          placeholder={t("chatTopicPlaceholder")}
          onChange={(event) => setTopic(event.target.value)}
        />
        <ActorPicker
          label={t("participants")}
          placeholder={t("chatMembersPlaceholder")}
          selected={members}
          onChange={setMembers}
        />
        <div className="create-chat__visibility">
          <span className={cx("create-chat__lock", publicChat && "create-chat__lock--open")} aria-hidden="true">
            {publicChat ? <LockOpen /> : <Lock />}
          </span>
          <span className="create-chat__visibility-copy">
            <strong>
              {isChannel
                ? publicChat
                  ? t("openChannel")
                  : t("privateChannel")
                : t("privateGroup")}
            </strong>
            <small>
              {isChannel
                ? publicChat
                  ? t("openChannelHint")
                  : t("privateChannelHint")
                : t("privateGroupHint")}
            </small>
          </span>
          <Switch
            checked={isChannel ? publicChat : restricted}
            label={t("visibility")}
            onChange={(value) => setRestricted(isChannel ? !value : value)}
          />
        </div>
        {error && <InlineError title={error} />}
        <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
      </form>
    </Dialog>
  );
}
