/**
 * R-184 — `@/lib/neon` is a barrel over small modules, and nothing reaches past it.
 *
 * 1. Size: the barrel (src/lib/neon.ts) and every module under src/lib/neon/ keep to the repo's
 *    300-line limit. Before R-184 the whole client was one 475-line file.
 * 2. Boundary: no tracked file other than the barrel and the modules themselves imports, mocks or
 *    requires a module under src/lib/neon/. Dozens of tests `vi.mock('@/lib/neon', factory)` with
 *    a factory that returns only some names; a production module that imported
 *    '@/lib/neon/sql' directly would get the REAL `sql` under such a test and bypass the mock
 *    silently. Everything outside goes through '@/lib/neon'.
 *
 * Limits: reads `git ls-files`, so an untracked file is not seen until it is added. Specifiers
 * are read with a regex over the source text (import/export from, import(), require(),
 * vi.mock/doMock, importActual/importMock, jest.requireActual/requireMock), relative ones resolved
 * against the file and `@/` against src/. Not seen: an absolute-path specifier
 * ('/home/.../src/lib/neon/sql'), any other alias than `@/`, and a specifier built at runtime.
 * None exists today.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import path from 'path';

const BARREL = 'src/lib/neon.ts';
const MODULE_DIR = 'src/lib/neon/';
const SELF = 'tests/unit/lib/neonModuleShape.test.ts';
const MAX_LINES = 300;

const tracked = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).trim().split('\n');
const modules = tracked.filter((f) => f.startsWith(MODULE_DIR) && /\.tsx?$/.test(f));
const code = tracked.filter((f) => /\.(tsx?|mts|cts|mjs|cjs|js|jsx)$/.test(f) && f !== SELF);

const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*|\b(?:vi|jest)\.(?:do)?[mM]ock\s*\(\s*|\b(?:importActual|importMock|requireActual|requireMock)\s*(?:<.*?>)?\s*\(\s*)(['"`])([^'"`\n]+)\1/g;

/** The module-directory files a source text names, resolved from `file`. */
function reachesIntoModuleDir(file: string, text: string): string[] {
  const hits: string[] = [];
  for (const m of text.matchAll(SPECIFIER)) {
    const spec = m[2]!;
    const resolved = spec.startsWith('@/') ? path.posix.join('src', spec.slice(2))
      : spec.startsWith('.') ? path.posix.join(path.posix.dirname(file), spec)
        : null;
    if (resolved !== null && resolved.startsWith(MODULE_DIR)) hits.push(spec);
  }
  return hits;
}

describe('R-184: @/lib/neon modules keep to the 300-line limit', () => {
  it('the client is split: the barrel plus its modules', () => {
    expect(tracked).toContain(BARREL);
    expect(modules.length).toBeGreaterThanOrEqual(3);
  });

  it.each([BARREL, ...modules])('%s is at most 300 lines', (file) => {
    const lines = readFileSync(file, 'utf8').split('\n').length - 1;
    expect(lines).toBeLessThanOrEqual(MAX_LINES);
  });
});

describe('R-184: only the barrel imports the modules under src/lib/neon/', () => {
  it('the tracked tree was read, and the reader sees the barrel reaching its modules', () => {
    expect(code.length).toBeGreaterThan(1000);
    expect(code).toEqual(expect.arrayContaining([BARREL, 'src/lib/auth/withAuth.ts', 'scripts/check-session.ts']));
    expect(reachesIntoModuleDir(BARREL, readFileSync(BARREL, 'utf8')).length).toBeGreaterThanOrEqual(3);
  });

  it.each([
    ['pages/api/x.ts', "import { sql } from '@/lib/neon/sql';"],
    ['src/lib/foo.ts', "import { getPool } from './neon/pool';"],
    ['src/lib/auth/x.ts', "export { withTransaction } from '../neon/transaction';"],
    ['src/modules/m/s.ts', "const { sql } = await import('@/lib/neon/sql');"],
    ['tests/unit/x.test.ts', "vi.mock('@/lib/neon/pool', () => ({}));"],
    ['tests/unit/x.test.ts', "vi.doMock(\"@/lib/neon/sql\");"],
    ['tests/unit/lib/x.test.ts', "import { sql } from '../../../src/lib/neon/sql';"],
    ['scripts/x.ts', "const n = require('../src/lib/neon/pool');"],
    ['tests/unit/x.test.ts', "const real = await vi.importActual<typeof import('x')>('@/lib/neon/sql');"],
    ['src/lib/foo.ts', "import type { DbRow } from './neon/query';"],
    ['tests/unit/x.test.ts', "const m = await vi.importMock<typeof import('x')>('@/lib/neon/pool');"],
    ['tests/unit/x.test.ts', "const real = jest.requireActual('@/lib/neon/sql');"],
  ])('flags %s: %s', (file, text) => {
    expect(reachesIntoModuleDir(file, text)).toHaveLength(1);
  });

  it.each([
    ['pages/api/x.ts', "import { sql, withTransaction } from '@/lib/neon';"],
    ['scripts/x.ts', "import { sql } from '../src/lib/neon.ts';"],
    ['scripts/x.ts', "import { sql } from '../src/lib/neon';"],
    ['tests/unit/x.test.ts', "vi.mock('@/lib/neon', async (orig) => ({ ...(await orig()), sql }));"],
    ['src/lib/foo.ts', "import { x } from '@/lib/neonHelpers';"],
    ['src/lib/foo.ts', "import { x } from './neonish/pool';"],
  ])('passes %s: %s', (file, text) => {
    expect(reachesIntoModuleDir(file, text)).toEqual([]);
  });

  it('no tracked file outside the barrel and its modules names a module under src/lib/neon/', () => {
    const offenders = code
      .filter((f) => f !== BARREL && !f.startsWith(MODULE_DIR))
      .flatMap((f) => reachesIntoModuleDir(f, readFileSync(f, 'utf8')).map((spec) => `${f}: ${spec}`));
    expect(offenders).toEqual([]);
  });
});
