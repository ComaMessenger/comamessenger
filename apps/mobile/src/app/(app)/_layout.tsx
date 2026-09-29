import { Stack } from "expo-router";
import { useTranslation } from "react-i18next";
import { MessengerProvider } from "@/messenger/MessengerProvider";
import { useSession, useSignedIn } from "@/session/SessionProvider";
import { useTheme } from "@/lib/theme";
import { openWebClient } from "@/lib/web";
import { AuthScreen } from "@/ui/AuthScreen";
import { PrivacyCover } from "@/ui/PrivacyCover";
import { Button } from "@/ui/Button";

export default function AppLayout() {
  const { user, api } = useSignedIn();
  const theme = useTheme();
  if (user.must_change_password) return <PasswordChangeRequired />;
  return (
    <MessengerProvider key={`${api.apiURL}:${user.id}`}>
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: theme.canvas },
        }}
      />
      <PrivacyCover />
    </MessengerProvider>
  );
}

// Changing a password needs the full security settings, which live on the web.
function PasswordChangeRequired() {
  const { t } = useTranslation();
  const { api, user } = useSignedIn();
  const { updateUser, signOut } = useSession();
  return (
    <AuthScreen
      title={t("passwordChangeTitle")}
      lead={t("passwordChangeText")}
      markName={user.organization_name}
    >
      <Button
        label={t("openWeb")}
        onPress={() => void openWebClient(api.apiURL, "/settings/security")}
      />
      <Button
        variant="secondary"
        label={t("checkAgain")}
        onPress={() =>
          void api
            .me()
            .then(updateUser)
            .catch(() => undefined)
        }
      />
      <Button
        variant="ghost"
        label={t("signOut")}
        onPress={() => void signOut()}
      />
    </AuthScreen>
  );
}
