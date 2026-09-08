import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { APIError, type BootstrapRequest } from "@comamessenger/core";
import { Button, Field, InlineError, PasswordField } from "../ui";
import { messageOf } from "../errors";
import { formValue, handlePattern, slugPattern, suggestSlug } from "../lib/forms";
import { Logo } from "../shell/Logo";
import { AuthLayout } from "./AuthLayout";
import { passwordMinimum, type AuthProps } from "./types";

export function BootstrapScreen({ api, error, onError, onAuthenticated }: AuthProps) {
  const { t } = useTranslation();
  const [pending, setPending] = useState(false);
  const [tokenRejected, setTokenRejected] = useState(false);
  const [slug, setSlug] = useState("");
  const [handle, setHandle] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const slugValid = slugPattern.test(slug);
  const slugSuggestion = suggestSlug(slug);
  const handleValid = handlePattern.test(handle);
  const showSlugError = slugTouched && slug.length > 0 && !slugValid;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const nextSlug = formValue(data, "organization_slug").toLowerCase();
    if (!slugPattern.test(nextSlug)) {
      setSlugTouched(true);
      return;
    }
    setPending(true);
    onError("");
    setTokenRejected(false);
    const input: BootstrapRequest = {
      organization_name: formValue(data, "organization_name"),
      organization_slug: nextSlug,
      display_name: formValue(data, "display_name"),
      handle: formValue(data, "handle").toLowerCase(),
      email: formValue(data, "email"),
      password: formValue(data, "password"),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    };
    try {
      await onAuthenticated(await api.bootstrap(input, formValue(data, "bootstrap_token")));
    } catch (cause) {
      if (cause instanceof APIError && (cause.status === 401 || cause.status === 403))
        setTokenRejected(true);
      else onError(messageOf(cause));
    } finally {
      setPending(false);
    }
  }

  return (
    <AuthLayout
      title={t("bootstrapTitle")}
      wide
      header={
        <div className="auth-card__header-row">
          <Logo size="lg" className="auth-card__logo" />
          <div>
            <h1 id="auth-title" className="auth-card__title">
              {t("bootstrapTitle")}
            </h1>
            <p className="auth-card__lead">{t("bootstrapLeadLong")}</p>
          </div>
        </div>
      }
    >
      <form className="auth-form auth-form--bootstrap" onSubmit={submit}>
        <PasswordField
          label={t("bootstrapTokenLabel")}
          name="bootstrap_token"
          optional={t("bootstrapTokenOptional")}
          required={false}
          mono
          autoComplete="off"
          disabled={pending}
          showLabel={t("showPassword")}
          hideLabel={t("hidePassword")}
        />
        <h2 className="auth-section-label">{t("bootstrapSectionOrganization")}</h2>
        <div className="auth-form__grid">
          <Field
            label={t("bootstrapName")}
            name="organization_name"
            autoComplete="organization"
            autoFocus
            disabled={pending}
          />
          <Field
            label={t("bootstrapSlug")}
            name="organization_slug"
            prefix={t("bootstrapSlugPrefix")}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            value={slug}
            disabled={pending}
            onChange={(event) => setSlug(event.target.value)}
            onBlur={() => setSlugTouched(true)}
            error={
              showSlugError ? (
                <span>
                  {t("bootstrapSlugInvalid")}{" "}
                  {slugSuggestion && (
                    <button
                      type="button"
                      className="auth-suggestion"
                      onClick={() => setSlug(slugSuggestion)}
                    >
                      {slugSuggestion}
                    </button>
                  )}
                </span>
              ) : undefined
            }
          />
        </div>
        <h2 className="auth-section-label">{t("bootstrapSectionOwner")}</h2>
        <div className="auth-form__grid">
          <Field label={t("bootstrapOwnerName")} name="display_name" autoComplete="name" disabled={pending} />
          <Field
            label={t("bootstrapHandle")}
            name="handle"
            prefix="@"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            value={handle}
            disabled={pending}
            onChange={(event) => setHandle(event.target.value)}
            success={handleValid ? t("bootstrapHandleHint", { handle: handle.toLowerCase() }) : undefined}
            hint={
              handle.length > 0 && !handleValid
                ? t("bootstrapHandleInvalid")
                : t("bootstrapHandleHint", { handle: handle.toLowerCase() || "lev" })
            }
          />
          <Field label={t("email")} name="email" type="email" autoComplete="email" disabled={pending} />
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
        </div>
        {tokenRejected ? (
          <InlineError title={t("bootstrapTokenRejected")} hint={t("bootstrapTokenRejectedHint")} />
        ) : (
          error && <InlineError title={error} />
        )}
        <div className="auth-form__actions">
          <Button type="submit" variant="primary" size="lg" block pending={pending}>
            {pending ? t("creating") : t("createSpace")}
          </Button>
        </div>
      </form>
    </AuthLayout>
  );
}
