import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Dev-only playground for eyeballing the catalog and theme. Consumers import the source.
export default defineConfig({
  root: 'playground',
  plugins: [react(), tailwindcss()],
  resolve: {
    // Mirrors the package's `exports` so the playground imports it as consumers do.
    alias: [
      {
        find: '@page/design-system/globals.css',
        replacement: resolve(import.meta.dirname, 'src/styles/globals.css'),
      },
      { find: '@page/design-system', replacement: resolve(import.meta.dirname, 'src') },
    ],
  },
});
