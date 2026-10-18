import { dirname, normalize, resolve } from "node:path";
import { defineConfig, type IndexHtmlTransformContext } from "vite";
import react from "@vitejs/plugin-react";

// The website: a landing page at `/`, the real app at `/demo` on an in-memory
// sample vault, and at `/app` on the visitor's own vault, encrypted in their
// browser. The desktop build (`vite.config.ts`) is untouched;
// this config swaps the three Tauri modules the frontend imports for browser
// shims, so the same components run with no Rust behind them.
const here = (path: string) => decodeURIComponent(new URL(path, import.meta.url).pathname);

// The HTML pages live under web/ and import modules from ../src, which is
// outside the Vite root. The production build resolves that. In dev the
// browser would request /src/... and miss. Point those tags at /@fs so the
// dev server serves the real file. Build is left alone.
function devOutsideScripts() {
  return {
    name: "dev-outside-scripts",
    transformIndexHtml: {
      order: "pre" as const,
      handler(html: string, ctx: IndexHtmlTransformContext) {
        if (!ctx.server || !ctx.filename) return html;
        const dir = dirname(ctx.filename);
        return html.replace(/(\s(?:src|href)=")(\.\.[^"]+)(")/g, (full, open, rel, close) => {
          if (!/\.(tsx?|css)$/.test(rel)) return full;
          return `${open}/@fs${normalize(resolve(dir, rel))}${close}`;
        });
      },
    },
  };
}

export default defineConfig({
  root: here("web"),
  publicDir: here("web/public"),
  plugins: [devOutsideScripts(), react()],
  // Lets the shared UI drop what only the desktop app can do (Smart Paste).
  define: { "import.meta.env.VITE_DEVLEDGER_WEB": JSON.stringify("1") },
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
        app: here("web/app/index.html"),
        trust: here("web/trust/index.html"),
      },
    },
  },
});
