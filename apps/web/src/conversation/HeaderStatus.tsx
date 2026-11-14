import { useEffect, useState, type ReactNode } from "react";
import { chatHeaderStatus, type ConversationStatus } from "@comamessenger/core";
import { cx } from "../ui";

/** Re-render on a slow tick so "5 minutes ago" keeps counting. */
export function useNow(intervalMs = 30_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/**
 * The line under a chat title. Actions get three animated dots, as in
 * Telegram; the dots are decoration, the text itself is announced politely.
 */
export function HeaderStatus({ status }: { status: ConversationStatus }) {
  return (
    <span
      className={cx(
        "conversation-status",
        status.live && "conversation-status--live",
      )}
      data-testid="conversation-status"
      aria-live="polite"
    >
      {status.text}
      {status.animated && (
        <span className="typing-dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
      )}
    </span>
  );
}

/**
 * The status line with its own clock: only this line re-renders every half
 * minute, not the conversation around it.
 */
export function ChatStatusLine({
  input,
  fallback,
}: {
  input: Omit<Parameters<typeof chatHeaderStatus>[0], "now">;
  fallback: ReactNode;
}) {
  const now = useNow();
  const status = chatHeaderStatus({ ...input, now });
  return status.text ? <HeaderStatus status={status} /> : <>{fallback}</>;
}
