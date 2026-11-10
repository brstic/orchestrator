import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { AgentConfig } from './config.ts';

export const SDK_PACKAGE = '@anthropic-ai/claude-agent-sdk';

export interface SdkLocation {
  /** The module file the runner imports. */
  entry: string;
  version: string | null;
  source: 'config' | 'agent-home' | 'node-resolution';
}

function fromDir(dir: string): { entry: string; version: string | null } | null {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const entry = path.join(dir, typeof pkg.main === 'string' ? pkg.main : 'sdk.mjs');
    return fs.existsSync(entry) ? { entry, version: typeof pkg.version === 'string' ? pkg.version : null } : null;
  } catch {
    return null;
  }
}

/**
 * Find the Claude Agent SDK on this machine. The SDK is not bundled with the
 * agent: SDK-managed workers are an optional runtime, offered only on hosts
 * where it is actually installed.
 */
export function locateSdk(cfg: Pick<AgentConfig, 'sdkPath'>, home: string): SdkLocation | null {
  if (cfg.sdkPath) {
    const p = path.resolve(cfg.sdkPath);
    try {
      if (fs.statSync(p).isDirectory()) {
        const found = fromDir(p);
        return found ? { ...found, source: 'config' } : null;
      }
      const found = fromDir(path.dirname(p));
      return { entry: p, version: found?.version ?? null, source: 'config' };
    } catch {
      return null;
    }
  }
  const local = fromDir(path.join(home, 'node_modules', ...SDK_PACKAGE.split('/')));
  if (local) return { ...local, source: 'agent-home' };
  try {
    const entry = createRequire(import.meta.url).resolve(SDK_PACKAGE);
    const found = fromDir(path.dirname(entry));
    return { entry, version: found?.version ?? null, source: 'node-resolution' };
  } catch {
    return null;
  }
}

/** `npm install` the SDK into the agent's own state directory (nothing global, nothing in a project). */
export function installSdk(home: string, version: string | null): Promise<number> {
  fs.mkdirSync(home, { recursive: true });
  const pkgFile = path.join(home, 'package.json');
  if (!fs.existsSync(pkgFile)) fs.writeFileSync(pkgFile, JSON.stringify({ name: 'orchestrator-agent-runtime', private: true }, null, 2));
  return new Promise((resolve, reject) => {
    // The optional dependencies are bundled copies of the claude binary; workers use the installed CLI instead.
    const child = spawn('npm', ['install', '--prefix', home, '--omit=optional', '--no-audit', '--no-fund', version ? `${SDK_PACKAGE}@${version}` : SDK_PACKAGE], { stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });
}
