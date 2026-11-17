import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig(({ mode }) => ({
  define: { __DESKTOP_E2E__: JSON.stringify(mode === 'desktop-e2e') },
  plugins: [react()],
  // The dependency's default browser export requires document, which does not exist in Workers.
  resolve: { alias: { 'decode-named-character-reference': fileURLToPath(new URL('../../packages/markdown/src/decode-named-reference.ts', import.meta.url)) } },
  server: {
    port: 5173,
    host: '127.0.0.1',
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
}));
