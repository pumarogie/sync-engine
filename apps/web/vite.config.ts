import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  // PowerSync ships its own workers + wa-sqlite WASM; pre-bundling breaks their URL resolution.
  optimizeDeps: { exclude: ["@powersync/web", "@journeyapps/wa-sqlite"] },
  worker: { format: "es" },
  build: {
    target: "es2022",
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          if (/[\\/](prosemirror-[^\\/]+|orderedmap|rope-sequence|w3c-keyname)[\\/]/.test(id)) return "prosemirror";
          if (/[\\/](@tiptap|linkifyjs|markdown-it)[\\/]/.test(id)) return "tiptap";
          if (/[\\/](yjs|lib0|y-[^\\/]+|@hocuspocus)[\\/]/.test(id)) return "yjs";
          if (/[\\/]@powersync[\\/]/.test(id)) return "powersync";
          if (/[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return "react";
        },
      },
    },
  },
  server: {
    port: Number(process.env.WEB_PORT ?? 5180),
    strictPort: true,
    proxy: { "/api": process.env.API_URL ?? "http://localhost:4000" },
  },
});
