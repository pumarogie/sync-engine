import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  // PowerSync ships its own workers + wa-sqlite WASM; pre-bundling breaks their URL resolution.
  optimizeDeps: { exclude: ["@powersync/web", "@journeyapps/wa-sqlite"] },
  worker: { format: "es" },
  build: { target: "es2022" },
  server: {
    port: 5173,
    proxy: { "/api": process.env.API_URL ?? "http://localhost:4000" },
  },
});
