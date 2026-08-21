import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

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
    },
    preview: { host: "0.0.0.0", port, allowedHosts },
  };
});
