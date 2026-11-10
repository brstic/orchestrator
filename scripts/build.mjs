#!/usr/bin/env node
/**
 * Bundles the server and the host agent into single files:
 *   apps/server/dist/orchestrator-server.mjs
 *   apps/host-agent/dist/orchestrator-agent.mjs   ← the whole agent; copy it to any machine with Node 22+
 */
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const common = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'info',
  // pg's optional native binding is never used.
  external: ['pg-native'],
  // CommonJS dependencies (fastify and friends) call require(); give the ESM bundle one.
  banner: { js: "import { createRequire as __orchCreateRequire } from 'node:module'; const require = __orchCreateRequire(import.meta.url);" },
};
await build({ ...common, entryPoints: [path.join(root, 'apps/host-agent/src/cli.ts')], outfile: path.join(root, 'apps/host-agent/dist/orchestrator-agent.mjs') });
await build({ ...common, entryPoints: [path.join(root, 'apps/server/src/main.ts')], outfile: path.join(root, 'apps/server/dist/orchestrator-server.mjs') });
for (const f of ['apps/host-agent/dist/orchestrator-agent.mjs', 'apps/server/dist/orchestrator-server.mjs']) {
  const p = path.join(root, f);
  console.log(`${f}  ${(fs.statSync(p).size / 1024).toFixed(0)} KB`);
}
