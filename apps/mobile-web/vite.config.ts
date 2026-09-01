import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  base: process.env.SLICE_BASE_PATH || "/remote/",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: {
    port: 5173,
    proxy: {
      "/remote/api": {
        target: "http://127.0.0.1:4173",
        ws: true,
        rewrite: (path) => path.replace(/^\/remote/, ""),
      },
    },
  },
});
