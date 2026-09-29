import { forwardRef, useState } from "react";
import {
  Pressable,
  StyleSheet,
  TextInput,
  View,
  type TextInputProps,
} from "react-native";
import { Eye, EyeOff } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { spacing } from "@comamessenger/tokens";
import { useTheme } from "@/lib/theme";
import { Text, fonts, maxTextScale } from "./Text";

export const TextField = forwardRef<
  TextInput,
  TextInputProps & { label: string; hint?: string; error?: string }
>(function TextField({ label, hint, error, secureTextEntry, ...props }, ref) {
  const theme = useTheme();
  const { t } = useTranslation();
  const [focused, setFocused] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const borderColor = error
    ? theme.danger
    : focused
      ? theme.primary
      : theme.border;
  const Icon = revealed ? EyeOff : Eye;
  return (
    <View style={styles.field}>
      <Text tone="muted" size={15}>
        {label}
      </Text>
      <View
        style={[
          styles.box,
          { borderColor, backgroundColor: theme.surface },
          focused && { borderWidth: 1.5 },
        ]}
      >
        <TextInput
          maxFontSizeMultiplier={maxTextScale}
          ref={ref}
          accessibilityLabel={label}
          placeholderTextColor={theme.subtle}
          selectionColor={theme.primary}
          secureTextEntry={secureTextEntry && !revealed}
          {...props}
          onFocus={(event) => {
            setFocused(true);
            props.onFocus?.(event);
          }}
          onBlur={(event) => {
            setFocused(false);
            props.onBlur?.(event);
          }}
          style={[styles.input, { color: theme.foreground }]}
        />
        {secureTextEntry && (
          <Pressable
            testID={props.testID ? `${props.testID}-reveal` : undefined}
            accessibilityRole="button"
            accessibilityLabel={
              revealed ? t("hidePassword") : t("showPassword")
            }
            hitSlop={12}
            onPress={() => setRevealed((value) => !value)}
          >
            <Icon size={20} color={theme.subtle} />
          </Pressable>
        )}
      </View>
      {error ? (
        <Text tone="danger" size={14}>
          {error}
        </Text>
      ) : hint ? (
        <Text tone="subtle" size={14}>
          {hint}
        </Text>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  field: { gap: spacing[2] },
  box: {
    minHeight: 52,
    borderRadius: 14,
    borderWidth: 1,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing[4],
    gap: spacing[2],
  },
  input: {
    flex: 1,
    fontFamily: fonts.regular,
    fontSize: 17,
    paddingVertical: spacing[3],
  },
});
