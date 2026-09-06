/**
 * `@/lib/neon` wraps `pg` — a client component that value-imports it (even
 * transitively) either fails to bundle for the browser or, worse, bundles
 * fine and ships a database driver to the browser. `ShareLinkDialog.tsx`
 * shipped exactly this defect: it reached for `clampTtlDays`, which at the
 * time lived in `shareLinkService.ts` next to `sql`/`withTransaction`. It
 * passed every gate because nothing yet mounts the dialog — a page that did
 * would have failed at build time, but nothing here would have told us why.
 *
 * This walks the REAL import graph — not a grep for one string in one file —
 * from every file under the three WS3 client-component directories, and
 * fails if any file's chain of VALUE imports (never `import type`, never an
 * inline `type X` binding — those are erased before a bundle exists and can't
 * drag a module's runtime code along) reaches `@/lib/neon`.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SRC_ROOT = path.resolve(__dirname, '../../../src');
const FORBIDDEN = path.resolve(SRC_ROOT, 'lib/neon.ts');
// `ShareLinkDialog.tsx` shipped a second instance of this same defect class:
// it value-imported `clampTtlDays` from `shareParams.ts`, which also defines
// `canonicalParamsHash` via `node:crypto` — webpack cannot bundle the `node:`
// URI scheme for the browser and the build fails. Bare specifiers can't be
// resolved to a file path (see resolveSpecifier below), so they're matched by
// name directly in reachesForbidden.
const FORBIDDEN_BARE_SPECIFIERS = ['node:crypto', 'crypto'];

const GUARDED_DIRS = [
  'components/accounting/share',
  'components/accounting/annotations',
  'components/accounting/commentary',
];

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listSourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** True when a braced import clause carries no value binding at all — every
 *  name inside is prefixed `type `. `{ type A, type B }` is type-only;
 *  `{ a, type B }` is not — `a` is a real value binding. */
function isAllTypeOnly(braceClause: string): boolean {
  const inner = braceClause.trim().replace(/^\{/, '').replace(/\}$/, '');
  const names = inner.split(',').map(s => s.trim()).filter(Boolean);
  return names.length > 0 && names.every(n => /^type\s+/.test(n));
}

/** Every module specifier this file reaches via a VALUE binding: named/default
 *  imports that aren't `import type`, side-effect imports, and `export { x }
 *  from '...'` re-exports (but not `export type { X } from '...'`). */
function valueImportSpecifiers(source: string): string[] {
  const specifiers: string[] = [];

  const importRe = /import\s+(type\s+)?([^;]*?)\s+from\s+['"]([^'"]+)['"]\s*;/g;
  let m: RegExpExecArray | null;
  while ((m = importRe.exec(source))) {
    const [, isTypeOnly, clause, spec] = m;
    if (isTypeOnly) continue;
    const trimmed = clause.trim();
    if (/^\{[^}]*\}$/.test(trimmed) && isAllTypeOnly(trimmed)) continue;
    specifiers.push(spec);
  }

  const sideEffectRe = /import\s+['"]([^'"]+)['"]\s*;/g;
  while ((m = sideEffectRe.exec(source))) specifiers.push(m[1]);

  const reExportRe = /export\s+(type\s+)?\{[^}]*\}\s+from\s+['"]([^'"]+)['"]\s*;/g;
  while ((m = reExportRe.exec(source))) {
    if (m[1]) continue;
    specifiers.push(m[2]);
  }

  return specifiers;
}

function resolveModulePath(base: string): string | null {
  const candidates = [
    base,
    `${base}.ts`, `${base}.tsx`,
    path.join(base, 'index.ts'), path.join(base, 'index.tsx'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return null;
}

/** Resolves a relative or `@/`-aliased specifier to an absolute file path, or
 *  `null` for a bare package specifier (node_modules) — those are never
 *  followed, since they can't reach `src/lib/neon.ts`. */
function resolveSpecifier(spec: string, fromFile: string): string | null {
  if (spec.startsWith('.')) return resolveModulePath(path.resolve(path.dirname(fromFile), spec));
  if (spec.startsWith('@/')) return resolveModulePath(path.resolve(SRC_ROOT, spec.slice(2)));
  return null;
}

function reachesForbidden(entry: string, visited: Set<string>): boolean {
  if (entry === FORBIDDEN) return true;
  if (visited.has(entry)) return false;
  visited.add(entry);

  const source = fs.readFileSync(entry, 'utf8');
  for (const spec of valueImportSpecifiers(source)) {
    if (FORBIDDEN_BARE_SPECIFIERS.includes(spec)) return true;
    const resolved = resolveSpecifier(spec, entry);
    if (resolved && reachesForbidden(resolved, visited)) return true;
  }
  return false;
}

describe('WS3 client components never bundle @/lib/neon or node:crypto', () => {
  for (const dir of GUARDED_DIRS) {
    const absDir = path.join(SRC_ROOT, dir);
    for (const file of listSourceFiles(absDir)) {
      const label = path.relative(SRC_ROOT, file);
      it(`${label} has no value-import path to @/lib/neon or node:crypto`, () => {
        expect(reachesForbidden(file, new Set())).toBe(false);
      });
    }
  }
});
