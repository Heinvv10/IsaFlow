/**
 * scripts/ci/integration/measure-suites.ts (the durations plan.ts deals shards
 * by) and the committed suite-seconds.json it writes.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MIN_SECONDS, parseSuiteTimes, suiteSeconds } from '../../../scripts/ci/integration/measure-suites';

const log = (lines: string[]) => lines.join('\n');

describe('parseSuiteTimes', () => {
  it('reads passed, failed and skipped result lines, and nothing else', () => {
    expect(parseSuiteTimes(log([
      ' ✓ tests/integration/a.int.test.ts (11 tests) 1227ms',
      ' ❯ tests/integration/b.int.test.ts (2 tests | 1 failed) 8632ms',
      ' ↓ tests/integration/c.int.test.ts (1 test | 1 skipped) 3ms',
      '   ✓ a nested test name 120ms',
      ' ✓ tests/unit/d.test.ts (1 test) 5000ms',
      ' Test Files  3 passed (3)',
    ]))).toEqual([
      ['tests/integration/a.int.test.ts', 1227],
      ['tests/integration/b.int.test.ts', 8632],
      ['tests/integration/c.int.test.ts', 3],
    ]);
  });
});

describe('suiteSeconds', () => {
  it('keeps the median over logs, rounded up, and drops suites under MIN_SECONDS', () => {
    const run = (ms: number) => log([` ✓ tests/integration/slow.int.test.ts (1 test) ${ms}ms`, ' ✓ tests/integration/fast.int.test.ts (1 test) 900ms']);
    expect(suiteSeconds([run(10_000), run(40_000), run(12_200)])).toEqual({ 'tests/integration/slow.int.test.ts': 13 });
    expect(suiteSeconds([run(10_000), run(12_000)])).toEqual({ 'tests/integration/slow.int.test.ts': 11 });
  });
});

describe('the committed suite-seconds.json', () => {
  const table = JSON.parse(readFileSync('scripts/ci/integration/suite-seconds.json', 'utf8')) as Record<string, number>;

  it('names only integration suites, each at least MIN_SECONDS, as integers', () => {
    expect(Object.keys(table).length).toBeGreaterThan(0);
    for (const [file, s] of Object.entries(table)) {
      expect(file).toMatch(/^tests\/integration\/.+\.int\.test\.ts$/);
      expect(Number.isInteger(s) && s >= MIN_SECONDS).toBe(true);
    }
  });
});
