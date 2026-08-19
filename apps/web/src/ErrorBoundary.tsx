import { Component, type ErrorInfo, type ReactNode } from "react";
import i18n from "./i18n";

type Props = {
  children: ReactNode;
};

type State = {
  failed: boolean;
};

export class ErrorBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Web application crashed", error, info);
  }

  render() {
    if (this.state.failed) {
      return (
        <main className="shell">
          <section className="card" role="alert">
            <span className="eyebrow">{i18n.t("applicationError")}</span>
            <h1>{i18n.t("errorTitle")}</h1>
            <p>{i18n.t("errorHelp")}</p>
          </section>
        </main>
      );
    }

    return this.props.children;
  }
}
