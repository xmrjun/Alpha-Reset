import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  server: { host: '127.0.0.1', port: 5173, strictPort: true, proxy: { '/api': { target: 'http://127.0.0.1:8787', ws: true } } },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true, proxy: { '/api': { target: 'http://127.0.0.1:8787', ws: true } } },
  build: { outDir: 'dist', emptyOutDir: true },
});
