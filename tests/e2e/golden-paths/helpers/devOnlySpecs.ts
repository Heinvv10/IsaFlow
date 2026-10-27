/**
 * Specs that carry the line `// golden:dev-only` in their first 15 lines are skipped by the post-deploy run
 * (GOLDEN_SKIP_A11Y=1, see playwright-golden.config.ts). Files are read as text, never imported, so a spec that
 * needs a package the production box lacks is never loaded.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const DEV_ONLY_MARKER = '// golden:dev-only';
const HEADER_LINES = 15;

export function isMarked(source: string): boolean {
  return source.split('\n').slice(0, HEADER_LINES).some((l) => l.trim() === DEV_ONLY_MARKER);
}

/** Every `*.spec.ts` under `dir` (the config's `testMatch: '**\/*.spec.ts'`), as `/`-separated paths relative to it. */
export function allSpecFiles(dir: string, rel = ''): string[] {
  return readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap((e) => {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : allSpecFiles(dir, r);
    return e.name.endsWith('.spec.ts') ? [r] : [];
  });
}

/** Relative paths of the marked specs under `dir`, sorted. */
export function devOnlySpecFiles(dir: string): string[] {
  return allSpecFiles(dir).filter((f) => isMarked(readFileSync(path.join(dir, f), 'utf8'))).sort();
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function devOnlySpecPattern(dir: string): RegExp | undefined {
  const names = devOnlySpecFiles(dir).map((f) => escapeRe(f.replace(/\.spec\.ts$/, '')));
  return names.length ? new RegExp(`(^|/)(${names.join('|')})\\.spec\\.ts$`) : undefined;
}
