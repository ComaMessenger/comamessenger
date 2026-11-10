import { useRef, useState } from "react";
import { ActivityIndicator, Alert, Pressable, StyleSheet, View } from "react-native";
import { router } from "expo-router";
import {
  BookOpen,
  Check,
  CircleDashed,
  FileText,
  MessageSquareText,
  ShieldCheck,
  X,
} from "lucide-react-native";
import { useTranslation } from "react-i18next";
import {
  APIError,
  actionResponder,
  actionState,
  canPress,
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
  type MessageBlocks as Blocks,
  type MessageSource,
  type MessengerAPI,
} from "@comamessenger/core";
import { radius, spacing } from "@comamessenger/tokens";
import { useTheme } from "@/lib/theme";
import { openAttachment } from "@/files/open";
import { Text } from "@/ui/Text";
import {
  confirmationKey,
  confirmationTone,
  fieldLabels,
  toolPhrases,
} from "./blockCopy";

type Tone = "neutral" | "info" | "success" | "warning" | "danger";

function useToneColors() {
  const theme = useTheme();
  return (tone: Tone) =>
    ({
      neutral: { background: theme.sidebar, foreground: theme.muted },
      info: { background: theme.infoSoft, foreground: theme.info },
      success: { background: theme.successSoft, foreground: theme.successText },
      warning: { background: theme.warningSoft, foreground: theme.warning },
      danger: { background: theme.dangerSoft, foreground: theme.danger },
    })[tone];
}

/** Card, buttons and sources of an agent message on the phone. */
export function MessageBlocks({
  api,
  message,
  blocks,
  members,
  authorName,
  viewer,
  onUpdated,
}: {
  api: MessengerAPI;
  message: Message;
  blocks: Blocks;
  members: ChatMember[];
  authorName: string;
  viewer: ActionViewer;
  onUpdated(message: Message): void;
}) {
  const theme = useTheme();
  const confirmation = isConfirmationCard(blocks);
  const hasCard = Boolean(blocks.card) || (blocks.actions?.length ?? 0) > 0;
  return (
    <View style={styles.blocks}>
      {hasCard && (
        <View
          testID="agent-card"
          style={[
            styles.card,
            { borderColor: theme.border, backgroundColor: theme.surface },
          ]}
        >
          {confirmation ? (
            <ConfirmationContent
              message={message}
              blocks={blocks}
              members={members}
              authorName={authorName}
            />
          ) : (
            blocks.card && <CardContent card={blocks.card} />
          )}
          {(blocks.actions?.length ?? 0) > 0 && (
            <Actions
              api={api}
              message={message}
              blocks={blocks}
              members={members}
              viewer={viewer}
              confirmation={confirmation}
              onUpdated={onUpdated}
            />
          )}
        </View>
      )}
      {(blocks.sources?.length ?? 0) > 0 && (
        <Sources api={api} chatID={message.chat_id} sources={blocks.sources!} />
      )}
    </View>
  );
}

function CardHead({
  title,
  status,
  icon,
}: {
  title: string;
  status?: { label: string; tone: Tone };
  icon?: boolean;
}) {
  const theme = useTheme();
  const colors = useToneColors();
  return (
    <View
      style={[
        styles.head,
        { borderBottomColor: theme.border, backgroundColor: theme.canvas },
      ]}
    >
      <View style={styles.headTitle}>
        {icon && <ShieldCheck size={18} color={theme.warning} />}
        <Text weight="semibold" size={15} style={styles.shrink}>
          {title}
        </Text>
      </View>
      {status && (
        <View
          style={[styles.state, { backgroundColor: colors(status.tone).background }]}
        >
          <Text
            weight="medium"
            size={12}
            style={{ color: colors(status.tone).foreground }}
          >
            {status.label}
          </Text>
        </View>
      )}
    </View>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.field}>
      <Text tone="muted" size={13}>
        {label}
      </Text>
      <Text size={15}>{value}</Text>
    </View>
  );
}

function CardContent({ card }: { card: NonNullable<Blocks["card"]> }) {
  const theme = useTheme();
  return (
    <>
      <CardHead title={card.title} status={card.status} />
      {((card.fields?.length ?? 0) > 0 || (card.items?.length ?? 0) > 0) && (
        <View style={styles.body}>
          {card.fields?.map((field, index) => (
            <Field key={`${field.label}-${index}`} label={field.label} value={field.value} />
          ))}
          {card.items?.map((item, index) => (
            <View key={`${item.text}-${index}`} style={styles.item}>
              {item.state === "done" ? (
                <Check size={18} color={theme.success} />
              ) : item.state === "failed" ? (
                <X size={18} color={theme.danger} />
              ) : (
                <CircleDashed size={18} color={theme.subtle} />
              )}
              <Text
                size={15}
                tone={item.state === "done" ? "muted" : "default"}
                style={styles.shrink}
              >
                {item.text}
              </Text>
            </View>
          ))}
        </View>
      )}
    </>
  );
}

