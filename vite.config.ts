import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";

const { version } = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { version: string };

/**
 * One policy for both targets. The renderer never talks to the network:
 * cloud music and the LLM producer are reached through the desktop main
 * process only, and the web build has neither.
 */
export const CONTENT_SECURITY_POLICY =
  "default-src 'self'; script-src 'self'; worker-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-src 'none'; form-action 'none'";

// `vite build`            → dist/      (loaded by Electron from file://)
// `vite build --mode web` → dist-web/  (static site, e.g. /play/yinxu/ inside an iframe)
export default defineConfig(({ mode }) => {
  const web = mode === "web";
  return {
    plugins: [
      react(),
      {
        name: "production-content-security-policy",
        apply: "build",
        transformIndexHtml() {
          return [
            {
              tag: "meta",
              attrs: {
                "http-equiv": "Content-Security-Policy",
                content: CONTENT_SECURITY_POLICY,
              },
              injectTo: "head-prepend",
            },
          ];
        },
      },
    ],
    base: "./",
    define: {
      __APP_VERSION__: JSON.stringify(version),
      __MUSE_WEB__: JSON.stringify(web),
    },
    build: { outDir: web ? "dist-web" : "dist", target: "es2022" },
    worker: { format: "es" as const },
    server: { port: 5173, strictPort: true },
  };
});
