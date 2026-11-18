/**
 * The env files that may still hold an old test-login address, found and rewritten for migrate-slot-emails.ts: the CI env file,
 * every `*.env` directly under the secrets directory, and every `.env.local` directly under each
 * `<workspace>/IsaFlow...` directory and each `<workspace>/IsaFlow_wt/<worktree>` directory. Deduplicated by realpath (the CI env file is a symlink target of a checkout's .env.local).
 * Only the lines' key names and the file paths are ever reported, never a value.
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { planEnvRewrite, type EnvRewrite, type KnownAccount } from './slotEmailPlan';
import { writeEnvFileAtomic } from './slotEnvFile';

export interface EnvDirs { envFile: string; secretsDir: string; workspaceRoot: string }

const dirs = (path: string): string[] => {
  try { return readdirSync(path, { withFileTypes: true }).filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => join(path, e.name)); } catch { return []; }
};
const files = (path: string, pick: (name: string) => boolean): string[] => {
  try { return readdirSync(path).filter(pick).map((n) => join(path, n)); } catch { return []; }
};
const isFile = (p: string): boolean => { try { return statSync(p).isFile(); } catch { return false; } };

/** The candidate files in a stable order, the first path seen for each realpath kept (a dangling symlink is dropped). */
export function discoverEnvFiles(d: EnvDirs): string[] {
  const candidates = [
    d.envFile,
    ...files(d.secretsDir, (n) => n.endsWith('.env')),
    ...dirs(d.workspaceRoot).filter((p) => /^IsaFlow/.test(p.slice(d.workspaceRoot.length + 1))).map((p) => join(p, '.env.local')),
    ...dirs(join(d.workspaceRoot, 'IsaFlow_wt')).map((p) => join(p, '.env.local')),
  ];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of candidates) {
    if (!existsSync(c) && c !== d.envFile) continue;
    let real: string;
    try { real = realpathSync(c); } catch { continue; }
    if (!isFile(real) || seen.has(real)) continue;
    seen.add(real);
    out.push(c);
  }
  return out;
}

export interface EnvScan { path: string; unreadable: boolean; rewrite: EnvRewrite | null }

export function scanEnvFiles(paths: string[], accounts: KnownAccount[]): EnvScan[] {
  return paths.map((path) => {
    try { return { path, unreadable: false, rewrite: planEnvRewrite(readFileSync(path, 'utf8'), accounts) }; } catch { return { path, unreadable: true, rewrite: null }; }
  });
}

/**
 * Rewrites `accounts`' old addresses in every readable file. Each file is read again here, immediately before its write, so
 * a line a peer added since the scan is kept. @returns path and key names for each file changed.
 */
export function rewriteEnvFiles(paths: string[], accounts: KnownAccount[]): Array<{ path: string; keys: string[] }> {
  const changed: Array<{ path: string; keys: string[] }> = [];
  for (const path of paths) {
    let text: string;
    try { text = readFileSync(path, 'utf8'); } catch { continue; }
    const r = planEnvRewrite(text, accounts);
    if (!r.changedKeys.length) continue;
    try { writeEnvFileAtomic(path, r.text); } catch (err) { throw new Error(`could not write ${path}: ${(err as Error).message}; re-run to finish`, { cause: err }); }
    changed.push({ path, keys: r.changedKeys });
  }
  return changed;
}
