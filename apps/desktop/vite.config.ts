import react from '@vitejs/plugin-react';
import path from 'node:path';
import { defineConfig, type Plugin } from 'vite';

const server = process.env.ORCH_SERVER_URL ?? 'http://127.0.0.1:4600';
// To work on the page a stranger gets (docs/ENTRANCE-PAGE.md) the development server has to stand at an office's
// *door*: `ORCH_DOOR_URL=https://127.0.0.1:4795 pnpm dev:ui` (the door of `scripts/entrance-office.ts`, whose
// certificate is its own). Everything then goes through the door, as it would for somebody outside.
const door = process.env.ORCH_DOOR_URL?.replace(/\/+$/, '');
const atDoor = door ? { target: door, changeOrigin: false, secure: false } : null;

/**
 * The arcade's console is a page of its own, shown in a frame (docs/ARCADE.md, "The frame"). It is written out
 * beside the app's other files, where the office's door lets files through, and it carries a policy of its own:
 * the emulator may run WebAssembly and the script it is handed, and may reach nothing on any network.
 */
function arcadeFrame(): Plugin {
  const page = (script: string) =>
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self' blob: 'wasm-unsafe-eval'; connect-src blob: data:; img-src blob: data:; style-src 'unsafe-inline'; media-src blob:" />
    <title>Arcade console</title>
    <style>
      html, body { margin: 0; height: 100%; background: #000; overflow: hidden; }
      /* By its tag: the emulator gives the canvas an id of its own. Its size comes from here, and RetroArch follows it. */
      canvas { display: block; width: 100%; height: 100%; outline: none; }
    </style>
  </head>
  <body>
    <canvas id="screen"></canvas>
    <script type="module" crossorigin src="${script}"></script>
  </body>
</html>
`;
  const entry = path.resolve(import.meta.dirname, 'src/arcade/frame.ts');
  let chunk = '';
  let building = false;
  return {
    name: 'arcade-frame',
    configResolved(config) {
      building = config.command === 'build';
    },
    configureServer(server) {
      server.middlewares.use('/assets/arcade.html', (_req, res) => {
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.end(page('/src/arcade/frame.ts'));
      });
    },
    buildStart() {
      if (building) chunk = this.emitFile({ type: 'chunk', id: entry, name: 'arcade-frame' });
    },
    generateBundle() {
      if (chunk) this.emitFile({ type: 'asset', fileName: 'assets/arcade.html', source: page(`./${path.basename(this.getFileName(chunk))}`) });
    },
  };
}

export default defineConfig({
  plugins: [react(), arcadeFrame()],
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
