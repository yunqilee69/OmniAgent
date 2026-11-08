import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: resolve(import.meta.dirname, 'ui'),
  plugins: [react()],
  build: {
    outDir: resolve(import.meta.dirname, 'dist'),
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    port: 4318,
    proxy: {
      '/api': 'http://127.0.0.1:4317',
    },
  },
  css: {
    modules: {
      localsConvention: 'camelCaseOnly',
    },
  },
});
