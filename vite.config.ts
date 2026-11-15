import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

// Relative base so the same build works on GitHub Pages, Cloudflare and the bundled Node server.
export default defineConfig({
  base: './',
  plugins: [preact()],
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 600,
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 60_000,
  },
} as never);
