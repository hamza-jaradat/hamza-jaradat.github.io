import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset URLs, so the build works from any subpath (e.g. GitHub Pages /<repo>/).
  base: './',
  build: {
    // three.js alone is ~600 kB minified; that's expected for this game.
    chunkSizeWarningLimit: 900,
  },
});
