import { useEffect, useRef, useState } from "react";
import {
  runAgentCheck,
  type Agent,
  type AgentRun,
  type MessengerAPI,
} from "@comamessenger/core";
import { messageOf } from "../../errors";

/*
 * One dry run of the current draft. Polling stops when the run finishes, when
 * another check starts and when the panel unmounts (leaving the page or
 * switching to another agent). The polling itself lives in Core.
 */
export function useAgentCheck(api: MessengerAPI, agent: Agent) {
  const [run, setRun] = useState<AgentRun | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const controller = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      controller.current?.abort();
    },
    [],
  );

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
