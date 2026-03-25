import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";
import { ErrorBoundary } from "./ErrorBoundary.tsx";

const el = document.getElementById("root");
if (!el) {
  document.body.innerHTML =
    '<p style="font-family:system-ui;padding:2rem;">Missing #root — check index.html.</p>';
} else {
  createRoot(el).render(
    <StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </StrictMode>,
  );
}
