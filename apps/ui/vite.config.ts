/// <reference types="node" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// `ORCHESTRATOR_URL=http://localhost:4000 pnpm --filter @page/ui dev` sends the API and the
// socket to a local orchestrator, so the dev server acts like the orchestrator serving the
// build. Unset, nothing answers /health with JSON and the UI plays the mock source.
const orchestrator = process.env.ORCHESTRATOR_URL;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: orchestrator
    ? {
        proxy: {
          '/health': orchestrator,
          '/issues': orchestrator,
          '/socket.io': { target: orchestrator, ws: true },
        },
      }
    : {},
});
