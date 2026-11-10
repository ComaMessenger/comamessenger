import { useCallback, useEffect, useRef, useState } from "react";
import {
  APIError,
  type ArchitectSession,
  type MessengerAPI,
} from "@comamessenger/core";
import { messageOf } from "../../errors";

export type ArchitectProblem =
  | { kind: "connection" }
  | { kind: "model" }
  | { kind: "budget" }
  | { kind: "busy" }
  | { kind: "expired" }
  | { kind: "other"; message: string };

function problemOf(cause: unknown): ArchitectProblem {
  if (cause instanceof APIError) {
    switch (cause.code) {
      case "architect_connection_required":
        return { kind: "connection" };
      case "architect_model_error":
        return { kind: "model" };
      case "architect_budget_exceeded":
        return { kind: "budget" };
      case "architect_busy":
        return { kind: "busy" };
      case "architect_session_expired":
        return { kind: "expired" };
    }
  }
  return { kind: "other", message: messageOf(cause) };
}

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
