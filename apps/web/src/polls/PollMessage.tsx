import { useMemo, useRef, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import {
  pollKeys,
  type ChatMember,
  type Message,
  type MessagePoll,
  type PollViewer,
} from "@comamessenger/core";
import { useMessenger } from "../shell/MessengerContext";
import { PollCard } from "./PollCard";
import { PollVoters } from "./PollVoters";
import { useAnonChoice, usePollActions, usePollViewer } from "./usePoll";

/** Faces next to an option: the first few who chose it. */
const facesPerOption = 3;

/**
 * A poll in a feed or in Waiting for you: the card with the reader's viewer, the
 * actions, the voters' faces and Who voted.
 */
export function PollMessage({
  message,
  members,
  fallback = null,
}: {
  message: Pick<Message, "id" | "chat_id" | "actor_id" | "edited_at"> & {
    poll: MessagePoll;
  };
  members: readonly ChatMember[];
  /** The viewer a list item came with, until the store has one. */
  fallback?: PollViewer | null;
}) {
  const { api, user } = useMessenger();
  const stored = usePollViewer(message, !fallback);
  const viewer = stored ?? fallback;
  const anonChoice = useAnonChoice(message.id, message.poll);
  const fallbackEntry = useMemo(
    () => (fallback ? { poll: message.poll, viewer: fallback } : null),
    [fallback, message.poll],
  );
  const actions = usePollActions(message, fallbackEntry);
  const [votersOpen, setVotersOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const poll = message.poll;
  const counts =
    poll.status === "open" ? viewer?.counts : (poll.final_counts ?? viewer?.counts);
  const showFaces =
    !poll.anonymous &&
    Boolean(viewer?.can_view_voters || poll.status === "closed") &&
    Boolean(counts);
  const faces = useQueries({
    queries: poll.options.map((_, index) => ({
      queryKey: [
        ...pollKeys.voters(user.id, message.id, `option:${index}`),
        "faces",
        poll.version,
        counts?.[index] ?? 0,
      ],
      queryFn: () =>
        api.pollVoters(message.id, {
          filter: `option:${index}`,
          limit: facesPerOption,
        }),
      enabled: showFaces && (counts?.[index] ?? 0) > 0,
      staleTime: 30_000,
    })),
  });
  const optionVoters = useMemo(
    () =>
      Object.fromEntries(
        faces.map((query, index) => [
          index,
          query.data?.items.map((item) => item.actor_id) ?? [],
        ]),
      ),
    // The array is new every render; its data are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [faces.map((query) => query.dataUpdatedAt).join(",")],
  );
  return (
    <>
      <PollCard
        message={message}
        viewer={viewer}
        selfID={user.id}
        actions={actions}
        anonChoice={anonChoice}
        optionVoters={showFaces ? optionVoters : undefined}
        members={members}
        onOpenVoters={() => setVotersOpen((open) => !open)}
        votersAnchor={anchor}
      />
      {votersOpen && (
        <PollVoters
          messageID={message.id}
          poll={poll}
          viewer={viewer}
          members={members}
          actions={actions}
          anchorRef={anchor}
          onClose={() => setVotersOpen(false)}
        />
      )}
    </>
  );
}
