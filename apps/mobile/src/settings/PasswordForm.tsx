import { useState } from "react";
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import {
  fieldErrorKey,
  passwordChangeError,
  passwordMinLength,
} from "@comamessenger/core";
import { useSession, useSignedIn } from "@/session/SessionProvider";
import { messageOf } from "@/lib/errors";
import { Button } from "@/ui/Button";
import { Notice } from "@/ui/Notice";
import { TextField } from "@/ui/TextField";

/**
 * Current password, the new one twice. Other sessions end on success; this
 * one stays. `guard` lets the caller confirm first (scheduled messages).
 */
export function PasswordForm({
  guard = (run) => run(),
  onChanged,
}: {
  guard?: (run: () => void) => void;
  onChanged?(): void;
}) {
  const { t } = useTranslation();
  const { api } = useSignedIn();
  const { updateUser } = useSession();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(
    null,
  );
  const problem = passwordChangeError({ current, next, confirm });

  async function submit() {
    setPending(true);
    setResult(null);
    try {
      await api.changePassword({
        current_password: current,
        new_password: next,
      });
      setCurrent("");
      setNext("");
      setConfirm("");
      setResult({ ok: true, text: t("passwordChanged") });
      updateUser(await api.me());
      onChanged?.();
    } catch (cause) {
      setResult({ ok: false, text: messageOf(cause) });
    } finally {
      setPending(false);
    }
  }

  return (
    <View style={{ gap: 16 }}>
      <TextField
        testID="password-current"
        label={t("currentPassword")}
        value={current}
        onChangeText={setCurrent}
        secureTextEntry
        autoComplete="current-password"
        textContentType="password"
        autoCapitalize="none"
      />
      <TextField
        testID="password-new"
        label={t("newPassword")}
        value={next}
        onChangeText={setNext}
        secureTextEntry
        autoComplete="new-password"
        textContentType="newPassword"
        autoCapitalize="none"
        hint={t("passwordMinHint", { count: passwordMinLength })}
        error={
          next && next.length < passwordMinLength
            ? t(fieldErrorKey("passwordTooShort"), { count: passwordMinLength })
            : undefined
        }
      />
      <TextField
        testID="password-confirm"
        label={t("confirmNewPassword")}
        value={confirm}
        onChangeText={setConfirm}
        secureTextEntry
        autoComplete="new-password"
        textContentType="newPassword"
        autoCapitalize="none"
        error={
          confirm && problem === "passwordsDoNotMatch"
            ? t("passwordsDoNotMatch")
            : confirm && problem === "passwordUnchanged"
              ? t(fieldErrorKey("passwordUnchanged"))
              : undefined
        }
      />
      {result && (
        <Notice tone={result.ok ? "success" : "danger"} title={result.text} />
      )}
      <Button
        testID="password-submit"
        label={t("changePassword")}
        pending={pending}
        disabled={problem !== null}
        onPress={() => guard(() => void submit())}
      />
    </View>
  );
}
