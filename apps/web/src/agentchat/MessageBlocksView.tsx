import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import {
  BookOpen,
  Check,
  CircleDashed,
  FileText,
  MessageSquareText,
  ShieldCheck,
  X,
} from "lucide-react";
import {
  APIError,
  actionResponder,
  actionState,
  canPress,
  compactUUID,
  confirmationFields,
  confirmationStatus,
  confirmationTool,
  isConfirmationCard,
  pressFailure,
  type ActionState,
  type ActionViewer,
  type ChatMember,
  type LocalActionState,
  type Message,
  type MessageAction,
  type MessageBlocks,
  type MessageSource,
} from "@comamessenger/core";
import { Button, cx } from "../ui";
import { formatTime } from "../lib/format";
import { hasPermission } from "../settings";
import { useMessenger } from "../shell/MessengerContext";
import { downloadToDisk } from "../dialogs/useObjectURL";
import { useToast } from "../shell/ToastProvider";
import { knowledgePath } from "../knowledge/routes";
import { documentKey } from "../knowledge/shared";

type Props = {
  message: Message;
  blocks: MessageBlocks;
  members: ChatMember[];
  authorName: string;
  onChanged(value: Message): void;
};

/** Card, buttons and sources of an agent message (blocks schema v1). */
export function MessageBlocksView({
  message,
  blocks,
  members,
  authorName,
  onChanged,
}: Props) {
  const { user } = useMessenger();
  const viewer: ActionViewer = {
    actorID: user.id,
    chatRole: members.find((member) => member.actor_id === user.id)?.role,
    orgRole: user.role,
    hasPermission: (permission) =>
      hasPermission(user, permission as Parameters<typeof hasPermission>[1]),
  };
  const confirmation = isConfirmationCard(blocks);
  return (
    <div className="agent-blocks">
      {confirmation ? (
        <ConfirmationCard
          message={message}
          blocks={blocks}
          members={members}
          authorName={authorName}
          viewer={viewer}
          onChanged={onChanged}
        />
      ) : (
        (blocks.card || (blocks.actions?.length ?? 0) > 0) && (
          <section className="agent-card" aria-label={blocks.card?.title}>
            {blocks.card && <CardContent card={blocks.card} />}
            {(blocks.actions?.length ?? 0) > 0 && (
              <ActionBar
                message={message}
                blocks={blocks}
                members={members}
                viewer={viewer}
                onChanged={onChanged}
              />
            )}
          </section>
        )
      )}
      {(blocks.sources?.length ?? 0) > 0 && (
        <SourceList sources={blocks.sources!} />
      )}
    </div>
  );
}

