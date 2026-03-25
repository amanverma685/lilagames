import { Component, type ErrorInfo, type ReactNode } from "react";

type Props = { children: ReactNode };
type State = { error: Error | null };

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("App crashed:", error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.error) {
      const msg = this.state.error.message;
      return (
        <div
          style={{
            boxSizing: "border-box",
            padding: "clamp(1.25rem, 4vw, 2rem)",
            minHeight: "100dvh",
            fontFamily: 'system-ui, "Segoe UI", sans-serif',
            background: "#0b0d10",
            color: "#e8ecf4",
            lineHeight: 1.5,
          }}
        >
          <h1 style={{ margin: "0 0 0.75rem", fontSize: "1.25rem" }}>This page failed to load</h1>
          <pre
            style={{
              margin: "0 0 1rem",
              padding: "0.75rem 1rem",
              background: "#1a1f26",
              borderRadius: "8px",
              overflow: "auto",
              fontSize: "0.85rem",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {msg}
          </pre>
          <p style={{ margin: "0 0 0.75rem", color: "#9aa5b5", fontSize: "0.9rem" }}>
            Open DevTools → <strong>Console</strong> for the full stack trace. On <strong>Network</strong>, confirm{" "}
            <code style={{ color: "#7dffb3" }}>/assets/*.js</code> returns <strong>200</strong> (not 404). If the main
            script 404s, the static host is probably serving the wrong folder — publish the Vite output directory{" "}
            <code style={{ color: "#7dffb3" }}>dist</code>, not the repo root.
          </p>
          <button
            type="button"
            style={{
              padding: "0.5rem 1rem",
              borderRadius: "8px",
              border: "1px solid #3ad4c1",
              background: "#3ad4c1",
              color: "#0b0d10",
              fontWeight: 700,
              cursor: "pointer",
            }}
            onClick={() => window.location.reload()}
          >
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
