import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { cx } from "../ui";
import { Logo } from "../shell/Logo";

/** Centered auth card outside the messenger shell. */
export function AuthLayout({
  title,
  lead,
  wide = false,
  header,
  children,
}: {
  title: string;
  lead?: ReactNode;
  wide?: boolean;
  /** Custom heading block (bootstrap puts the logo beside the title). */
  header?: ReactNode;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <main className="auth-shell">
      <section
        className={cx("auth-card", wide && "auth-card--wide")}
        aria-labelledby="auth-title"
      >
        {header ?? (
          <>
            <Logo size="lg" className="auth-card__logo" />
            <h1 id="auth-title" className="auth-card__title">
              {title}
            </h1>
            {lead && <p className="auth-card__lead">{lead}</p>}
          </>
        )}
        {children}
      </section>
      <span className="auth-footer">{t("authFooter")}</span>
    </main>
  );
}
