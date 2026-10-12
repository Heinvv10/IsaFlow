/**
 * THE CI LOG NAMES THE INTEGRATION SUITES THAT SKIPPED, AND WHY; A SUITE THAT
 * SKIPS EVERYTHING WITHOUT SAYING WHY FAILS THE GATE.
 *
 * vitest reports a skipped suite as a pass. The integration gate runs every
 * suite against disposable databases, where a few (live GoTrue, dev's real
 * tenants) cannot run; without this, a green run would not say their proofs
 * were missing from it.
 */
import { describe, expect, it } from 'vitest';
import { skipNotice, skippedSuites } from '../../../scripts/ci/skippedIntegrationSuites';

const FILES: Record<string, string> = {
  'tests/integration/gotrue.int.test.ts': '// ci-integration-skip: needs a live GoTrue\nconst LIVE = false;\n',
  'tests/integration/silent.int.test.ts': 'const describeIfDb = process.env.X ? describe : describe.skip;\n',
  'tests/integration/partly.int.test.ts': 'it.skip("one", () => {});\n',
  'tests/integration/ran.int.test.ts': '// ci-integration-skip: never printed, nothing skipped\n',
};
const read = (f: string) => FILES[f];

const LOG = [
  ' RUN  v4.1.2 /repo',
  ' ↓ tests/integration/gotrue.int.test.ts (2 tests | 2 skipped)',
  '\u001b[32m ✓\u001b[39m tests/integration/ran.int.test.ts (5 tests) 120ms',
  ' ✓ tests/integration/silent.int.test.ts (16 tests | 16 skipped) 3ms',
  ' ❯ tests/integration/partly.int.test.ts (10 tests | 1 failed | 3 skipped) 410ms',
  '     ✓ some test inside a file 3ms',
  ' Test Files  1 failed | 3 passed | 1 skipped (5)',
].join('\n');

describe('skippedSuites', () => {
  const suites = skippedSuites(LOG, read);

  it('reads every file vitest reported with skipped tests, and only those', () => {
    expect(suites.map((s) => [s.file, s.skipped, s.total])).toEqual([
      ['tests/integration/gotrue.int.test.ts', 2, 2],
      ['tests/integration/partly.int.test.ts', 3, 10],
      ['tests/integration/silent.int.test.ts', 16, 16],
    ]);
  });

  it("quotes the reason from the file's ci-integration-skip comment", () => {
    expect(suites[0]!.reason).toBe('needs a live GoTrue');
    expect(suites[2]!.reason).toBeNull();
  });

  it('reads a coloured line the same as a plain one', () => {
    const coloured = skippedSuites('\u001b[33m ↓\u001b[39m tests/integration/gotrue.int.test.ts (2 tests | 2 skipped)', read);
    expect(coloured).toEqual([suites[0]]);
  });
});

describe('skipNotice', () => {
  const { lines, unexplained } = skipNotice(skippedSuites(LOG, read));

  it('prints each skipping suite with how much it skipped and why', () => {
    expect(lines).toContain('[skip] tests/integration/gotrue.int.test.ts: all 2 tests skipped — needs a live GoTrue');
    expect(lines).toContain(
      '[skip] tests/integration/partly.int.test.ts: 3 of 10 tests skipped — no reason stated in the file');
  });

  it('fails a suite that skipped every test without a stated reason, by name', () => {
    expect(unexplained).toEqual(['tests/integration/silent.int.test.ts']);
    expect(lines.join('\n')).toMatch(/FAIL: 1 suite\(s\) skipped every test without a "ci-integration-skip/);
    expect(lines).toContain('[skip]   tests/integration/silent.int.test.ts');
  });

  it('does not fail a suite that skipped only some of its tests', () => {
    expect(unexplained).not.toContain('tests/integration/partly.int.test.ts');
  });

  it('has nothing to say about a run where nothing skipped', () => {
    expect(skipNotice(skippedSuites(' ✓ tests/integration/ran.int.test.ts (5 tests) 1ms', read)))
      .toEqual({ lines: [], unexplained: [] });
  });
});
