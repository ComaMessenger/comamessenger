import { useEffect, useRef, useState } from "react";
import type { TextInput } from "react-native";
import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import { useSession } from "@/session/SessionProvider";
import { isNetworkError, messageOf } from "@/lib/errors";
import { APIError } from "@comamessenger/core";
import { AuthScreen } from "@/ui/AuthScreen";
import { Button } from "@/ui/Button";
import { Notice } from "@/ui/Notice";
import { TextField } from "@/ui/TextField";

export default function LoginScreen() {
  const { t } = useTranslation();
  const { phase, api, branding, authenticated, forgetServer } = useSession();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const passwordInput = useRef<TextInput>(null);
  const inviteToken =
    phase.kind === "signed-out" ? phase.inviteToken : undefined;
  const workspace = branding?.workspace_name ?? "";

  useEffect(() => {
    if (inviteToken) router.push("/invite");
  }, [inviteToken]);

  async function submit() {
    if (!api || !email.trim() || !password) return;
    setPending(true);
    setFailure(null);
    try {
      await authenticated(await api.login({ email: email.trim(), password }));
    } catch (cause) {
      setFailure(cause);
    } finally {
      setPending(false);
    }
  }

  const wrongCredentials =
    failure instanceof APIError && failure.status === 401;
  return (
    <AuthScreen
      title={t("signIn")}
      lead={workspace ? t("workspaceLead", { workspace }) : t("loginLead")}
      markName={workspace || "Coma"}
    >
      <TextField
        testID="login-email"
        label={t("email")}
        placeholder="name@company.com"
        value={email}
        onChangeText={setEmail}
        autoCapitalize="none"
        autoComplete="email"
        keyboardType="email-address"
        textContentType="username"
        returnKeyType="next"
        editable={!pending}
        onSubmitEditing={() => passwordInput.current?.focus()}
      />
      <TextField
        ref={passwordInput}
        testID="login-password"
        label={t("password")}
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        autoComplete="current-password"
        textContentType="password"
        returnKeyType="go"
        editable={!pending}
        onSubmitEditing={() => void submit()}
      />
      {failure !== null &&
        (isNetworkError(failure) ? (
          <Notice
            title={t("noServerConnection")}
            actionLabel={t("retry")}
            onAction={() => void submit()}
          />
        ) : wrongCredentials ? (
          <Notice title={t("loginFailedTitle")} hint={t("loginFailedHint")} />
        ) : (
          <Notice title={messageOf(failure)} />
        ))}
      <Button
        testID="login-submit"
        label={t("signIn")}
        pending={pending}
        disabled={!email.trim() || !password}
        onPress={() => void submit()}
      />
      <Button
        variant="ghost"
        label={t("forgotPassword")}
        onPress={() => router.push("/forgot-password")}
      />
      {phase.kind === "signed-out" && (
        <Button
          variant="ghost"
          label={t("changeServer")}
          onPress={() => void forgetServer()}
        />
      )}
    </AuthScreen>
  );
}
