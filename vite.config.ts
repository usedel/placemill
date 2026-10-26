import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async () => ({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1421,
    strictPort: false,
    host: host || false,
    hmr: host
      ? { protocol: "ws", host, port: 1421 }
      : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    // R-36: React, antd and their rc-* dependencies used to land in the single
    // entry chunk, so every panel change invalidated ~1 MB of vendor code and
    // each launch re-parsed it. Three stable chunks let WebView2 keep the
    // vendor bytes across releases; the entry keeps only our own code.
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (!id.includes("node_modules")) return undefined;
          if (
            id.includes("/react/") ||
            id.includes("/react-dom/") ||
            id.includes("/scheduler/")
          ) {
            return "react";
          }
          // antd, its rc-* internals, dayjs and @ant-design/icons stay together
          // on purpose: they import each other, and splitting them produced
          // "Circular chunk: antd → icons → antd" (Rollup then keeps the shared
          // part in both). One vendor chunk with no cycle is the better deal.
          if (
            id.includes("/antd/") ||
            id.includes("/@ant-design/") ||
            id.includes("/rc-") ||
            id.includes("/dayjs/")
          ) {
            return "antd";
          }
          return undefined;
        },
      },
    },
    // The antd chunk is ~270 kB gzipped no matter how it is cut; the default
    // 500 kB limit is about a single *applicable* chunk and this one is a
    // dependency bundle the browser caches across releases. Our own code now
    // ships ~145 kB, which is what the limit was meant to protect.
    chunkSizeWarningLimit: 1000,
  },
}));
