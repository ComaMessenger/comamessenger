import { Stack } from "expo-router";
import { useTranslation } from "react-i18next";
import { MessengerProvider } from "@/messenger/MessengerProvider";
import { useSession, useSignedIn } from "@/session/SessionProvider";
import { useTheme } from "@/lib/theme";
import { AuthScreen } from "@/ui/AuthScreen";
import { PrivacyCover } from "@/ui/PrivacyCover";
import { Button } from "@/ui/Button";
import { PasswordForm } from "@/settings/PasswordForm";

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

/**
 * The administrator asked for a new password: nothing else opens until it
 * is changed here. Scheduled messages were already stopped by that request.
 */
function PasswordChangeRequired() {
  const { t } = useTranslation();
  const { user } = useSignedIn();
  const { signOut } = useSession();
  return (
    <AuthScreen
      title={t("passwordChangeTitle")}
      lead={t("passwordChangeRequiredLead")}
      markName={user.organization_name}
    >
      <PasswordForm />
      <Button
        variant="ghost"
        label={t("signOut")}
        onPress={() => void signOut()}
      />
    </AuthScreen>
  );
}
