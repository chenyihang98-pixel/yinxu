import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react(), {
    name: "production-content-security-policy",
    apply: "build",
    transformIndexHtml() {
      return [{tag: "meta", attrs: {"http-equiv": "Content-Security-Policy", content: "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-src 'none'; form-action 'none'"}, injectTo: "head-prepend"}];
    },
  }],
  base: "./",
  server: { port: 5173, strictPort: true },
});
