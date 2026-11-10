import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const server = process.env.ORCH_SERVER_URL ?? 'http://127.0.0.1:4600';

export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    host: '127.0.0.1',
    port: 5173,
    // In development the UI talks to a separately running Orchestrator server.
    proxy: {
      '/api': { target: server, changeOrigin: false },
      '/ws': { target: server.replace(/^http/, 'ws'), ws: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 2500,
    rollupOptions: { output: { manualChunks: { three: ['three'], r3f: ['@react-three/fiber', '@react-three/drei'], xterm: ['@xterm/xterm', '@xterm/addon-fit'] } } },
  },
});
