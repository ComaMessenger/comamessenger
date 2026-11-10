import { useState } from "react";
import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import { useSession } from "@/session/SessionProvider";
import { isNetworkError, messageOf } from "@/lib/errors";
import { AuthScreen } from "@/ui/AuthScreen";
import { Button } from "@/ui/Button";
import { Notice } from "@/ui/Notice";
import { TextField } from "@/ui/TextField";

export default function ForgotPasswordScreen() {
  const { t } = useTranslation();
  const { api, branding } = useSession();
  const [email, setEmail] = useState("");
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const available = branding?.password_recovery_available ?? false;
  const markName = branding?.workspace_name || "Coma";

  async function submit() {
    if (!api || !email.trim()) return;
    setPending(true);
    setFailure(null);
    try {
      await api.forgotPassword({ email: email.trim() });
      setSent(true);
    } catch (cause) {
      setFailure(cause);
    } finally {
      setPending(false);
    }
  }

  if (!available)
    return (
      <AuthScreen title={t("forgotPassword")} markName={markName}>
        <Notice
          tone="neutral"
          title={t("recoveryUnavailableTitle")}
          hint={t("recoveryUnavailableText")}
        />
        <Button label={t("backToLoginShort")} onPress={() => router.back()} />
      </AuthScreen>
    );

  return (
    <AuthScreen
      title={t("forgotPassword")}
      lead={t("recoveryLead")}
      markName={markName}
    >
      <TextField
        label={t("email")}
        placeholder="name@company.com"
        value={email}
        onChangeText={setEmail}
        autoCapitalize="none"
        autoComplete="email"
        keyboardType="email-address"
        autoFocus
        editable={!pending}
        onSubmitEditing={() => void submit()}
      />
      {failure !== null && (
        <Notice
          title={
            isNetworkError(failure)
              ? t("noServerConnection")
              : messageOf(failure)
          }
        />
      )}
      {sent && (
        <Notice
          tone="success"
          title={t("recoverySentTitle")}
          hint={t("recoverySentHint")}
        />
      )}
      <Button
        variant={sent ? "secondary" : "primary"}
        label={
          pending
            ? t("sending")
            : sent
              ? t("recoverySendAgain")
              : t("sendRecoveryLink")
        }
        pending={pending}
        disabled={!email.trim()}
        onPress={() => void submit()}
      />
      <Button
        variant="ghost"
        label={t("backToLoginShort")}
        onPress={() => router.back()}
      />
    </AuthScreen>
  );
}
