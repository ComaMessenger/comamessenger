import { useEffect, useState } from "react";
import { getHealth, type ServiceHealth } from "@comamessenger/core";

export function App() {
  const [health, setHealth] = useState<ServiceHealth>({ status: "checking" });

  useEffect(() => {
    const apiURL = import.meta.env.VITE_API_URL ?? "http://localhost:8080";
    getHealth(apiURL).then(setHealth);
  }, []);

  return (
    <main className="shell">
      <section className="card" aria-labelledby="title">
        <span className="eyebrow">Phase 0</span>
        <h1 id="title">ComaMessenger</h1>
        <p>
          Каркас монорепозитория готов. Следующий инкремент — пользователи,
          чаты и каналы.
        </p>
        <div className={`status status--${health.status}`} role="status">
          <span className="status__dot" aria-hidden="true" />
          Backend: {health.status}
        </div>
      </section>
    </main>
  );
}
