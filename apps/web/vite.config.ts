import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "");
  const allowedHosts = (env.VITE_ALLOWED_HOSTS || "localhost,127.0.0.1")
    .split(",")
    .map((host) => host.trim())
    .filter(Boolean);

  return {
    plugins: [react()],
    server: {
      host: "0.0.0.0",
      port: 5173,
      allowedHosts,
    },
  };
});
