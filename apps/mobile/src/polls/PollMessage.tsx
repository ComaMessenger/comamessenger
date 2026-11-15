import { useMemo, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import {
  pollKeys,
  type ChatMember,
  type MessagePoll,
  type PollViewer,
} from "@comamessenger/core";
import { useSignedIn } from "@/session/SessionProvider";
import { useNow } from "@/scheduled/clock";
import { PollCard, type PollCardMessage } from "./PollCard";
import { PollVotersSheet } from "./PollVotersSheet";
import { useAnonChoice, usePollActions, usePollViewer } from "./usePoll";

/** Faces next to an option: the first few who chose it. */
const facesPerOption = 3;

/**
 * A poll in a feed, a thread root or «Ждут вас»: the card with the reader's
 * viewer, the actions, the voters' faces and «Кто голосовал».
 */
export function PollMessage({
  message,
  members = [],
  fallback = null,
  preview = false,
  compact = false,
  onNotice,
}: {
  message: PollCardMessage & { poll: MessagePoll };
  members?: ChatMember[];
  /** The viewer a list item came with, until the store has one. */
  fallback?: PollViewer | null;
  preview?: boolean;
  compact?: boolean;
  onNotice?(text: string): void;
}) {
  const { api, user } = useSignedIn();
  const now = useNow(30_000);
  const stored = usePollViewer(message, !fallback && !preview);
  const viewer = stored ?? fallback;
  const anonChoice = useAnonChoice(message.id, message.poll);
  const fallbackEntry = useMemo(
    () => (fallback ? { poll: message.poll, viewer: fallback } : null),
    [fallback, message.poll],
  );
  const actions = usePollActions(message, onNotice, fallbackEntry);
  const [votersOpen, setVotersOpen] = useState(false);
  const poll = message.poll;
  const counts =
    poll.status === "open"
      ? viewer?.counts
      : (poll.final_counts ?? viewer?.counts);
  const showFaces =
    !preview &&
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
  const facesKey = faces.map((query) => query.dataUpdatedAt).join(",");
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
    [facesKey],
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
        now={now}
        preview={preview}
        compact={compact}
        onOpenVoters={() => setVotersOpen(true)}
      />
      {preview || compact ? null : (
        <PollVotersSheet
          visible={votersOpen}
          messageID={message.id}
          poll={poll}
          viewer={viewer}
          members={members}
          actions={actions}
          onClose={() => setVotersOpen(false)}
        />
      )}
    </>
  );
}
