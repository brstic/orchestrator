#!/usr/bin/env node
// Launcher: prefers the bundled build, falls back to the TypeScript sources (Node >= 22.18).
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const bundled = path.join(here, '..', 'dist', 'orchestrator-agent.mjs');
const source = path.join(here, '..', 'src', 'cli.ts');
const mod = await import(pathToFileURL(existsSync(bundled) ? bundled : source).href);
await mod.main(process.argv.slice(2));
