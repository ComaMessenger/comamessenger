import { useState } from "react";
import { Alert, Pressable, StyleSheet, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { ClipboardPaste } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { maskSecret } from "@comamessenger/core";
import { radius, spacing } from "@comamessenger/tokens";
import { useTheme } from "@/lib/theme";
import { Text } from "@/ui/Text";
import { TextField } from "@/ui/TextField";

/**
 * A key or token: hidden while typed (the eye shows it), pasted from the
 * clipboard with one tap, never suggested, autofilled or spell-checked. The
 * value lives only in the parent's state, which clears it after saving; a
 * paste is confirmed by its masked ends, not the whole secret.
 */
export function SecretField({
  label,
  hint,
  placeholder,
  value,
  onChange,
  testID,
}: {
  label: string;
  hint?: string;
  placeholder?: string;
  value: string;
  onChange(value: string): void;
  testID?: string;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const [pasted, setPasted] = useState("");

  async function paste() {
    const text = (await Clipboard.getStringAsync()).trim();
    if (!text) {
      Alert.alert(t("connPasteEmpty"));
      return;
    }
    onChange(text);
    setPasted(maskSecret(text));
  }

  return (
    <View style={styles.field}>
      <TextField
        testID={testID}
        label={label}
        hint={pasted && value ? t("connPasted", { mask: pasted }) : hint}
        placeholder={placeholder}
        value={value}
        onChangeText={(text) => {
          setPasted("");
          onChange(text);
        }}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="off"
        textContentType="none"
        importantForAutofill="no"
        spellCheck={false}
      />
      <Pressable
        testID={testID ? `${testID}-paste` : undefined}
        accessibilityRole="button"
        accessibilityLabel={t("connPaste")}
        accessibilityHint={t("connPasteHint")}
        hitSlop={8}
        onPress={() => void paste()}
        style={({ pressed }) => [
          styles.paste,
          {
            backgroundColor: pressed
              ? theme.surfaceSelected
              : theme.primarySoft,
          },
        ]}
      >
        <ClipboardPaste size={15} color={theme.primary} />
        <Text size={13.5} weight="medium" tone="primary">
          {t("connPaste")}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  field: { position: "relative" },
  paste: {
    position: "absolute",
    right: 0,
    top: -spacing[1],
    flexDirection: "row",
    alignItems: "center",
    gap: spacing[1],
    paddingHorizontal: spacing[2],
    paddingVertical: spacing[1],
    borderRadius: radius.full,
  },
});
