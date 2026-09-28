import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useSession } from "@/session/SessionProvider";
import { parseServerInput } from "@/lib/server";
import { AuthScreen } from "@/ui/AuthScreen";
import { Button } from "@/ui/Button";
import { Notice } from "@/ui/Notice";
import { TextField } from "@/ui/TextField";

export default function ServerScreen() {
  const { t } = useTranslation();
  const { connect } = useSession();
  const [address, setAddress] = useState("");
  const [invalid, setInvalid] = useState(false);
  const [unreachable, setUnreachable] = useState(false);
  const [pending, setPending] = useState(false);

  async function submit() {
    const target = parseServerInput(address);
    setInvalid(!target);
    setUnreachable(false);
    if (!target) return;
    setPending(true);
    try {
      await connect(target);
    } catch {
      setUnreachable(true);
    } finally {
      setPending(false);
    }
  }

  return (
    <AuthScreen title={t("serverTitle")} lead={t("serverLead")} markName="Coma">
      <TextField
        testID="server-address"
        label={t("serverAddress")}
        placeholder={t("serverPlaceholder")}
        value={address}
        onChangeText={(value) => {
          setAddress(value);
          setInvalid(false);
        }}
        error={invalid ? t("serverInvalid") : undefined}
        autoCapitalize="none"
        autoCorrect={false}
        autoFocus
        keyboardType="url"
        textContentType="URL"
        returnKeyType="go"
        editable={!pending}
        onSubmitEditing={() => void submit()}
      />
      {unreachable && <Notice title={t("serverUnreachable")} />}
      <Button
        testID="server-continue"
        label={t("continue")}
        pending={pending}
        disabled={!address.trim()}
        onPress={() => void submit()}
      />
    </AuthScreen>
  );
}
