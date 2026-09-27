import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `npm run dev` proxies the backend (:8000), so the page always talks to its
// own origin, exactly like the built site the backend serves on :8000.
const BACKEND = "http://localhost:8000";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": { target: BACKEND },
      "/health": { target: BACKEND },
      "/ws": { target: BACKEND, ws: true },
    },
  },
  build: {
    rollupOptions: {
      // React changes far less often than the app: its own chunk caches
      // separately. (Pixi stays with the app so its renderers, WebGL, WebGPU
      // and canvas, keep loading on demand; forcing it into one chunk would
      // pull all three in.)
      output: { manualChunks: { react: ["react", "react-dom", "react-dom/client"] } },
    },
  },
  test: {
    environment: "node",
  },
});
