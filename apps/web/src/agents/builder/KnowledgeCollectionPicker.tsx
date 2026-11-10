import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type { KnowledgeCollection, MessengerAPI } from "@comamessenger/core";
import {
  BookOpen,
  ChevronDown,
  ExternalLink,
  FileText,
  Plus,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { knowledgePath } from "../../knowledge/routes";
import { collectionsKey, documentsKey } from "../../knowledge/shared";
import { Button, CheckMark, IconButton, Skeleton, cx } from "../../ui";

/*
 * Links to the Knowledge base section open in a new tab: the builder keeps
 * unsaved edits, and the list refreshes when people come back to it.
 */
function KnowledgeLink({
  to,
  label,
  icon = false,
  children,
}: {
  to: string;
  label?: string;
  icon?: boolean;
  children?: ReactNode;
}) {
  return (
    <a
      href={to}
      target="_blank"
      rel="noopener"
      aria-label={label}
      title={label}
      className={cx(
        "ui-button",
        icon
          ? "ui-button--ghost ui-button--icon"
          : "ui-button--ghost ui-button--sm",
      )}
    >
      {children}
    </a>
  );
}

/*
 * Self-contained choice of knowledge collections for one agent. Binding is
 * per collection (the server binds collections to the agent version); the
 * documents are listed so people see what the agent will read.
 */
export function KnowledgeCollectionPicker({
  api,
  selected,
  canManage,
  onChange,
}: {
  api: MessengerAPI;
  selected: string[];
  /** Holders of knowledge.manage are invited to create collections. */
  canManage: boolean;
  onChange(ids: string[]): void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const collections = useQuery({
    queryKey: collectionsKey,
    queryFn: () => api.knowledgeCollections(),
  });
  const empty = collections.isSuccess && collections.data.length === 0;
  const byID = new Map(
    (collections.data ?? []).map((collection) => [collection.id, collection]),
  );
  const toggle = (id: string) =>
    onChange(
      selected.includes(id)
        ? selected.filter((item) => item !== id)
        : [...selected, id],
    );
  return (
    <div className="agent-knowledge">
      {selected.map((id) => {
        const collection = byID.get(id);
        return (
          <div key={id} className="agent-line">
            <span className="agent-line__icon" aria-hidden="true">
              <BookOpen />
            </span>
            <span className="agent-line__text">
              <strong>
                {collection?.name ?? t("agentKnowledgeUnavailable")}
              </strong>
              <small>
                {collection
                  ? collectionMeta(t, collection)
                  : t("agentKnowledgeUnavailableHint")}
              </small>
            </span>
            <span className="agent-line__control">
              {collection && (
                <KnowledgeLink
                  icon
                  to={knowledgePath(id)}
                  label={t("agentKnowledgeOpenCollection", {
                    name: collection.name,
                  })}
                >
                  <ExternalLink />
                </KnowledgeLink>
              )}
              <IconButton
                label={t("agentKnowledgeRemove", {
                  name: collection?.name ?? "",
                })}
                onClick={() => toggle(id)}
              >
                <X />
              </IconButton>
            </span>
          </div>
        );
      })}
      {empty && selected.length === 0 ? (
        <div className="agent-knowledge__empty">
          <p className="agent-muted">
            {canManage
              ? t("agentKnowledgeEmptyCreate")
              : t("agentKnowledgeEmptyReadOnly")}
          </p>
          {canManage && (
            <KnowledgeLink to={knowledgePath()}>
              <Plus />
              {t("agentKnowledgeCreateFirst")}
            </KnowledgeLink>
          )}
        </div>
      ) : (
        <div className="agent-knowledge__actions">
          <Button
            size="sm"
            variant={open ? "secondary" : "ghost"}
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            <Plus />
            {t("agentKnowledgeAdd")}
          </Button>
          <KnowledgeLink to={knowledgePath()}>
            <ExternalLink />
            {t("agentKnowledgeOpenBase")}
          </KnowledgeLink>
        </div>
      )}
      {open && (
        <div
          className="agent-knowledge__list"
          role="group"
          aria-label={t("agentKnowledgeAdd")}
        >
          {collections.isLoading ? (
            <Skeleton />
          ) : collections.isError ? (
            <p className="agent-muted">{t("agentKnowledgeLoadFailed")}</p>
          ) : collections.data?.length ? (
            collections.data.map((collection) => (
              <CollectionOption
                key={collection.id}
                api={api}
                collection={collection}
                checked={selected.includes(collection.id)}
                onToggle={() => toggle(collection.id)}
              />
            ))
          ) : (
            <p className="agent-muted">
              {canManage
                ? t("agentKnowledgeEmptyCreate")
                : t("agentKnowledgeEmptyReadOnly")}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function collectionMeta(
  t: ReturnType<typeof useTranslation>["t"],
  collection: KnowledgeCollection,
) {
  return [
    t("agentKnowledgeDocuments", { count: collection.document_count }),
    collection.access === "chats"
      ? t("agentKnowledgeAccessChats")
      : t("agentKnowledgeAccessAll"),
  ].join(" · ");
}

function CollectionOption({
  api,
  collection,
  checked,
  onToggle,
}: {
  api: MessengerAPI;
  collection: KnowledgeCollection;
  checked: boolean;
  onToggle(): void;
}) {
  const { t, i18n } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const documents = useQuery({
    queryKey: documentsKey(collection.id),
    queryFn: () => api.knowledgeDocuments(collection.id),
    enabled: expanded,
  });
  return (
    <div className={cx("agent-knowledge__option", checked && "is-checked")}>
      <div className="agent-knowledge__row">
        <button
          type="button"
          role="checkbox"
          aria-checked={checked}
          className="agent-knowledge__check"
          onClick={onToggle}
        >
          <CheckMark checked={checked} />
          <span>
            <strong>{collection.name}</strong>
            <small>{collectionMeta(t, collection)}</small>
          </span>
        </button>
        {collection.document_count > 0 && (
          <IconButton
            size="icon-sm"
            label={
              expanded
                ? t("agentKnowledgeHideDocuments")
                : t("agentKnowledgeShowDocuments")
            }
            aria-expanded={expanded}
            onClick={() => setExpanded(!expanded)}
          >
            <ChevronDown className={cx(expanded && "agent-rotated")} />
          </IconButton>
        )}
      </div>
      {expanded && (
        <ul className="agent-knowledge__documents">
          {documents.isLoading && <li>{t("loading")}</li>}
          {(documents.data ?? []).map((document) => (
            <li key={document.id}>
              <FileText aria-hidden="true" />
              <span>{document.title}</span>
              <small>
                {document.status === "ready"
                  ? document.indexed_at
                    ? t("agentKnowledgeIndexed", {
                        date: new Date(document.indexed_at).toLocaleDateString(
                          i18n.language,
                        ),
                      })
                    : t("agentKnowledgeStatus_ready")
                  : t(`agentKnowledgeStatus_${document.status}`)}
              </small>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
