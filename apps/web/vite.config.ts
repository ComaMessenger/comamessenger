import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

function contentSecurityPolicy(apiURL: string, development = false): string {
  const connections = new Set(["'self'", "https:", "wss:"]);
  if (apiURL) {
    try {
      const endpoint = new URL(apiURL);
      connections.add(endpoint.origin);
      const websocket = new URL(endpoint.origin);
      websocket.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
      connections.add(websocket.origin);
    } catch {
      // An invalid endpoint is surfaced by the app health check.
    }
  }
  return [
    "default-src 'self'",
    `script-src 'self'${development ? " 'unsafe-inline'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    "img-src 'self' data: blob:",
    `connect-src ${[...connections].join(" ")}`,
    "worker-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "");
  const allowedHosts = (env.VITE_ALLOWED_HOSTS || "localhost,127.0.0.1")
    .split(",")
    .map((host) => host.trim())
    .filter(Boolean);
  const port = Number(env.PORT || 5173);
  const apiURL = env.VITE_API_URL || "";

  return {
    plugins: [react()],
    server: {
      host: "0.0.0.0",
      port,
      allowedHosts,
      headers: {
        "Content-Security-Policy": contentSecurityPolicy(apiURL, true),
      },
    },
    preview: {
      host: "0.0.0.0",
      port,
      allowedHosts,
      headers: { "Content-Security-Policy": contentSecurityPolicy(apiURL) },
    },
  };
});
