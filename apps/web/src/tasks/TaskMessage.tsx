import { useMemo } from "react";
import type { ChatMember, Message, MessageTask } from "@comamessenger/core";
import { useMessenger } from "../shell/MessengerContext";
import { TaskCard } from "./TaskCard";
import { useTaskViewer } from "./format";
import { useTaskActions } from "./useTasks";

/** A task message in a feed: the card with the reader's rights and actions. */
export function TaskMessage({
  message,
  members,
  onThread,
  onJump,
}: {
  message: Pick<Message, "id" | "chat_id" | "actor_id" | "created_at"> & {
    task: MessageTask;
  };
  members: ChatMember[];
  onThread?(): void;
  onJump?(messageID: string): void;
}) {
  const { navigate } = useMessenger();
  const viewer = useTaskViewer(message.chat_id, members);
  const actions = useTaskActions(message);
  const memberIDs = useMemo(
    () =>
      members.length
        ? new Set(members.map((member) => member.actor_id))
        : undefined,
    [members],
  );
  return (
    <TaskCard
      message={message}
      members={members}
      viewer={viewer}
      actions={actions}
      memberIDs={memberIDs}
      onOpen={() => navigate(`/chat/${message.chat_id}/tasks/${message.id}`)}
      onThread={onThread}
      onSource={onJump}
    />
  );
}
