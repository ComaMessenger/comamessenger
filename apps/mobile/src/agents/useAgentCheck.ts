import { useEffect, useRef, useState } from "react";
import { runAgentCheck, type Agent, type AgentRun } from "@comamessenger/core";
import { messageOf } from "@/lib/errors";
import { useSignedIn } from "@/session/SessionProvider";

/*
 * One dry run of the agent draft (the loop is Core's `runAgentCheck`, as on
 * the web). Polling stops when the run finishes, another check starts or the
 * screen closes. Used by the check screen of the agent card, the builder's
 * last step and the Architect.
 */
export function useAgentCheck(agent: Pick<Agent, "id">) {
  const { api } = useSignedIn();
  const [run, setRun] = useState<AgentRun | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);

  async function start(chatID: string, prompt: string) {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    setPending(true);
    setError("");
    setRun(null);
    try {
      await runAgentCheck({
        api,
        agentID: agent.id,
        chatID,
        prompt,
        signal: current.signal,
        onUpdate: setRun,
      });
    } catch (cause) {
      if (!current.signal.aborted) setError(messageOf(cause));
    } finally {
      if (controller.current === current) {
        controller.current = null;
        setPending(false);
      }
    }
  }

  function stop() {
    controller.current?.abort();
    controller.current = null;
    setPending(false);
  }

  return { run, error, pending, start, stop };
}
