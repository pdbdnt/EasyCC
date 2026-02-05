import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    port: 5011,
    proxy: {
      '/api': {
        target: 'http://localhost:5010',
        changeOrigin: true
      },
      '/socket': {
        target: 'ws://localhost:5010',
        ws: true,
        changeOrigin: true,
        rewriteWsOrigin: true
      }
    }
  },
  build: {
    outDir: 'dist',
    sourcemap: false
  }
});
