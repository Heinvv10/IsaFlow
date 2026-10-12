/**
 * THE INTEGRATION GATE SENDS EACH SUITE TO THE ONE DATABASE ITS GUARDS ACCEPT.
 *
 * assertNotProductionDb throws on isaflow_schema_fixture; assertDisposable
 * throws on isaflow_test. The route is read from what the suite's import
 * closure CALLS, so a new suite needs no list entry.
 */
import { describe, expect, it } from 'vitest';
import { assignShards, importClosure, joinRelative, routeSuite } from '../../../scripts/ci/integration/suiteRoute';

const FILES: Record<string, string> = {
  'tests/helpers/assertNotProductionDb.ts': 'export function assertNotProductionDb(reason: string): void {}\n',
  'tests/integration/mfa-impersonation-postgres.helpers.ts':
    'export function assertDisposable() {}\nexport function response() {}\n',
  'tests/integration/seed.helpers.ts':
    "import { assertNotProductionDb } from '../helpers/assertNotProductionDb';\nexport function seed() { assertNotProductionDb('x'); }\n",
  'tests/integration/plain.int.test.ts': "import { sql } from '@/lib/neon';\n",
  'tests/integration/direct.int.test.ts':
    "import { assertNotProductionDb } from '../helpers/assertNotProductionDb';\nassertNotProductionDb('seeds');\n",
  'tests/integration/via-helper.int.test.ts': "import { seed } from './seed.helpers';\n",
  'tests/integration/disposable.int.test.ts':
    "import { assertDisposable } from './mfa-impersonation-postgres.helpers';\nassertDisposable();\n",
  'tests/integration/response-only.int.test.ts':
    "import { assertNotProductionDb } from '../helpers/assertNotProductionDb';\n"
    + "import { response } from './mfa-impersonation-postgres.helpers';\nassertNotProductionDb('y');\n",
  'tests/integration/both.int.test.ts':
    "import { assertDisposable } from './mfa-impersonation-postgres.helpers';\nimport { seed } from './seed.helpers';\n"
    + 'assertDisposable();\n',
  'tests/integration/imports-only.int.test.ts': "import { assertNotProductionDb } from '../helpers/assertNotProductionDb';\n",
  'tests/integration/dynamic.int.test.ts': "const m = await import('./seed.helpers');\n",
};
const read = (p: string) => FILES[p];
const db = (file: string) => routeSuite(file, read).db;

describe('routeSuite', () => {
  it('sends a suite with no name guard to the fixture database', () => {
    expect(db('tests/integration/plain.int.test.ts')).toBe('isaflow_schema_fixture');
  });

  it('sends a suite that calls assertNotProductionDb to isaflow_test, directly or through a helper', () => {
    expect(db('tests/integration/direct.int.test.ts')).toBe('isaflow_test');
    expect(db('tests/integration/via-helper.int.test.ts')).toBe('isaflow_test');
    expect(db('tests/integration/dynamic.int.test.ts')).toBe('isaflow_test');
  });

  it('counts calls, not the guard being imported or defined', () => {
    expect(db('tests/integration/imports-only.int.test.ts')).toBe('isaflow_schema_fixture');
    expect(db('tests/integration/disposable.int.test.ts')).toBe('isaflow_schema_fixture');
  });

  it('does not let a helper module that merely defines assertDisposable pin a suite to the fixture', () => {
    expect(db('tests/integration/response-only.int.test.ts')).toBe('isaflow_test');
  });

  it('reports a suite whose closure calls both guards as a conflict', () => {
    expect(db('tests/integration/both.int.test.ts')).toBe('conflict');
  });
});

describe('importClosure / joinRelative', () => {
  it('resolves ./ and ../ against the importing file, adding .ts', () => {
    expect(joinRelative('tests/integration', '../helpers/x')).toBe('tests/helpers/x');
    expect([...importClosure('tests/integration/via-helper.int.test.ts', read).keys()]).toEqual([
      'tests/integration/via-helper.int.test.ts',
      'tests/integration/seed.helpers.ts',
      'tests/helpers/assertNotProductionDb.ts',
    ]);
  });
});

describe('assignShards', () => {
  const suites = ['a', 'b', 'c', 'd', 'e', 'f'].map((f) => ({ file: f }));

  it('gives the slowest suite a shard to itself and spreads the rest over the others', () => {
    const dealt = assignShards(suites, 3, { c: 10 }, 1);
    expect(dealt.filter((s) => s.shard === dealt.find((x) => x.file === 'c')!.shard).map((s) => s.file)).toEqual(['c']);
    expect(dealt.map((s) => s.file)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  });

  it('deals equal suites round-robin in path order', () => {
    expect(assignShards(suites, 3, {}, 1).map((s) => s.shard)).toEqual([1, 2, 3, 1, 2, 3]);
  });
});
