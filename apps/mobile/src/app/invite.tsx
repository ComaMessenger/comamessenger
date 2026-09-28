import { useState } from "react";
import { router } from "expo-router";
import { getCalendars } from "expo-localization";
import { useTranslation } from "react-i18next";
import { APIError } from "@comamessenger/core";
import { useSession } from "@/session/SessionProvider";
import { messageOf } from "@/lib/errors";
import { AuthScreen } from "@/ui/AuthScreen";
import { Button } from "@/ui/Button";
import { Notice } from "@/ui/Notice";
import { TextField } from "@/ui/TextField";

const passwordMinimum = 10;

export default function InviteScreen() {
  const { t } = useTranslation();
  const { phase, api, branding, authenticated, dismissInvite } = useSession();
  const token = phase.kind === "signed-out" ? phase.inviteToken : undefined;
  const [displayName, setDisplayName] = useState("");
  const [handle, setHandle] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [invalid, setInvalid] = useState(!token);
  const [handleTaken, setHandleTaken] = useState(false);
  const [failure, setFailure] = useState("");
  const workspace = branding?.workspace_name || "Coma";

  function toLogin() {
    dismissInvite();
    if (router.canGoBack()) router.back();
    else router.replace("/login");
  }

  async function submit() {
    if (!api || !token) return;
    setPending(true);
    setFailure("");
    setHandleTaken(false);
    try {
      await authenticated(
        await api.acceptInvitation(token, {
          display_name: displayName.trim(),
          handle: handle.trim().toLowerCase(),
          password,
          timezone: getCalendars()[0]?.timeZone ?? "UTC",
        }),
      );
    } catch (cause) {
      if (cause instanceof APIError && cause.status === 409)
        setHandleTaken(true);
      else if (
        cause instanceof APIError &&
        (cause.status === 404 || cause.status === 410)
      )
        setInvalid(true);
      else setFailure(messageOf(cause));
    } finally {
      setPending(false);
    }
  }

  if (invalid)
    return (
      <AuthScreen title={t("joinTitle")} markName={workspace}>
        <Notice
          title={t("invitationInvalidTitle")}
          hint={t("invitationInvalidText")}
        />
        <Button label={t("goToLogin")} onPress={toLogin} />
      </AuthScreen>
    );

  const ready =
    displayName.trim() && handle.trim() && password.length >= passwordMinimum;
  return (
    <AuthScreen title={t("joinTitle")} lead={workspace} markName={workspace}>
      <TextField
        label={t("displayName")}
        value={displayName}
        onChangeText={setDisplayName}
        autoComplete="name"
        textContentType="name"
        autoFocus
        editable={!pending}
      />
      <TextField
        label={t("handle")}
        value={handle}
        onChangeText={(value) => {
          setHandle(value);
          setHandleTaken(false);
        }}
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="username"
        editable={!pending}
        error={handleTaken ? t("joinHandleTaken") : undefined}
        hint={t("joinHandleHint", {
          handle: handle.trim().toLowerCase() || "maxim",
        })}
      />
      <TextField
        label={t("password")}
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        autoComplete="new-password"
        textContentType="newPassword"
        editable={!pending}
        hint={t("passwordMinimumHint", { minimum: passwordMinimum })}
      />
      {failure ? <Notice title={failure} /> : null}
      <Button
        label={t("accept")}
        pending={pending}
        disabled={!ready}
        onPress={() => void submit()}
      />
      <Button variant="ghost" label={t("goToLogin")} onPress={toLogin} />
    </AuthScreen>
  );
}
