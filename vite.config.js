import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Base path is "/" for local dev and the zero-dependency static server, but is
// overridden to "/china-hsr-simulation/" by the GitHub Pages build (the deploy
// workflow sets BASE_PATH). All runtime fetches resolve against
// import.meta.env.BASE_URL so the same bundle works at the root or under a
// project sub-path. See src/App.jsx withBase().
const base = process.env.BASE_PATH || '/';

export default defineConfig({
  base,
  plugins: [react()],
  server: {
    port: 5174,
  },
  preview: {
    port: 4174,
  },
  build: {
    // The map engine (mapbox-gl ~1.7 MB / maplibre-gl ~1.0 MB) is loaded via
    // dynamic import() in HSRMap so each is split into its own chunk and kept
    // out of the initial bundle (only ONE loads at runtime, on demand);
    // Dashboard/BookingPanel are React.lazy chunks. The entry chunk is ~210 KB.
    // Lift the ceiling above the known GL vendor chunk so the build stays clean.
    chunkSizeWarningLimit: 1800,
  },
});
