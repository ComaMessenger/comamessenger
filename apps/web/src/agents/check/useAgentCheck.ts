import { useEffect, useRef, useState } from "react";
import type { Agent, AgentRun, MessengerAPI } from "@comamessenger/core";
import { messageOf } from "../../errors";

const finished = (run: AgentRun) =>
  !["queued", "running"].includes(run.status);

function wait(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        window.clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

/*
 * One dry run of the current draft. Polling stops when the run finishes, when
 * another check starts and when the panel unmounts (leaving the page or
 * switching to another agent).
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
      let state = await api.invokeAgent(agent.id, {
        chat_id: chatID,
        client_run_id: crypto.randomUUID(),
        chain_depth: 0,
        timeout_seconds: 600,
        max_attempts: 1,
        dry_run: true,
        input: { prompt, sandbox: true, publish: false },
      });
      if (current.signal.aborted) return;
      setRun(state);
      for (let attempt = 0; attempt < 180 && !finished(state); attempt++) {
        await wait(attempt < 10 ? 1_000 : 2_000, current.signal);
        state = await api.agentRun(state.id);
        if (current.signal.aborted) return;
        setRun(state);
      }
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
