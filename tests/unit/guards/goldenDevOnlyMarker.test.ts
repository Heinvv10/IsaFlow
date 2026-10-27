/**
 * A golden spec that reaches @axe-core/playwright (directly or through relative imports) must carry
 * `// golden:dev-only`, otherwise the post-deploy run loads it on a box where axe may be missing, or runs an
 * axe/dev-data gate against production. Imports are followed as text.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { devOnlySpecFiles, isMarked } from '../../e2e/golden-paths/helpers/devOnlySpecs';

const DIR = path.resolve(__dirname, '../../e2e/golden-paths');
const AXE = '@axe-core/playwright';

function resolveImport(from: string, spec: string): string | null {
  const base = path.resolve(path.dirname(from), spec);
  return [`${base}.ts`, path.join(base, 'index.ts'), base].find((p) => p.endsWith('.ts') && existsSync(p)) ?? null;
}

/** Whether `file` imports axe, directly or via a relative import chain. */
export function reachesAxe(file: string, seen = new Set<string>()): boolean {
  if (seen.has(file)) return false;
  seen.add(file);
  const src = readFileSync(file, 'utf8');
  const specs = [...src.matchAll(/^\s*(?:import|export)\b[^'"\n]*?from\s+['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]/gm)]
    .map((m) => m[1] ?? m[2]!);
  if (specs.includes(AXE)) return true;
  return specs.filter((s) => s.startsWith('.')).some((s) => {
    const next = resolveImport(file, s);
    return next !== null && reachesAxe(next, seen);
  });
}

const specs = readdirSync(DIR).filter((f) => f.endsWith('.spec.ts'));

describe('golden dev-only marker', () => {
  it('finds the specs that need the marker (sanity: axe specs exist)', () => {
    expect(specs.filter((f) => reachesAxe(path.join(DIR, f))).length).toBeGreaterThan(0);
  });

  it.each(specs)('%s: reaches axe only if marked dev-only', (f) => {
    const file = path.join(DIR, f);
    if (reachesAxe(file)) expect(isMarked(readFileSync(file, 'utf8')), `${f} imports ${AXE} but lacks "// golden:dev-only"`).toBe(true);
  });

  it('marks exactly the specs the post-deploy run used to ignore', () => {
    expect(devOnlySpecFiles(DIR).map((f) => f.replace('.spec.ts', ''))).toEqual([
      'n-a11y-main-screens', 'o-theme-contrast', 'o2-theme-behaviour', 'o3-banner-titles', 'q2-top-nav-axe', 'r-command-palette',
      's-shell-cls-mobile', 't-report-filter-dates', 'v-empty-states', 'w-setup-checklist', 'x-contrast-sweep',
    ].sort());
  });
});
