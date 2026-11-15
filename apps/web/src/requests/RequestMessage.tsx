import type { Message } from "@comamessenger/core";
import { useMessenger } from "../shell/MessengerContext";
import { RequestCard } from "./RequestCard";
import { useRequestActions, useRequestViewer } from "./useRequest";

/** A request message in a feed: the card with the reader's viewer and actions. */
export function RequestMessage({
  message,
  onOpenAnswers,
}: {
  message: Pick<
    Message,
    "id" | "chat_id" | "actor_id" | "edited_at" | "request" | "body"
  >;
  onOpenAnswers?(): void;
}) {
  const { user } = useMessenger();
  const viewer = useRequestViewer(message);
  const actions = useRequestActions(message.id, message.chat_id);
  return (
    <RequestCard
      message={message}
      viewer={viewer}
      selfID={user.id}
      actions={actions}
      onOpenAnswers={onOpenAnswers}
    />
  );
}