/** Core sends English copy for tool confirmations; the phone rebuilds it. */
function ConfirmationContent({
  message,
  blocks,
  members,
  authorName,
}: {
  message: Message;
  blocks: Blocks;
  members: ChatMember[];
  authorName: string;
}) {
  const { t } = useTranslation();
  const tool = confirmationTool(blocks);
  const status = confirmationStatus(blocks);
  const fields = confirmationFields(blocks);
  const phrase = toolPhrases[tool] ? t(toolPhrases[tool]) : t("acToolGeneric", { tool });
  const nameOf = (actorID: string) =>
    members.find((member) => member.actor_id === actorID)?.display_name ?? t("participant");
  return (
    <>
      <CardHead
        icon
        title={t("acConfirmTitle", { agent: authorName })}
        status={
          status
            ? { label: t(confirmationKey[status]), tone: confirmationTone[status] }
            : blocks.card?.status
        }
      />
      <View style={styles.body}>
        <Text weight="medium" size={15}>
          {t("acConfirmLead", { action: phrase })}
        </Text>
        {fields.length ? (
          fields.map((field) => (
            <Field
              key={field.key}
              label={fieldLabels[field.key] ? t(fieldLabels[field.key]!) : field.key}
              value={
                field.kind === "actor"
                  ? nameOf(field.actorID)
                  : field.kind === "chat"
                    ? field.chatID === message.chat_id
                      ? t("acFieldThisChat")
                      : t("acFieldOtherChat")
                    : field.value
              }
            />
          ))
        ) : (
          <Text tone="muted" size={14}>
            {t("acConfirmHiddenDetails")}
          </Text>
        )}
      </View>
    </>
  );
}

function Actions({
  api,
  message,
  blocks,
  members,
  viewer,
  confirmation,
  onUpdated,
}: {
  api: MessengerAPI;
  message: Message;
  blocks: Blocks;
  members: ChatMember[];
  viewer: ActionViewer;
  confirmation: boolean;
  onUpdated(message: Message): void;
}) {
  const { t, i18n } = useTranslation();
  const theme = useTheme();
  const [local, setLocal] = useState<Record<string, LocalActionState>>({});
  const [error, setError] = useState<string | null>(null);
  const inflight = useRef(new Set<string>());
  const actions = blocks.actions ?? [];
  const states = actions.map((action) => actionState(action, blocks, viewer, local[action.id]));
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
  const time = (value: string) =>
    new Intl.DateTimeFormat(i18n.language, { hour: "2-digit", minute: "2-digit" }).format(
      new Date(value),
    );

  async function press(action: MessageAction) {
    // One request per button at a time; the server replays repeats anyway.
    if (inflight.current.has(action.id)) return;
    inflight.current.add(action.id);
    setError(null);
    setLocal((current) => ({ ...current, [action.id]: { pending: true } }));
    try {
      const result = await api.pressMessageAction(message.id, action.id);
      setLocal((current) => ({ ...current, [action.id]: {} }));
      onUpdated(result.message);
    } catch (cause) {
      const failure = pressFailure(cause instanceof APIError ? cause.code : undefined);
      setLocal((current) => ({ ...current, [action.id]: failure.local }));
      setError(
        failure.kind === "conflict"
          ? t("acActionConflict")
          : failure.kind === "closed"
            ? t("acActionClosedNow")
            : failure.kind === "forbidden"
              ? t("acActionForbidden")
              : t("acActionFailed"),
      );
    } finally {
      inflight.current.delete(action.id);
    }
  }

  const label = (action: MessageAction) =>
    confirmation && action.binding?.decision === "approve"
      ? t("acConfirmApprove")
      : confirmation && action.binding?.decision === "deny"
        ? t("acConfirmDeny")
        : action.label;
  const pressedByMe = states.includes("pressed");
  const allUnavailable = states.every((state) => state === "unavailable");
  const allClosed = states.every((state) => state === "closed");

  return (
    <View style={[styles.actions, { borderTopColor: theme.border }]}>
      <View style={styles.buttons}>
        {actions.map((action, index) =>
          hidden(action) ? null : (
            <ActionButton
              key={action.id}
              action={action}
              state={states[index]!}
              label={label(action)}
              onPress={() => void press(action)}
            />
          ),
        )}
      </View>
      {taken ? (
        <Note icon>
          {t("acActionTakenBy", {
            name:
              members.find((member) => member.actor_id === taken.actorID)?.display_name ??
              t("participant"),
            time: time(taken.respondedAt),
          })}
        </Note>
      ) : pressedByMe ? (
        <Note icon>{t("acActionPressed")}</Note>
      ) : allClosed ? (
        <Note>{t("acActionClosed")}</Note>
      ) : allUnavailable ? (
        <Note>{t("acActionUnavailableHint")}</Note>
      ) : null}
      {error && (
        <Text tone="danger" size={13} accessibilityRole="alert">
          {error}
        </Text>
      )}
    </View>
  );
}

