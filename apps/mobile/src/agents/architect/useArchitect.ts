import { useCallback, useEffect, useRef, useState } from "react";
import {
  architectProblemOf,
  type ArchitectProblem,
  type ArchitectSession,
} from "@comamessenger/core";
import { messageOf } from "@/lib/errors";
import { useSignedIn } from "@/session/SessionProvider";

const problemOf = (cause: unknown): ArchitectProblem =>
  architectProblemOf(cause, messageOf);

/*
 * The conversation lives on the server, as on the web: the screen asks for
 * the person's active session (it survives closing the app), sends messages
 * and shows what comes back. The server answers whole (no streaming yet), so
 * while it thinks the screen shows a waiting bubble; a session reopened in
 * the middle of an answer is polled until the answer is there.
 */
export function useArchitect({
  agentID,
  locale,
  onDraft,
}: {
  agentID: string | null;
  locale: "ru" | "en";
  onDraft(session: ArchitectSession): void;
}) {
  const { api } = useSignedIn();
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
      setSession(
        await api.startArchitectSession({ agent_id: agentID, locale }),
      );
    } catch (cause) {
      setProblem(problemOf(cause));
    } finally {
      setLoading(false);
    }
  }, [api, agentID, locale]);

  useEffect(() => {
    void start();
  }, [start]);

  // An answer started before this screen opened: wait for it.
  const thinking = Boolean(session?.thinking) && !sending;
  const sessionID = session?.id;
  useEffect(() => {
    if (!thinking || !sessionID) return;
    const timer = setInterval(() => {
      void api
        .architectSession(sessionID)
        .then((next) => {
          setSession(next);
          if (!next.thinking) onDraftRef.current(next);
        })
        .catch(() => undefined);
    }, 2500);
    return () => clearInterval(timer);
  }, [api, sessionID, thinking]);

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

  return {
    session,
    problem,
    loading,
    sending,
    thinking,
    send,
    restart,
    retry: start,
  };
}
