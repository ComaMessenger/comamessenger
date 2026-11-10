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
import { radius, spacing } from "@comamessenger/tokens";
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
      : theme.borderStrong;
  const Icon = revealed ? EyeOff : Eye;
  return (
    <View style={styles.field}>
      <Text weight="medium" size={14}>
        {label}
      </Text>
      <View
        style={[styles.box, { borderColor, backgroundColor: theme.surface }]}
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
          style={[
            styles.input,
            { color: theme.foreground },
            props.multiline && styles.multiline,
          ]}
        />
        {secureTextEntry && (
          <Pressable
            testID={props.testID ? `${props.testID}-reveal` : undefined}
            accessibilityRole="button"
            accessibilityLabel={
              revealed ? t("hidePassword") : t("showPassword")
            }
            style={styles.reveal}
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
    minHeight: 48,
    borderRadius: radius.md,
    borderWidth: 1,
    flexDirection: "row",
    alignItems: "center",
    paddingLeft: spacing[3],
    paddingRight: spacing[1],
  },
  input: {
    flex: 1,
    fontFamily: fonts.regular,
    fontSize: 16,
    paddingVertical: spacing[3],
    minHeight: 46,
    paddingRight: spacing[2],
  },
  multiline: { minHeight: 104, textAlignVertical: "top" },
  reveal: {
    width: 44,
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
  },
});