function CardContent({ card }: { card: NonNullable<MessageBlocks["card"]> }) {
  const { t } = useTranslation();
  return (
    <>
      <header className="agent-card__head">
        <strong className="agent-card__title">{card.title}</strong>
        {card.status && (
          <span className={cx("agent-state", `agent-state--${card.status.tone}`)}>
            {card.status.label}
          </span>
        )}
      </header>
      {((card.fields?.length ?? 0) > 0 || (card.items?.length ?? 0) > 0) && (
        <div className="agent-card__body">
          {(card.fields?.length ?? 0) > 0 && (
            <dl className="agent-card__fields">
              {card.fields!.map((field, index) => (
                <div key={`${field.label}-${index}`} className="agent-card__field">
                  <dt>{field.label}</dt>
                  <dd>{field.value}</dd>
                </div>
              ))}
            </dl>
          )}
          {(card.items?.length ?? 0) > 0 && (
            <ul className="agent-card__items">
              {card.items!.map((item, index) => (
                <li
                  key={`${item.text}-${index}`}
                  className={cx("agent-card__item", item.state && `agent-card__item--${item.state}`)}
                >
                  <span className="agent-card__item-mark" aria-hidden="true">
                    {item.state === "done" ? <Check /> : item.state === "failed" ? <X /> : <CircleDashed />}
                  </span>
                  <span>{item.text}</span>
                  {item.state && (
                    <span className="visually-hidden">
                      {item.state === "done"
                        ? t("acItemDone")
                        : item.state === "failed"
                          ? t("acItemFailed")
                          : t("acItemPending")}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </>
  );
}

/**
 * Sends one press per action at a time. The server replays repeats, so a
 * double click never creates a second answer; the message comes back in the
 * response and again through message.updated.
 */
function usePress(message: Message, onChanged: (value: Message) => void) {
  const { api } = useMessenger();
  const [local, setLocal] = useState<Record<string, LocalActionState>>({});
  const [error, setError] = useState<{ actionID: string; kind: string } | null>(null);
  const inflight = useRef(new Set<string>());
  async function press(action: MessageAction) {
    if (inflight.current.has(action.id)) return;
    inflight.current.add(action.id);
    setError(null);
    setLocal((current) => ({ ...current, [action.id]: { pending: true } }));
    try {
      const result = await api.pressMessageAction(message.id, action.id);
      setLocal((current) => ({ ...current, [action.id]: {} }));
      onChanged(result.message);
    } catch (cause) {
      const failure = pressFailure(cause instanceof APIError ? cause.code : undefined);
      setLocal((current) => ({ ...current, [action.id]: failure.local }));
      setError({ actionID: action.id, kind: failure.kind });
    } finally {
      inflight.current.delete(action.id);
    }
  }
  return { local, error, press };
}

function ActionBar({
  message,
  blocks,
  members,
  viewer,
  onChanged,
  labelOf,
}: {
  message: Message;
  blocks: MessageBlocks;
  members: ChatMember[];
  viewer: ActionViewer;
  onChanged(value: Message): void;
  labelOf?(action: MessageAction): string;
}) {
  const { t } = useTranslation();
  const { local, error, press } = usePress(message, onChanged);
  const actions = blocks.actions ?? [];
  const states = actions.map((action) => actionState(action, blocks, viewer, local[action.id]));
  const nameOf = (actorID: string) =>
    members.find((member) => member.actor_id === actorID)?.display_name ?? t("participant");
  // A decided single-use action shows who took it instead of dead buttons:
  // the taken button stays, its closed siblings in the group disappear.
  const decided = actions.find(
    (action) => action.limit === "single" && action.closed && action.responses.length > 0,
  );
  const taken = decided ? actionResponder(decided, blocks) : null;
  const hidden = (action: MessageAction) =>
    Boolean(
      decided &&
        action !== decided &&
        action.responses.length === 0 &&
        (action.closed || (decided.group !== undefined && action.group === decided.group)),
    );
  const allUnavailable = states.every((state) => state === "unavailable");
  const notes = noteFor(states, actions, t);

  return (
    <footer className="agent-card__actions">
      <div className="agent-card__buttons">
        {actions.map((action, index) => {
          const state = states[index]!;
          if (hidden(action)) return null;
          return (
            <ActionButton
              key={action.id}
              action={action}
              state={state}
              label={labelOf?.(action) ?? action.label}
              onPress={() => void press(action)}
            />
          );
        })}
      </div>
      {taken && (
        <span className="agent-card__note">
          <Check aria-hidden="true" />
          {t("acActionTakenBy", { name: nameOf(taken.actorID), time: formatTime(taken.respondedAt) })}
        </span>
      )}
      {!taken && notes && <span className="agent-card__note">{notes}</span>}
      {allUnavailable && !taken && (
        <span className="agent-card__note agent-card__note--muted">{t("acActionUnavailableHint")}</span>
      )}
      {error && (
        <span className="agent-card__note agent-card__note--danger" role="alert">
          {error.kind === "conflict"
            ? t("acActionConflict")
            : error.kind === "closed"
              ? t("acActionClosedNow")
              : error.kind === "forbidden"
                ? t("acActionForbidden")
                : t("acActionFailed")}
        </span>
      )}
    </footer>
  );
}

function noteFor(
  states: ActionState[],
  actions: MessageAction[],
  t: (key: string, values?: Record<string, unknown>) => string,
): string | null {
  if (states.includes("pressed")) {
    const shared = actions.find(
      (action, index) => states[index] === "pressed" && action.limit === "per_actor",
    );
    return shared && shared.responses.length > 1
      ? `${t("acActionPressed")} · ${t("acRespondedCount", { count: shared.responses.length })}`
      : t("acActionPressed");
  }
  if (states.length > 0 && states.every((state) => state === "closed")) return t("acActionClosed");
  return null;
}

function ActionButton({
  action,
  state,
  label,
  onPress,
}: {
  action: MessageAction;
  state: ActionState;
  label: string;
  onPress(): void;
}) {
  const { t } = useTranslation();
  const pressed = state === "pressed";
  const variant =
    pressed || state === "taken"
      ? "secondary"
      : action.style === "primary"
        ? "primary"
        : action.style === "danger"
          ? "danger-ghost"
          : "secondary";
  const hint =
    state === "unavailable"
      ? t("acActionUnavailable")
      : state === "chosen_other"
        ? t("acActionChosenOther")
        : state === "closed"
          ? t("acActionClosed")
          : undefined;
  return (
    <Button
      size="sm"
      variant={variant}
      className={cx("agent-action", `agent-action--${state}`)}
      pending={state === "pending"}
      disabled={!canPress(state) && state !== "pending"}
      aria-pressed={pressed || state === "chosen_other" ? pressed : undefined}
      title={hint}
      data-state={state}
      onClick={() => {
        if (canPress(state)) onPress();
      }}
    >
      {(pressed || state === "taken") && <Check aria-hidden="true" />}
      {label}
    </Button>
  );
}

const toolPhrases: Record<string, string> = {
  post_message: "acToolPostMessage",
  reply_in_thread: "acToolReplyInThread",
  send_direct_message: "acToolSendDirect",
  add_reaction: "acToolAddReaction",
  remember: "acToolRemember",
  post_card: "acToolPostCard",
  update_card: "acToolUpdateCard",
  start_collection: "acToolStartCollection",
  schedule_followup: "acToolScheduleFollowup",
};

const fieldLabels: Record<string, string> = {
  actor_id: "acFieldTo",
  chat_id: "acFieldChat",
  body: "acFieldText",
  text: "acFieldText",
  emoji: "acFieldReaction",
};

const statusTone = {
  pending: "warning",
  approved: "success",
  done: "success",
  failed: "danger",
  denied: "danger",
  expired: "neutral",
} as const;

const statusKey = {
  pending: "acConfirmPending",
  approved: "acConfirmApproved",
  done: "acConfirmDone",
  failed: "acConfirmFailed",
  denied: "acConfirmDenied",
  expired: "acConfirmExpired",
} as const;

/**
 * Core posts tool confirmations with English server copy (tool name as the
 * title, "Approval required", "Approve"/"Deny"). The client rebuilds the card
 * from the binding so it reads as a human request in the viewer's language.
 */
function ConfirmationCard({
  message,
  blocks,
  members,
  authorName,
  viewer,
  onChanged,
}: Omit<Props, "blocks"> & { blocks: MessageBlocks; viewer: ActionViewer }) {
  const { t } = useTranslation();
  const tool = confirmationTool(blocks);
  const status = confirmationStatus(blocks);
  const fields = confirmationFields(blocks);
  const phrase = toolPhrases[tool] ? t(toolPhrases[tool]) : t("acToolGeneric", { tool });
  const nameOf = (actorID: string) =>
    members.find((member) => member.actor_id === actorID)?.display_name ?? t("participant");
  return (
    <section className="agent-card agent-card--confirmation" aria-label={t("acConfirmTitle", { agent: authorName })}>
      <header className="agent-card__head">
        <span className="agent-card__title agent-card__title--icon">
          <ShieldCheck aria-hidden="true" />
          <strong>{t("acConfirmTitle", { agent: authorName })}</strong>
        </span>
        {status ? (
          <span className={cx("agent-state", `agent-state--${statusTone[status]}`)}>{t(statusKey[status])}</span>
        ) : (
          blocks.card?.status && (
            <span className={cx("agent-state", `agent-state--${blocks.card.status.tone}`)}>
              {blocks.card.status.label}
            </span>
          )
        )}
      </header>
      <div className="agent-card__body">
        <p className="agent-card__lead">{t("acConfirmLead", { action: phrase })}</p>
        {fields.length > 0 ? (
          <dl className="agent-card__fields">
            {fields.map((field) => (
              <div key={field.key} className="agent-card__field">
                <dt>{fieldLabels[field.key] ? t(fieldLabels[field.key]!) : field.key}</dt>
                <dd>
                  {field.kind === "actor"
                    ? nameOf(field.actorID)
                    : field.kind === "chat"
                      ? field.chatID === message.chat_id
                        ? t("acFieldThisChat")
                        : t("acFieldOtherChat")
                      : field.value}
                </dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="agent-card__muted">{t("acConfirmHiddenDetails")}</p>
        )}
      </div>
      <ActionBar
        message={message}
        blocks={blocks}
        members={members}
        viewer={viewer}
        onChanged={onChanged}
        labelOf={(action) =>
          action.binding?.decision === "approve"
            ? t("acConfirmApprove")
            : action.binding?.decision === "deny"
              ? t("acConfirmDeny")
              : action.label
        }
      />
    </section>
  );
}

function SourceList({ sources }: { sources: MessageSource[] }) {
  const { t } = useTranslation();
  const { api, navigate } = useMessenger();
  const { toast } = useToast();
  const client = useQueryClient();
  const [opening, setOpening] = useState("");
  // A cited document opens on its knowledge base page with the quoted
  // fragment in focus; the server decides whether the reader may see it.
  async function openDocument(source: MessageSource) {
    const documentID = source.document_id!;
    setOpening(documentID);
    try {
      const document = await api.knowledgeDocument(documentID);
      client.setQueryData(documentKey(documentID), document);
      // The exact fragment first; its position and the quote are fallbacks
      // for documents indexed again and for messages written before.
      navigate(
        knowledgePath(document.collection_id, document.id, {
          fragment: source.chunk_id,
          position: source.position,
          quote: source.excerpt,
        }),
      );
    } catch {
      toast({ message: t("acDocumentFailed"), tone: "danger" });
    } finally {
      setOpening("");
    }
  }
  return (
    <div className="agent-sources" role="list" aria-label={t("acSources")}>
      {sources.map((source, index) => {
        const label =
          source.title ||
          (source.kind === "message"
            ? t("acSourceMessage")
            : source.kind === "file"
              ? t("acSourceFile")
              : t("acSourceDocument"));
        const Icon = source.kind === "message" ? MessageSquareText : source.kind === "file" ? FileText : BookOpen;
        const open = () => {
          if (source.kind === "message" && source.message_id)
            navigate(`/m/${compactUUID(source.message_id)}`);
          else if (source.kind === "file" && source.file_id)
            void downloadToDisk(api, source.file_id, source.title || "file").catch(() => undefined);
          else if (source.kind === "document" && source.document_id) void openDocument(source);
        };
        const target = source.message_id ?? source.file_id ?? source.document_id;
        return (
          <span role="listitem" key={`${source.kind}-${target ?? index}`}>
            <button
              type="button"
              className="agent-source"
              disabled={!target || opening === target}
              aria-busy={opening === target || undefined}
              title={source.excerpt || label}
              onClick={open}
            >
              <Icon aria-hidden="true" />
              <span className="truncate">{label}</span>
            </button>
          </span>
        );
      })}
    </div>
  );
}
