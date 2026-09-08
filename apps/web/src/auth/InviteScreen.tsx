import { useState, type FormEvent } from "react";
import { Clock3 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { APIError, type AcceptInvitationRequest } from "@comamessenger/core";
import { Button, Field, InlineError, PasswordField } from "../ui";
import { messageOf } from "../errors";
import { formValue } from "../lib/forms";
import { Logo } from "../shell/Logo";
import { AuthLayout } from "./AuthLayout";
import { passwordMinimum, type AuthProps } from "./types";

export function InviteScreen({
  api,
  error,
  onError,
  onAuthenticated,
  token,
  workspaceName,
}: AuthProps & { token: string; workspaceName: string }) {
  const { t } = useTranslation();
  const [pending, setPending] = useState(false);
  const [invalid, setInvalid] = useState(!token);
  const [handle, setHandle] = useState("");
  const [handleTaken, setHandleTaken] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    onError("");
    setHandleTaken(false);
    const data = new FormData(event.currentTarget);
    const input: AcceptInvitationRequest = {
      display_name: formValue(data, "display_name"),
      handle: formValue(data, "handle").toLowerCase(),
      password: formValue(data, "password"),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    };
    try {
      await onAuthenticated(await api.acceptInvitation(token, input));
    } catch (cause) {
      if (cause instanceof APIError && cause.status === 409) setHandleTaken(true);
      else if (
        cause instanceof APIError &&
        (cause.status === 404 || cause.status === 410 || cause.status === 422)
      )
        setInvalid(true);
      else onError(messageOf(cause));
    } finally {
      setPending(false);
    }
  }

  if (invalid)
    return (
      <AuthLayout
        title={t("joinTitle")}
        header={
          <>
            <Logo size="lg" className="auth-card__logo" />
            <h1 id="auth-title" className="auth-card__title">
              {t("joinTitle")}
            </h1>
            <div className="auth-ink-result">
              <span className="auth-ink-result__icon">
                <Clock3 aria-hidden="true" />
              </span>
              <strong>{t("invitationInvalidTitle")}</strong>
              <p>{t("invitationInvalidText")}</p>
            </div>
          </>
        }
      >
        <div className="auth-form__actions">
          <Button variant="primary" size="lg" block onClick={() => window.location.assign("/")}>
            {t("goToLogin")}
          </Button>
        </div>
      </AuthLayout>
    );

  return (
    <AuthLayout title={t("joinTitle")} lead={workspaceName || "Coma"}>
      <form className="auth-form" onSubmit={submit}>
        <Field label={t("displayName")} name="display_name" autoComplete="name" autoFocus disabled={pending} />
        <Field
          label={t("bootstrapHandle")}
          name="handle"
          prefix="@"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          value={handle}
          disabled={pending}
          onChange={(event) => {
            setHandle(event.target.value);
            setHandleTaken(false);
          }}
          error={handleTaken ? t("joinHandleTaken") : undefined}
          hint={t("joinHandleHint", { handle: handle.toLowerCase() || "maxim" })}
        />
        <PasswordField
          label={t("password")}
          name="password"
          autoComplete="new-password"
          minLength={passwordMinimum}
          disabled={pending}
          hint={t("passwordMinimumHint", { minimum: passwordMinimum })}
          showLabel={t("showPassword")}
          hideLabel={t("hidePassword")}
        />
        {error && <InlineError title={error} />}
        <div className="auth-form__actions">
          <Button type="submit" variant="primary" size="lg" block pending={pending}>
            {t("accept")}
          </Button>
        </div>
      </form>
    </AuthLayout>
  );
}
