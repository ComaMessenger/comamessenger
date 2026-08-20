import { useCallback, useEffect, useRef, useState } from "react";
import { messageOf } from "../../errors";

export type AutosavePhase = "idle" | "dirty" | "saving" | "saved" | "error";

export function useAutosave<T>({
  value,
  save,
  fingerprint = (item) => JSON.stringify(item),
  onSaved,
  delay = 650,
}: {
  value: T | null;
  save(value: T): Promise<T>;
  fingerprint?(value: T): string;
  onSaved?(result: T, snapshot: T): void;
  delay?: number;
}) {
  const [phase, setPhase] = useState<AutosavePhase>("idle");
  const [error, setError] = useState("");
  const initialized = useRef(false);
  const committed = useRef("");
  const timer = useRef<number | null>(null);
  const inFlight = useRef(false);
  const latest = useRef(value);
  const saveRef = useRef(save);
  const onSavedRef = useRef(onSaved);
  const fingerprintRef = useRef(fingerprint);
  latest.current = value;
  saveRef.current = save;
  onSavedRef.current = onSaved;
  fingerprintRef.current = fingerprint;
  const signature = value ? fingerprint(value) : null;

  const persist = useCallback(
    async (snapshot: T) => {
      if (inFlight.current) return;
      inFlight.current = true;
      let succeeded = false;
      setPhase("saving");
      setError("");
      try {
        const result = await saveRef.current(snapshot);
        succeeded = true;
        committed.current = fingerprintRef.current(result);
        onSavedRef.current?.(result, snapshot);
        window.setTimeout(() => {
          if (!inFlight.current && timer.current === null) setPhase("saved");
        }, 50);
      } catch (cause) {
        setError(messageOf(cause));
        setPhase("error");
      } finally {
        inFlight.current = false;
        const current = latest.current;
        if (
          succeeded &&
          current &&
          fingerprintRef.current(current) !== committed.current
        ) {
          if (timer.current) window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => {
            timer.current = null;
            void persist(current);
          }, delay);
          setPhase((currentPhase) =>
            currentPhase === "error" ? currentPhase : "dirty",
          );
        }
      }
    },
    [delay],
  );

  useEffect(() => {
    if (!value || signature === null) return;
    const current = signature;
    if (!initialized.current) {
      initialized.current = true;
      committed.current = current;
      return;
    }
    if (current === committed.current) return;
    if (timer.current) window.clearTimeout(timer.current);
    setPhase("dirty");
    timer.current = window.setTimeout(() => {
      timer.current = null;
      void persist(value);
    }, delay);
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = null;
    };
  }, [delay, persist, signature]);

  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = null;
    },
    [],
  );

  return {
    phase,
    error,
    retry: () => {
      if (latest.current) void persist(latest.current);
    },
  };
}
