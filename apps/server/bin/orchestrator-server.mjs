#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const bundled = path.join(here, '..', 'dist', 'orchestrator-server.mjs');
const source = path.join(here, '..', 'src', 'main.ts');
const mod = await import(pathToFileURL(existsSync(bundled) ? bundled : source).href);
await mod.main(process.argv.slice(2));
