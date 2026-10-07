import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The website: a landing page at `/` and the real app at `/demo`, running on an
// in-memory sample vault. The desktop build (`vite.config.ts`) is untouched;
// this config swaps the three Tauri modules the frontend imports for browser
// shims, so the same components run with no Rust behind them.
const here = (path: string) => decodeURIComponent(new URL(path, import.meta.url).pathname);

export default defineConfig({
  root: here("web"),
  publicDir: here("web/public"),
  plugins: [react()],
  resolve: {
    alias: [
      { find: /^@tauri-apps\/api\/core$/, replacement: here("src/web/shims/tauri-core.ts") },
      { find: /^@tauri-apps\/api\/event$/, replacement: here("src/web/shims/tauri-event.ts") },
      {
        find: /^@tauri-apps\/plugin-clipboard-manager$/,
        replacement: here("src/web/shims/clipboard.ts"),
      },
    ],
  },
  server: { port: 1430, fs: { allow: [here(".")] } },
  build: {
    outDir: here("dist-web"),
    emptyOutDir: true,
    target: "es2020",
    sourcemap: false,
    rollupOptions: {
      input: {
        site: here("web/index.html"),
        demo: here("web/demo/index.html"),
      },
    },
  },
});
