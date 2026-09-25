import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The backend (FastAPI) serves the built bundle statically, so assets must be
// referenced relatively. In development `/api` is proxied to uvicorn.
export default defineConfig({
  base: './',
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8000', changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1200,
  },
});
