import path from 'node:path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

const api = process.env.VITE_API_PROXY ?? 'http://localhost:4300';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(import.meta.dirname, 'src') } },
  server: {
    port: 5200,
    strictPort: true,
    // same-origin in dev: the browser talks to :5200 only, so the httpOnly refresh cookie just works
    proxy: {
      '/api': { target: api, changeOrigin: true },
      '/socket.io': { target: api, ws: true, changeOrigin: true },
      '/docs': { target: api, changeOrigin: true },
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          charts: ['lightweight-charts', 'recharts'],
          vendor: ['react', 'react-dom', 'react-router', '@tanstack/react-query', 'zustand', 'framer-motion'],
        },
      },
    },
  },
});
