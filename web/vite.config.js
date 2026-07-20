import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/** Proxy reads to the API; block POST /api/refresh so LAN clients can't force polls. */
function apiProxy() {
  return {
    target: "http://127.0.0.1:8788",
    changeOrigin: true,
    bypass(req) {
      const url = req.url || "";
      if (req.method === "POST" && url.split("?")[0] === "/api/refresh") {
        // Serve nothing from Vite — returns 404 instead of proxying to the API.
        return "/api/refresh";
      }
    },
  };
}

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          if (id.includes("recharts") || id.includes("d3-") || id.includes("victory-vendor")) {
            return "recharts";
          }
          if (id.includes("react-dom") || id.includes("/react/") || id.includes("scheduler")) {
            return "react-vendor";
          }
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": apiProxy(),
    },
  },
  preview: {
    port: 8789,
    proxy: {
      "/api": apiProxy(),
    },
  },
});
