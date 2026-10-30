/**
 * The Budget vs Actual page is a browser bundle (PR-B review r1 L3). Walking its
 * VALUE imports (`import type` / `export type` erase at build time and are
 * skipped; `import { type X }` alone is a type) from the page file, no module
 * on the chain may be `@/lib/neon`: that would ship the database client to the
 * browser (it reached it once, through trackingProjection → fiscalYearRegistry).
 * A failure prints the chain that reaches it.
 *
 * The walk resolves `@/…` to src/ and relative paths; packages are leaves.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../../..');
const PAGE = join(ROOT, 'pages/accounting/reports/budget-vs-actual.tsx');
const NEON = [join(ROOT, 'src/lib/neon.ts'), join(ROOT, 'src/lib/neon/index.ts')];

function resolveImport(spec: string, from: string): string | null {
  const base = spec.startsWith('@/') ? join(ROOT, 'src', spec.slice(2)) : spec.startsWith('.') ? resolve(dirname(from), spec) : null;
  if (base === null) return null;
  for (const c of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
    if (existsSync(c) && /\.tsx?$/.test(c)) return c;
  }
  return null;
}

/** Specifiers of the value imports / re-exports / dynamic imports in a source file. */
export function valueImports(src: string): string[] {
  const out: string[] = [];
  const stmt = /(?:^|\n)\s*(import|export)\s+(type\s+)?([^'";]*?)\s*from\s*['"]([^'"]+)['"]/g;
  for (const m of src.matchAll(stmt)) {
    if (m[2]) continue;
    const clause = m[3]!.trim();
    const named = /^\{([^}]*)\}$/.exec(clause);
    if (named && named[1]!.split(',').map((s) => s.trim()).filter(Boolean).every((s) => s.startsWith('type '))) continue;
    out.push(m[4]!);
  }
  for (const m of src.matchAll(/(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g)) out.push(m[1]!);
  for (const m of src.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1]!);
  return out;
}

function walk(entry: string): Map<string, string | null> {
  const parent = new Map<string, string | null>([[entry, null]]);
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift()!;
    for (const spec of valueImports(readFileSync(file, 'utf8'))) {
      const target = resolveImport(spec, file);
      if (target && !parent.has(target)) { parent.set(target, file); queue.push(target); }
    }
  }
  return parent;
}

const chain = (parent: Map<string, string | null>, end: string) => {
  const out: string[] = [];
  for (let f: string | null | undefined = end; f; f = parent.get(f)) out.unshift(relative(ROOT, f));
  return out.join(' → ');
};

describe('the BvA page bundle', () => {
  it('never reaches @/lib/neon through a value import', () => {
    const reached = walk(PAGE);
    // The walk is real: it reaches the tracking modules the page renders through.
    expect([...reached.keys()].map((f) => relative(ROOT, f))).toEqual(expect.arrayContaining([
      'src/modules/accounting/services/budgets/tracking/trackingByMember.ts',
      'src/modules/accounting/services/budgets/tracking/trackingProjection.ts',
      'src/components/accounting/AccountDrillDown.tsx',
    ]));
    const hits = NEON.filter((n) => reached.has(n)).map((n) => chain(reached, n));
    expect(hits).toEqual([]);
  });

  it('the parser tells a type import from a value import', () => {
    expect(valueImports("import type { A } from '@/x';\nimport { type B } from '@/y';\nimport { type C, d } from '@/z';\nexport { e } from './w';\n"))
      .toEqual(['@/z', './w']);
  });
});
