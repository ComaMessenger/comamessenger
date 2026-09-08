import { useState, type FormEvent } from "react";
import { Check } from "lucide-react";
import { useTranslation } from "react-i18next";
import { APIError, type MessengerAPI } from "@comamessenger/core";
import { Button, InlineError, PasswordField, PasswordMeter } from "../ui";
import { Logo } from "../shell/Logo";
import { messageOf } from "../errors";
import { AuthLayout } from "./AuthLayout";
import { passwordMinimum } from "./types";

export function ResetPasswordScreen({
  api,
  token,
  workspaceName,
  onComplete,
}: {
  api: MessengerAPI;
  token: string;
  workspaceName: string;
  onComplete(): void;
}) {
  const { t } = useTranslation();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [expired, setExpired] = useState(!token);
  const [complete, setComplete] = useState(false);
  const tooShort = password.length < passwordMinimum;
  const mismatch = confirm.length > 0 && confirm !== password;
  const canSubmit = !expired && !pending && !tooShort && confirm === password;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) return;
    setError("");
    setPending(true);
    try {
      await api.resetPassword({ token, new_password: password });
      setComplete(true);
    } catch (cause) {
      if (cause instanceof APIError && cause.status >= 400 && cause.status < 500)
        setExpired(true);
      else setError(messageOf(cause));
    } finally {
      setPending(false);
    }
  }

  if (complete)
    return (
      <AuthLayout
        title={t("resetTitle")}
        header={
          <>
            <AuthLogo />
            <div className="auth-ink-result">
              <span className="auth-ink-result__icon auth-ink-result__icon--success">
                <Check strokeWidth={2.6} aria-hidden="true" />
              </span>
              <h1 id="auth-title">{t("resetDoneTitle")}</h1>
              <p>{t("resetDoneText")}</p>
            </div>
          </>
        }
      >
        <div className="auth-form__actions">
          <Button variant="primary" size="lg" block onClick={onComplete}>
            {t("backToLogin")}
          </Button>
        </div>
      </AuthLayout>
    );

  return (
    <AuthLayout
      title={t("resetTitle")}
      lead={!expired && workspaceName ? t("resetLead", { workspace: workspaceName }) : undefined}
    >
      <form className="auth-form" onSubmit={submit}>
        {expired && (
          <InlineError title={t("resetExpiredTitle")} hint={t("resetExpiredHint")} />
        )}
        <div className={expired ? "auth-form__fields auth-form__fields--muted" : "auth-form__fields"}>
          <div className="auth-form__field">
            <PasswordField
              label={t("newPassword")}
              name="new_password"
              autoComplete="new-password"
              autoFocus={!expired}
              minLength={passwordMinimum}
              value={password}
              disabled={expired || pending}
              showLabel={t("showPassword")}
              hideLabel={t("hidePassword")}
              onChange={(event) => setPassword(event.target.value)}
            />
            {!expired && password.length > 0 && (
              <PasswordMeter
                value={password}
                minimum={passwordMinimum}
                label={t("passwordProgress", { count: password.length, minimum: passwordMinimum })}
                strongLabel={t("passwordStrong")}
              />
            )}
          </div>
          <PasswordField
            label={t("confirmNewPassword")}
            name="confirm_password"
            autoComplete="new-password"
            minLength={passwordMinimum}
            placeholder={t("passwordAgain")}
            value={confirm}
            disabled={expired || pending}
            error={mismatch ? t("passwordsDoNotMatch") : undefined}
            showLabel={t("showPassword")}
            hideLabel={t("hidePassword")}
            onChange={(event) => setConfirm(event.target.value)}
          />
        </div>
        {error && <InlineError title={error} />}
        <div className="auth-form__actions">
          <Button
            type="submit"
            variant="primary"
            size="lg"
            block
            pending={pending}
            disabled={!canSubmit}
            className={!canSubmit ? "ui-button--muted-disabled" : undefined}
          >
            {pending ? t("saving") : t("resetSubmit")}
          </Button>
          {expired && (
            <Button variant="ghost" size="md" block onClick={onComplete}>
              {t("resetRequestNew")}
            </Button>
          )}
        </div>
      </form>
    </AuthLayout>
  );
}

function AuthLogo() {
  return <Logo size="lg" className="auth-card__logo" />;
}