function Note({ children, icon = false }: { children: string; icon?: boolean }) {
  const theme = useTheme();
  return (
    <View style={styles.note}>
      {icon && <Check size={14} color={theme.success} />}
      <Text tone="muted" size={13} style={styles.shrink}>
        {children}
      </Text>
    </View>
  );
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
  const theme = useTheme();
  const pressed = state === "pressed" || state === "taken";
  const enabled = canPress(state);
  const primary = action.style === "primary" && !pressed;
  const background = pressed
    ? theme.successSoft
    : primary
      ? theme.action
      : theme.surface;
  const foreground = pressed
    ? theme.successText
    : primary
      ? theme.onAction
      : action.style === "danger"
        ? theme.danger
        : theme.foreground;
  return (
    <Pressable
      testID={`agent-action-${action.id}`}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={
        state === "unavailable" ? t("acActionUnavailableHint") : undefined
      }
      accessibilityState={{
        disabled: !enabled,
        busy: state === "pending",
        selected: pressed,
      }}
      disabled={!enabled}
      onPress={onPress}
      style={({ pressed: touching }) => [
        styles.button,
        {
          backgroundColor: touching && enabled ? theme.surfaceSelected : background,
          borderColor: pressed ? theme.successBorder : primary ? theme.action : theme.border,
          opacity: enabled || pressed || state === "pending" ? 1 : 0.5,
        },
      ]}
    >
      {state === "pending" ? (
        <ActivityIndicator color={foreground} />
      ) : (
        <>
          {pressed && <Check size={16} color={foreground} />}
          <Text weight="medium" size={15} style={{ color: foreground }}>
            {label}
          </Text>
        </>
      )}
    </Pressable>
  );
}

function Sources({
  api,
  chatID,
  sources,
}: {
  api: MessengerAPI;
  chatID: string;
  sources: MessageSource[];
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  function open(source: MessageSource) {
    if (source.kind === "message" && source.message_id)
      void api
        .messageContext(source.message_id, 1)
        .then((context) => {
          const target = context.messages.find((item) => item.id === source.message_id);
          router.push(`/chat/${target?.chat_id ?? chatID}?message=${source.message_id}`);
        })
        .catch(() => Alert.alert(t("actionFailed")));
    else if (source.kind === "file" && source.file_id)
      void api
        .file(source.file_id)
        .then((file) => openAttachment(api, file))
        .catch(() => Alert.alert(t("actionFailed")));
    // The knowledge base is web-only in this phase: show what the agent cited.
    else if (source.kind === "document")
      Alert.alert(
        source.title || t("acSourceDocument"),
        [source.excerpt, t("acSourceDocumentHint")].filter(Boolean).join("\n\n"),
      );
  }
  return (
    <View style={styles.sources} accessibilityLabel={t("acSources")}>
      {sources.map((source, index) => {
        const Icon =
          source.kind === "message" ? MessageSquareText : source.kind === "file" ? FileText : BookOpen;
        const label =
          source.title ||
          (source.kind === "message"
            ? t("acSourceMessage")
            : source.kind === "file"
              ? t("acSourceFile")
              : t("acSourceDocument"));
        return (
          <Pressable
            testID={`agent-source-${index}`}
            key={`${source.kind}-${source.message_id ?? source.file_id ?? source.document_id ?? index}`}
            accessibilityRole="button"
            accessibilityLabel={label}
            onPress={() => open(source)}
            style={({ pressed }) => [
              styles.source,
              {
                borderColor: theme.border,
                backgroundColor: pressed ? theme.surfaceSelected : theme.surface,
              },
            ]}
          >
            <Icon size={16} color={theme.muted} />
            <Text size={13} numberOfLines={1} style={styles.shrink}>
              {label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  blocks: { gap: spacing[2], marginTop: spacing[1] },
  card: { borderWidth: 1, borderRadius: radius.lg, overflow: "hidden" },
  head: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing[2],
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
    borderBottomWidth: 1,
  },
  headTitle: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing[2],
    flexShrink: 1,
  },
  shrink: { flexShrink: 1 },
  state: {
    borderRadius: radius.full,
    paddingHorizontal: spacing[2],
    paddingVertical: 2,
  },
  body: { gap: spacing[2], padding: spacing[3] },
  field: { gap: 2 },
  item: { flexDirection: "row", alignItems: "flex-start", gap: spacing[2] },
  actions: {
    gap: spacing[2],
    padding: spacing[3],
    borderTopWidth: 1,
  },
  buttons: { flexDirection: "row", flexWrap: "wrap", gap: spacing[2] },
  button: {
    minHeight: 44,
    minWidth: 44,
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[2],
    borderRadius: radius.md,
    borderWidth: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing[1],
  },
  note: { flexDirection: "row", alignItems: "center", gap: spacing[1] },
  sources: { flexDirection: "row", flexWrap: "wrap", gap: spacing[2] },
  source: {
    minHeight: 44,
    maxWidth: "100%",
    flexDirection: "row",
    alignItems: "center",
    gap: spacing[1],
    paddingHorizontal: spacing[3],
    borderRadius: radius.full,
    borderWidth: 1,
  },
});
