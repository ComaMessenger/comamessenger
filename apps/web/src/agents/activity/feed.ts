import type {
  AgentRun,
  AgentToolConfirmation,
  Chat,
} from "@comamessenger/core";
import {
  agentRunErrorText,
  chatName,
  toolLabel,
  type Translate,
} from "../shared/format";

const knownTriggers = new Set([
  "mention",
  "command",
  "keyword",
  "every_message",
  "schedule",
  "event",
  "message_action",
  "collection",
  "followup",
]);

export function runTrigger(run: AgentRun): string {
  if (run.dry_run || run.input.sandbox === true) return "check";
  const type =
    typeof run.input.trigger_type === "string" ? run.input.trigger_type : "";
  if (knownTriggers.has(type)) return type;
  if (run.scheduled_for) return "schedule";
  return "manual";
}

/** «answered a mention in “Hall 1”», «could not finish: …». */
export function runSentence(
  t: Translate,
  run: AgentRun,
  chats: Chat[],
): string {
  const chat = chats.find((item) => item.id === run.chat_id);
  const where = chat ? chatName(chat) : "";
  const trigger = runTrigger(run);
  if (run.status === "queued" || run.status === "running")
    return where
      ? t("agentFeedWorkingIn", { chat: where })
      : t("agentFeedWorking");
  if (run.status === "canceled") return t("agentFeedCanceled");
  if (run.status === "failed" || run.status === "timed_out")
    return t("agentFeedFailed", {
      reason:
        run.status === "timed_out"
          ? t("agentRunError_run_timeout")
          : agentRunErrorText(t, run.error_code),
    });
  return where
    ? t(`agentFeedDone_${trigger}`, { chat: where })
    : t(`agentFeedDoneNoChat_${trigger}`);
}

function excerpt(value: unknown, length = 160) {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

/**
 * What a pending tool call would do, in words. Arguments are summarized only
 * for the tools the client understands; the raw request stays in details.
 */
export function approvalText(
  t: Translate,
  confirmation: AgentToolConfirmation,
  chats: Chat[],
): { action: string; quote: string } {
  const args = confirmation.arguments as Record<string, unknown>;
  const chat = chats.find((item) => item.id === args.chat_id);
  const where = chat ? chatName(chat) : "";
  switch (confirmation.tool_name) {
    case "post_message":
      return {
        action: where
          ? t("agentApprovalPostIn", { chat: where })
          : t("agentApprovalPost"),
        quote: excerpt(args.body),
      };
    case "reply_in_thread":
      return {
        action: where
          ? t("agentApprovalReplyIn", { chat: where })
          : t("agentApprovalReply"),
        quote: excerpt(args.body),
      };
    case "send_direct_message":
      return { action: t("agentApprovalDirect"), quote: excerpt(args.body) };
    case "add_reaction":
      return {
        action: t("agentApprovalReaction", { emoji: excerpt(args.emoji, 16) }),
        quote: "",
      };
    case "remember":
      return {
        action: t("agentApprovalRemember", { key: excerpt(args.key, 80) }),
        quote: "",
      };
    default:
      return { action: toolLabel(t, confirmation.tool_name), quote: "" };
  }
}
