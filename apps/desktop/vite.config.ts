import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const server = process.env.ORCH_SERVER_URL ?? 'http://127.0.0.1:4600';
// To work on the page a stranger gets (docs/ENTRANCE-PAGE.md) the development server has to stand at an office's
// *door*: `ORCH_DOOR_URL=https://127.0.0.1:4795 pnpm dev:ui` (the door of `scripts/entrance-office.ts`, whose
// certificate is its own). Everything then goes through the door, as it would for somebody outside.
const door = process.env.ORCH_DOOR_URL?.replace(/\/+$/, '');
const atDoor = door ? { target: door, changeOrigin: false, secure: false } : null;

export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    host: '127.0.0.1',
    port: 5173,
    // In development the UI talks to a separately running Orchestrator server.
    proxy: atDoor
      ? { '/api': atDoor, '/knock': atDoor, '/login': atDoor, '/join': atDoor, '/ws': { ...atDoor, target: door!.replace(/^http/, 'ws'), ws: true } }
      : {
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
