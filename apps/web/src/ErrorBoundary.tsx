import { Component, type ErrorInfo, type ReactNode } from "react";

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
            <span className="eyebrow">Application error</span>
            <h1>Не удалось открыть ComaMessenger</h1>
            <p>Обновите страницу. Если ошибка повторится, обратитесь к администратору.</p>
          </section>
        </main>
      );
    }

    return this.props.children;
  }
}
