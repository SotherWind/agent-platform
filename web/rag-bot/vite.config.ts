import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const ragBotServer = process.env.RAGBOT_SERVER_URL ?? "http://127.0.0.1:8787";
const port = Number.parseInt(process.env.VITE_PORT ?? "5174", 10);

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    port,
    proxy: {
      "/api": { target: ragBotServer, changeOrigin: true },
      "/login": { target: ragBotServer, changeOrigin: true },
      "/health": { target: ragBotServer, changeOrigin: true },
    },
  },
});
