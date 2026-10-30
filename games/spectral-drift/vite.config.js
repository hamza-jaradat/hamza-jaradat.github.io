import { defineConfig } from 'vite';
import { benchSongs } from './bench/devServer.js';

export default defineConfig({
  // Relative asset URLs, so the build works from any subpath (e.g. GitHub Pages /<repo>/).
  base: './',
  build: {
    // three.js alone is ~600 kB minified; that's expected for this game.
    chunkSizeWarningLimit: 900,
  },
  // Module workers, so the analysis worker can load TensorFlow.js as a chunk of its own once
  // the rest of the analysis is under way.
  worker: { format: 'es' },
  // The label page's song folder (dev server only; see bench/).
  plugins: [benchSongs()],
});
