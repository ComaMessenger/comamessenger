import { useState, type FormEvent } from "react";
import { UserRound } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  Button,
  Field,
  InkCard,
  InlineError,
  InlineSuccess,
  PasswordField,
} from "../ui";
import { messageOf } from "../errors";
import { formValue } from "../lib/forms";
import { AuthLayout } from "./AuthLayout";
import type { AuthProps } from "./types";

export function LoginScreen({
  api,
  error,
  onError,
  onAuthenticated,
  passwordRecoveryAvailable,
  workspaceName,
}: AuthProps & { passwordRecoveryAvailable: boolean; workspaceName: string }) {
  const { t } = useTranslation();
  const [pending, setPending] = useState(false);
  const [recovery, setRecovery] = useState(false);
  const [recoverySent, setRecoverySent] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [recoveryEmail, setRecoveryEmail] = useState("");
  const [lastForm, setLastForm] = useState<HTMLFormElement | null>(null);
  const lead = workspaceName
    ? t("workspaceLead", { workspace: workspaceName })
    : t("loginLead");
  const networkError = error === t("errorNetwork");
  const invalidCredentials = error === t("errorUnauthorized");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLastForm(event.currentTarget);
    setPending(true);
    onError("");
    const data = new FormData(event.currentTarget);
    try {
      await onAuthenticated(
        await api.login({
          email: formValue(data, "email"),
          password: formValue(data, "password"),
        }),
      );
    } catch (cause) {
      onError(messageOf(cause));
    } finally {
      setPending(false);
    }
  }

  async function recover(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLastForm(event.currentTarget);
    setPending(true);
    onError("");
    const data = new FormData(event.currentTarget);
    try {
      await api.forgotPassword({ email: formValue(data, "email") });
      setRecoverySent(true);
    } catch (cause) {
      onError(messageOf(cause));
    } finally {
      setPending(false);
    }
  }

  function retry() {
    lastForm?.requestSubmit();
  }

  function switchToLogin() {
    onError("");
    setRecovery(false);
    setRecoverySent(false);
  }

  const errorBlock = error ? (
    networkError ? (
      <InlineError
        center
        title={t("noServerConnection")}
        onRetry={retry}
        retryLabel={t("retry")}
      />
    ) : (
      <InlineError
        title={invalidCredentials ? t("loginFailedTitle") : error}
        hint={invalidCredentials ? t("loginFailedHint") : undefined}
      />
    )
  ) : null;

  if (recovery)
    return (
      <AuthLayout title={t("forgotPassword")} lead={passwordRecoveryAvailable ? t("recoveryLead") : undefined}>
        {passwordRecoveryAvailable ? (
          <form className="auth-form" onSubmit={recover}>
            <Field
              label={t("email")}
              name="email"
              type="email"
              autoComplete="email"
              autoFocus
              value={recoveryEmail}
              disabled={pending}
              placeholder="name@company.com"
              onChange={(event) => setRecoveryEmail(event.target.value)}
            />
            {errorBlock}
            {recoverySent && (
              <InlineSuccess title={t("recoverySentTitle")} hint={t("recoverySentHint")} />
            )}
            <div className="auth-form__actions">
              <Button
                type="submit"
                variant={recoverySent ? "secondary" : "primary"}
                size="lg"
                block
                pending={pending}
              >
                {pending
                  ? t("sending")
                  : recoverySent
                    ? t("recoverySendAgain")
                    : t("sendRecoveryLink")}
              </Button>
              <Button variant="ghost" size="md" block disabled={pending} onClick={switchToLogin}>
                {t("backToLoginShort")}
              </Button>
            </div>
          </form>
        ) : (
          <div className="auth-form">
            <InkCard icon={<UserRound aria-hidden="true" />} title={t("recoveryUnavailableTitle")}>
              {t("recoveryUnavailableText")}
            </InkCard>
            <div className="auth-form__actions">
              <Button variant="primary" size="lg" block onClick={switchToLogin}>
                {t("backToLoginShort")}
              </Button>
            </div>
          </div>
        )}
      </AuthLayout>
    );

  return (
    <AuthLayout title={t("signIn")} lead={lead}>
      <form className="auth-form" onSubmit={submit}>
        <Field
          label={t("email")}
          name="email"
          type="email"
          autoComplete="email"
          autoFocus
          value={email}
          disabled={pending}
          className={invalidCredentials ? "auth-field--invalid" : undefined}
          onChange={(event) => setEmail(event.target.value)}
        />
        <PasswordField
          label={t("password")}
          name="password"
          autoComplete="current-password"
          value={password}
          disabled={pending}
          showLabel={t("showPassword")}
          hideLabel={t("hidePassword")}
          className={invalidCredentials ? "auth-field--invalid" : undefined}
          onChange={(event) => setPassword(event.target.value)}
        />
        {errorBlock}
        <div className="auth-form__actions">
          <Button type="submit" variant="primary" size="lg" block pending={pending}>
            {pending ? t("loggingIn") : t("login")}
          </Button>
          <Button
            variant="ghost"
            size="md"
            block
            disabled={pending}
            onClick={() => {
              onError("");
              setRecoveryEmail(email);
              setRecovery(true);
            }}
          >
            {t("forgotPassword")}
          </Button>
        </div>
      </form>
    </AuthLayout>
  );
}
