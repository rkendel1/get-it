import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `feltkit dev` serves this through Vite; `feltkit build` (and the browser tests) build it to dist/client,
// which FeltKit's server serves from the same origin as the functions (cookie sessions need that).
export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist/client", emptyOutDir: true },
});
