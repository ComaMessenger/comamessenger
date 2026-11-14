import { useState } from "react";
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { validEmail } from "@comamessenger/core";
import { messageOf } from "@/lib/errors";
import { useSession, useSignedIn } from "@/session/SessionProvider";
import { Button } from "@/ui/Button";
import { Notice } from "@/ui/Notice";
import { GroupBody, InfoRow, SettingsGroup } from "@/ui/Settings";
import { TextField } from "@/ui/TextField";
import { PasswordForm } from "./PasswordForm";
import { ScheduledWarning, useScheduledGuard } from "./ScheduledWarning";
import { SettingsScreen } from "./SettingsScreen";

/** «Сменить пароль», warning about scheduled messages that will stop. */
export function PasswordScreen() {
  const { t } = useTranslation();
  const scheduled = useScheduledGuard();
  return (
    <SettingsScreen
      title={t("changePassword")}
      testID="settings-password-screen"
    >
      <SettingsGroup hint={t("changePasswordHint")}>
        <GroupBody>
          <PasswordForm
            guard={(run) => scheduled.guard("password", run)}
            onChanged={scheduled.refetch}
          />
        </GroupBody>
      </SettingsGroup>
      <ScheduledWarning count={scheduled.count} />
    </SettingsScreen>
  );
}

/**
 * «Сменить почту». With mail delivery the server sends a confirmation link
 * to the new address; without it the address changes at once.
 */
export function EmailScreen() {
  const { t } = useTranslation();
  const { api, user } = useSignedIn();
  const { updateUser } = useSession();
  const scheduled = useScheduledGuard();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(
    null,
  );
  const emailInvalid = email.length > 0 && !validEmail(email);
  const same = email.trim().toLowerCase() === user.email.toLowerCase();

  async function submit() {
    setPending(true);
    setResult(null);
    try {
      const response = await api.changeEmail({
        new_email: email.trim(),
        current_password: password,
      });
      setEmail("");
      setPassword("");
      if (response.user) {
        updateUser(response.user);
        setResult({ ok: true, text: t("emailChanged") });
      } else setResult({ ok: true, text: t("emailConfirmationSent") });
      scheduled.refetch();
    } catch (cause) {
      setResult({ ok: false, text: messageOf(cause) });
    } finally {
      setPending(false);
    }
  }

  return (
    <SettingsScreen title={t("changeEmail")} testID="settings-email-screen">
      <SettingsGroup>
        <InfoRow
          testID="email-current"
          label={t("currentEmail")}
          value={user.email}
        />
      </SettingsGroup>
      <SettingsGroup hint={t("changeEmailHint")}>
        <GroupBody>
          <TextField
            testID="email-new"
            label={t("newEmail")}
            value={email}
            onChangeText={setEmail}
            keyboardType="email-address"
            autoComplete="email"
            autoCapitalize="none"
            autoCorrect={false}
            error={
              emailInvalid
                ? t("fieldEmail")
                : email && same
                  ? t("emailSame")
                  : undefined
            }
          />
          <TextField
            testID="email-password"
            label={t("currentPassword")}
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            autoComplete="current-password"
            textContentType="password"
            autoCapitalize="none"
          />
          {result && (
            <Notice
              tone={result.ok ? "success" : "danger"}
              title={result.text}
            />
          )}
          <View>
            <Button
              testID="email-submit"
              label={t("changeEmail")}
              pending={pending}
              disabled={!email || emailInvalid || same || !password}
              onPress={() => scheduled.guard("email", () => void submit())}
            />
          </View>
        </GroupBody>
      </SettingsGroup>
      <ScheduledWarning count={scheduled.count} />
    </SettingsScreen>
  );
}
