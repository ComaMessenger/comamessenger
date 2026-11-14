import { useCallback, useEffect, useRef, useState } from "react";
import {
  architectProblemOf,
  type ArchitectProblem,
  type ArchitectSession,
  type MessengerAPI,
} from "@comamessenger/core";
import { messageOf } from "../../errors";

export type { ArchitectProblem };

const problemOf = (cause: unknown): ArchitectProblem =>
  architectProblemOf(cause, messageOf);

/*
 * The conversation lives on the server: the page asks for the person's active
 * session (it survives a reload), sends messages and shows what comes back.
 * The client never decides what the Architect says.
 */
export function useArchitect({
  api,
  agentID,
  locale,
  onDraft,
}: {
  api: MessengerAPI;
  agentID: string | null;
  locale: "ru" | "en";
  onDraft(session: ArchitectSession): void;
}) {
  const [session, setSession] = useState<ArchitectSession | null>(null);
  const [problem, setProblem] = useState<ArchitectProblem | null>(null);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState<string | null>(null);
  const onDraftRef = useRef(onDraft);
  onDraftRef.current = onDraft;

  const start = useCallback(async () => {
    setLoading(true);
    setProblem(null);
    try {
      const opened = await api.startArchitectSession({
        agent_id: agentID,
        locale,
      });
      setSession(opened);
    } catch (cause) {
      setProblem(problemOf(cause));
    } finally {
      setLoading(false);
    }
  }, [api, agentID, locale]);

  useEffect(() => {
    void start();
  }, [start]);

  async function send(text: string): Promise<boolean> {
    if (!session || sending) return false;
    setSending(text);
    setProblem(null);
    try {
      const next = await api.sendArchitectMessage(session.id, text);
      setSession(next);
      onDraftRef.current(next);
      return true;
    } catch (cause) {
      setProblem(problemOf(cause));
      return false;
    } finally {
      setSending(null);
    }
  }

  async function restart() {
    if (session) {
      try {
        await api.closeArchitectSession(session.id);
      } catch {
        // A closed or expired session is already over.
      }
    }
    setSession(null);
    await start();
  }

  return { session, problem, loading, sending, send, restart, retry: start };
}
