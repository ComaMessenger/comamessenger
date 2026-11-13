import { Component, type ErrorInfo, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { AlertCircle } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { useTheme } from "@/lib/theme";
import { Text } from "./Text";

type Props = {
  children: ReactNode;
  /** What the row stands for, for the placeholder text. */
  kind: "message" | "chat";
  /** A new value (e.g. the message version) tries rendering again. */
  resetKey?: unknown;
  testID?: string;
};

type State = { failed: boolean; resetKey: unknown };

/**
 * Keeps one broken row from taking the list (and the app) down: a row that
 * throws while rendering is replaced by a placeholder, the rest of the list
 * keeps working. The error is still reported in development.
 */
export class RowBoundary extends Component<Props, State> {
  state: State = { failed: false, resetKey: this.props.resetKey };

  static getDerivedStateFromError(): Partial<State> {
    return { failed: true };
  }

  static getDerivedStateFromProps(
    props: Props,
    state: State,
  ): Partial<State> | null {
    return props.resetKey !== state.resetKey
      ? { failed: false, resetKey: props.resetKey }
      : null;
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(
      `[RowBoundary:${this.props.kind}]`,
      error,
      info.componentStack,
    );
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return <RowFallback kind={this.props.kind} testID={this.props.testID} />;
  }
}

function RowFallback({
  kind,
  testID,
}: {
  kind: Props["kind"];
  testID?: string;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  return (
    <View
      testID={testID ?? "row-render-failed"}
      accessible
      accessibilityRole="text"
      style={styles.row}
    >
      <AlertCircle size={16} color={theme.muted} />
      <Text tone="muted" size={14}>
        {kind === "chat" ? t("chatRenderFailed") : t("messageRenderFailed")}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
});
