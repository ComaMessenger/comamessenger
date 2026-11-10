import { useTranslation } from "react-i18next";
import { useSession } from "@/session/SessionProvider";
import { displayServer } from "@/lib/server";
import { AuthScreen } from "@/ui/AuthScreen";
import { Button } from "@/ui/Button";

export default function OfflineScreen() {
  const { t } = useTranslation();
  const { phase, branding, retry, forgetServer } = useSession();
  const server = phase.kind === "offline" ? displayServer(phase.server) : "";
  return (
    <AuthScreen
      title={t("offlineTitle")}
      lead={t("offlineText", { server })}
      markName={branding?.workspace_name || "Coma"}
    >
      <Button label={t("retry")} onPress={retry} />
      <Button
        variant="ghost"
        label={t("changeServer")}
        onPress={() => void forgetServer()}
      />
    </AuthScreen>
  );
}
