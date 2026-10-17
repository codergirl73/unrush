import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiPort = process.env.WEB_PORT ?? "3000";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/api": { target: `http://localhost:${apiPort}`, changeOrigin: true } },
  },
});
