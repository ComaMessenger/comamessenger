import { Component, type ReactNode } from "react";
import { View } from "react-native";
import { spacing } from "@comamessenger/tokens";
import i18n from "@/i18n";
import { Notice } from "@/ui/Notice";

/**
 * Keeps unexpected data in a scheduled record from taking the conversation
 * or the app down: the part shows a short notice (or nothing, when `quiet`)
 * and can be tried again.
 */
export class ScheduledBoundary extends Component<
  { children: ReactNode; quiet?: boolean },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    if (__DEV__) console.warn("scheduled messages view failed", error);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    if (this.props.quiet) return null;
    return (
      <View style={{ padding: spacing[4] }}>
        <Notice
          title={i18n.t("scheduledRenderError")}
          actionLabel={i18n.t("retry")}
          onAction={() => this.setState({ failed: false })}
        />
      </View>
    );
  }
}
