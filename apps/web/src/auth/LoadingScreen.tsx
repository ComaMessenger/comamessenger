import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Logo } from "../shell/Logo";

const slowThreshold = 8000;

/** Shown while the client resolves bootstrap / session / branding. */
export function LoadingScreen({ slow }: { slow?: boolean }) {
  const { t } = useTranslation();
  const [timedOut, setTimedOut] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setTimedOut(true), slowThreshold);
    return () => window.clearTimeout(timer);
  }, []);
  const showSlow = slow ?? timedOut;
  return (
    <main className="auth-shell auth-loading" aria-busy="true">
      <Logo size="xl" className="auth-loading__logo" />
      <p className="auth-loading__label" role="status">
        <i className="ui-presence ui-presence--pulse" aria-hidden="true" />
        {t("loading")}
      </p>
      {showSlow && <p className="auth-loading__slow">{t("loadingSlow")}</p>}
    </main>
  );
}
