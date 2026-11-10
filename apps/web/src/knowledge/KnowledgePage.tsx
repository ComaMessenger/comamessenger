import { useState } from "react";
import { BookOpen, Lock, Plus, RefreshCw, Sparkles, Users } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { KnowledgeCollection } from "@comamessenger/core";
import { hasPermission } from "../settings";
import { Button, EmptyState, IconButton, InlineError, SkeletonRow } from "../ui";
import { formatAge } from "../lib/format";
import { useIsMobile, useIsNarrowDesktop } from "../lib/useMediaQuery";
import { useMessenger } from "../shell/MessengerContext";
import { DirectoryList, DirectoryRow, DirectorySplit } from "../directories/DirectoryPage";
import { CollectionDialog } from "./CollectionDialog";
import { CollectionView } from "./CollectionView";
import { DocumentView } from "./DocumentView";
import { knowledgePath, type KnowledgeRoute } from "./routes";
import { accessLabel, collectionsKey } from "./shared";

/**
 * Knowledge base section: collections on the left, the selected collection or
 * document on the right. Phones show one level at a time.
 */
export function KnowledgePage({ route }: { route: KnowledgeRoute }) {
  const { t } = useTranslation();
  const { api, user, navigate } = useMessenger();
  const client = useQueryClient();
  const isMobile = useIsMobile();
  const narrow = useIsNarrowDesktop();
  const canManage = hasPermission(user, "knowledge.manage");
  const [creating, setCreating] = useState(false);
  const query = useQuery({
    queryKey: collectionsKey,
    queryFn: () => api.knowledgeCollections(),
  });
  const collections = query.data ?? [];
  const activeID =
    route.collectionID ?? (!isMobile && !narrow ? collections[0]?.id : undefined);

  const list = (
    <DirectoryList
      className="knowledge-list"
      title={t("knowledgeBase")}
      lead={canManage ? t("kbLead") : t("kbLeadReadOnly")}
      action={
        <>
          <IconButton
            size="icon-sm"
            label={t("kbRefresh")}
            className="directory-list__refresh"
            onClick={() => void query.refetch()}
          >
            <RefreshCw className={query.isFetching ? "ui-spin" : undefined} />
          </IconButton>
          {canManage && (
            <Button size="sm" variant="primary" onClick={() => setCreating(true)}>
              <Plus aria-hidden="true" />
              {t("kbNewCollection")}
            </Button>
          )}
        </>
      }
    >
      {query.isLoading ? (
        <>
          <SkeletonRow lines={["80%", "50%"]} />
          <SkeletonRow lines={["70%", "45%"]} />
        </>
      ) : query.isError ? (
        <InlineError
          center
          title={t("kbLoadFailed")}
          onRetry={() => void query.refetch()}
          retryLabel={t("retry")}
        />
      ) : collections.length === 0 ? (
        <EmptyState
          icon={<BookOpen />}
          title={t("kbEmptyTitle")}
          hint={canManage ? t("kbEmptyManageHint") : t("kbEmptyReadHint")}
          action={
            canManage && (
              <Button variant="primary" onClick={() => setCreating(true)}>
                {t("kbCreateCollection")}
              </Button>
            )
          }
        />
      ) : (
        collections.map((collection) => (
          <CollectionRow
            key={collection.id}
            collection={collection}
            selected={!isMobile && collection.id === activeID}
            onOpen={() => navigate(knowledgePath(collection.id))}
          />
        ))
      )}
    </DirectoryList>
  );

  const dialog = creating && (
    <CollectionDialog
      onClose={() => setCreating(false)}
      onSaved={(created) => {
        setCreating(false);
        client.setQueryData<KnowledgeCollection[]>(collectionsKey, (current) =>
          [...(current ?? []), created].sort((left, right) =>
            left.name.localeCompare(right.name),
          ),
        );
        void client.invalidateQueries({ queryKey: collectionsKey });
        navigate(knowledgePath(created.id));
      }}
    />
  );

  const detail =
    activeID && route.documentID ? (
      <DocumentView
        key={route.documentID}
        collectionID={activeID}
        documentID={route.documentID}
      />
    ) : activeID ? (
      <CollectionView key={activeID} collectionID={activeID} />
    ) : (
      <EmptyState
        className="directory-detail__empty"
        icon={<BookOpen />}
        title={t("kbPickTitle")}
        hint={t("kbPickHint")}
      />
    );

  if (isMobile)
    return (
      <>
        {route.collectionID ? detail : list}
        {dialog}
      </>
    );
  return (
    <>
      <DirectorySplit
        className="knowledge"
        list={list}
        detail={detail}
        detailOpen={Boolean(route.collectionID)}
      />
      {dialog}
    </>
  );
}

function CollectionRow({
  collection,
  selected,
  onOpen,
}: {
  collection: KnowledgeCollection;
  selected: boolean;
  onOpen(): void;
}) {
  const { t } = useTranslation();
  return (
    <DirectoryRow
      className="directory-row--knowledge"
      selected={selected}
      onClick={onOpen}
      leading={
        <span className="knowledge-glyph" aria-hidden="true">
          <BookOpen />
        </span>
      }
      top={
        <>
          <span className="truncate">{collection.name}</span>
          <time dateTime={collection.updated_at}>{formatAge(collection.updated_at)}</time>
        </>
      }
      text={collection.description || undefined}
      meta={
        <>
          <span>{t("kbDocumentCount", { count: collection.document_count })}</span>
          <span className="knowledge-meta-icon" title={accessLabel(t, collection)}>
            {collection.access === "organization" ? <Users aria-hidden="true" /> : <Lock aria-hidden="true" />}
            <span className="truncate">{accessLabel(t, collection)}</span>
          </span>
          {collection.semantic_search && (
            <span className="knowledge-meta-icon" title={t("kbSemanticOn")}>
              <Sparkles aria-label={t("kbSemanticOn")} />
            </span>
          )}
        </>
      }
    />
  );
}
