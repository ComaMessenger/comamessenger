import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AlertCircle, Check } from "lucide-react";
import { Toast } from "../ui";

export type ToastInput = {
  message: string;
  tone?: "neutral" | "danger";
  action?: { label: string; onClick(): void };
  duration?: number;
};

type ToastItem = ToastInput & { id: number };

type ToastContextValue = {
  toast(input: ToastInput): void;
};

const ToastContext = createContext<ToastContextValue>({ toast: () => undefined });

export function useToast() {
  return useContext(ToastContext);
}

/** Dark confirmation / error toasts for user actions (pin, forward, copy…). */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const counter = useRef(0);
  const dismiss = useCallback((id: number) => {
    setItems((current) => current.filter((item) => item.id !== id));
  }, []);
  const toast = useCallback(
    (input: ToastInput) => {
      const id = (counter.current += 1);
      setItems((current) => [...current.slice(-2), { ...input, id }]);
      window.setTimeout(() => dismiss(id), input.duration ?? 4500);
    },
    [dismiss],
  );
  const value = useMemo(() => ({ toast }), [toast]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      {items.length > 0 && (
        <div className="toast-stack" role="region" aria-live="polite">
          {items.map((item) => (
            <Toast
              key={item.id}
              ink
              tone={item.tone === "danger" ? "danger" : "neutral"}
              icon={
                item.tone === "danger" ? (
                  <AlertCircle aria-hidden="true" />
                ) : (
                  <Check aria-hidden="true" />
                )
              }
              action={
                item.action && (
                  <button
                    type="button"
                    className="ui-toast__action"
                    onClick={() => {
                      dismiss(item.id);
                      item.action?.onClick();
                    }}
                  >
                    {item.action.label}
                  </button>
                )
              }
            >
              {item.message}
            </Toast>
          ))}
        </div>
      )}
    </ToastContext.Provider>
  );
}
