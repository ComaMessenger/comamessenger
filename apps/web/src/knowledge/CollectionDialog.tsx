import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { AlertTriangle, Hash, Info } from "lucide-react";
import type {
  KnowledgeCollection,
  KnowledgeEmbeddingConnection,
} from "@comamessenger/core";
import {
  Button,
  CheckMark,
  Dialog,
  Field,
  FormError,
  RadioOption,
  SelectField,
  SkeletonRow,
  TextareaField,
  cx,
} from "../ui";
import { messageOf } from "../errors";
import { titleOf } from "../lib/chats";
import { useMessenger } from "../shell/MessengerContext";

type Access = KnowledgeCollection["access"];

export function CollectionDialog({
  collection,
  onClose,
  onSaved,
}: {
  /** Absent when creating a collection. */
  collection?: KnowledgeCollection;
  onClose(): void;
  onSaved(collection: KnowledgeCollection): void;
}) {
  const { t } = useTranslation();
  const { api, user, store } = useMessenger();
  const chatMap = useStore(store, (state) => state.chats);
  const [name, setName] = useState(collection?.name ?? "");
  const [description, setDescription] = useState(collection?.description ?? "");
  const [access, setAccess] = useState<Access>(collection?.access ?? "organization");
  const [chatIDs, setChatIDs] = useState<string[]>(collection?.chat_ids ?? []);
  const [connectionID, setConnectionID] = useState(
    collection?.embedding_connection_id ?? "",
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const connections = useQuery({
    queryKey: ["knowledge", "embedding-connections"],
    queryFn: () => api.knowledgeEmbeddingConnections(),
    staleTime: 30_000,
  });

  const chats = useMemo(() => {
    const known = Object.values(chatMap)
      .filter((chat) => chat.kind !== "direct" && !chat.archived_at)
      .map((chat) => ({ id: chat.id, name: titleOf(chat, [], user.id) }))
      .sort((left, right) => left.name.localeCompare(right.name));
    const knownIDs = new Set(known.map((chat) => chat.id));
    const unknown = (collection?.chat_ids ?? [])
      .filter((id) => !knownIDs.has(id))
      .map((id) => ({ id, name: t("kbChatUnknown") }));
    return [...known, ...unknown];
  }, [chatMap, collection?.chat_ids, t, user.id]);

  const selectedConnection = connections.data?.find(
    (connection) => connection.id === connectionID,
  );
  const connectionChanged =
    Boolean(collection) &&
    (collection?.embedding_connection_id ?? "") !== connectionID;
  const valid =
    name.trim().length > 0 && (access === "organization" || chatIDs.length > 0);

  async function save() {
    if (!valid) {
      setError(access === "chats" && !chatIDs.length ? t("kbChatsRequired") : "");
      return;
    }
    setPending(true);
    setError("");
    try {
      const payload = {
        name: name.trim(),
        description: description.trim(),
        access,
        chat_ids: access === "chats" ? chatIDs : [],
        embedding_connection_id: connectionID || null,
      };
      const saved = collection
        ? await api.updateKnowledgeCollection(collection.id, payload)
        : await api.createKnowledgeCollection(payload);
      onSaved(saved);
    } catch (cause) {
      setError(messageOf(cause));
      setPending(false);
    }
  }

  return (
    <Dialog
      title={collection ? t("kbCollectionDialogEdit") : t("kbCollectionDialogCreate")}
      className="knowledge-dialog"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={pending}>
            {t("cancel")}
          </Button>
          <Button
            variant="primary"
            pending={pending}
            disabled={!valid}
            onClick={() => void save()}
          >
            {collection ? t("kbSave") : t("kbCreate")}
          </Button>
        </>
      }
    >
      <form
        className="knowledge-form"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <Field
          label={t("kbCollectionName")}
          name="collection-name"
          value={name}
          maxLength={120}
          placeholder={t("kbCollectionNamePlaceholder")}
          onChange={(event) => setName(event.target.value)}
          autoFocus
        />
        <TextareaField
          label={t("kbCollectionDescription")}
          name="collection-description"
          value={description}
          maxLength={2000}
          rows={2}
          hint={t("kbCollectionDescriptionHint")}
          onChange={(event) => setDescription(event.target.value)}
        />
        <fieldset className="knowledge-form__group">
          <legend>{t("kbAccessTitle")}</legend>
          <RadioOption
            name="collection-access"
            value="organization"
            checked={access === "organization"}
            onChange={() => setAccess("organization")}
            label={t("kbAccessOrganization")}
            description={t("kbAccessOrganizationHint")}
          />
          <RadioOption
            name="collection-access"
            value="chats"
            checked={access === "chats"}
            onChange={() => setAccess("chats")}
            label={t("kbAccessChatsOption")}
            description={t("kbAccessChatsHint")}
          />
          {access === "chats" && (
            <div
              className="knowledge-chats"
              role="group"
              aria-label={t("kbChatsPick")}
            >
              {chats.length === 0 ? (
                <p className="knowledge-form__note">{t("kbChatsNone")}</p>
              ) : (
                chats.map((chat) => {
                  const checked = chatIDs.includes(chat.id);
                  return (
                    <button
                      key={chat.id}
                      type="button"
                      role="checkbox"
                      aria-checked={checked}
                      className={cx("knowledge-chat", checked && "knowledge-chat--on")}
                      onClick={() =>
                        setChatIDs((current) =>
                          checked
                            ? current.filter((id) => id !== chat.id)
                            : [...current, chat.id],
                        )
                      }
                    >
                      <CheckMark checked={checked} />
                      <Hash aria-hidden="true" />
                      <span className="truncate">{chat.name}</span>
                    </button>
                  );
                })
              )}
            </div>
          )}
        </fieldset>
        <fieldset className="knowledge-form__group">
          <legend>{t("kbEmbeddingTitle")}</legend>
          {connections.isLoading ? (
            <SkeletonRow lines={["70%", "40%"]} />
          ) : (
            <SelectField
              label={t("kbEmbeddingConnection")}
              name="collection-embedding"
              value={connectionID}
              onChange={(event) => setConnectionID(event.target.value)}
            >
              <option value="">{t("kbEmbeddingNone")}</option>
              {(connections.data ?? []).map((connection) => (
                <option key={connection.id} value={connection.id}>
                  {t(
                    connection.data_sharing_approved
                      ? "kbEmbeddingOption"
                      : "kbEmbeddingOptionBlocked",
                    { name: connection.name, model: connection.embedding_model },
                  )}
                </option>
              ))}
            </SelectField>
          )}
          <EmbeddingNotice
            connection={selectedConnection}
            empty={connections.isSuccess && connections.data.length === 0}
          />
          {connectionChanged && (
            <p className="knowledge-form__note">{t("kbEmbeddingReindex")}</p>
          )}
        </fieldset>
        <FormError message={error} />
      </form>
    </Dialog>
  );
}

function EmbeddingNotice({
  connection,
  empty,
}: {
  connection?: KnowledgeEmbeddingConnection;
  empty: boolean;
}) {
  const { t } = useTranslation();
  if (!connection)
    return (
      <p className="knowledge-notice">
        <Info aria-hidden="true" />
        <span>
          {t("kbEmbeddingNoneHint")}
          {empty && ` ${t("kbEmbeddingEmpty")}`}
        </span>
      </p>
    );
  const key = !connection.enabled
    ? "kbEmbeddingDisabled"
    : !connection.data_sharing_approved
      ? "kbEmbeddingNotApproved"
      : "kbEmbeddingWarning";
  return (
    <p className="knowledge-notice knowledge-notice--warning" role="note">
      <AlertTriangle aria-hidden="true" />
      <span>
        {t(key, { name: connection.name, model: connection.embedding_model })}
      </span>
    </p>
  );
}
