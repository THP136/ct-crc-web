import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: process.env.VITE_BASE_PATH || "/",
  plugins: [react()],
  build: {
    sourcemap: false,
    minify: "esbuild",
  },
  server: {
    proxy: {
      "/api": { target: "http://127.0.0.1:5509", changeOrigin: true },
    },
  },
});
