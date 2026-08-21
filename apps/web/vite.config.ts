import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

const contentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self' data: blob:",
  "connect-src 'self' https: wss:",
  "worker-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "");
  const allowedHosts = (env.VITE_ALLOWED_HOSTS || "localhost,127.0.0.1")
    .split(",")
    .map((host) => host.trim())
    .filter(Boolean);
  const port = Number(env.PORT || 5173);

  return {
    plugins: [react()],
    server: {
      host: "0.0.0.0",
      port,
      allowedHosts,
      headers: { "Content-Security-Policy": contentSecurityPolicy },
    },
    preview: {
      host: "0.0.0.0",
      port,
      allowedHosts,
      headers: { "Content-Security-Policy": contentSecurityPolicy },
    },
  };
});
