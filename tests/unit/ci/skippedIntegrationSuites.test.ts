/**
 * THE CI LOG NAMES THE INTEGRATION SUITES THAT SKIPPED, AND WHY; A SUITE THAT
 * SKIPS EVERYTHING WITHOUT SAYING WHY FAILS THE GATE.
 *
 * vitest reports a skipped suite as a pass. The integration gate runs every
 * suite against disposable databases, where a few (live GoTrue, dev's real
 * tenants) cannot run; without this, a green run would not say their proofs
 * were missing from it.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

  it('counts it.todo as skipped: a suite of only todos asserts nothing and must say why', () => {
    const todo = skipNotice(skippedSuites(' ↓ tests/integration/silent.int.test.ts (2 tests | 2 todo)', read));
    expect(todo.unexplained).toEqual(['tests/integration/silent.int.test.ts']);
    const mixed = skippedSuites(' ✓ tests/integration/gotrue.int.test.ts (5 tests | 1 skipped | 2 todo) 3ms', read);
    expect(mixed.map((m) => [m.skipped, m.total])).toEqual([[3, 5]]);
  });

  it('reads a result line that a suite\'s own output ran into (no newline before the mark)', () => {
    const glued = skippedSuites('noise noise nois↓ tests/integration/silent.int.test.ts (16 tests | 16 skipped) 3ms', read);
    expect(glued.map((m) => [m.file, m.skipped])).toEqual([['tests/integration/silent.int.test.ts', 16]]);
  });

  it('takes the path from the LAST mark on a line whose glued-in output carries an earlier ✓ or × (review round 8)', () => {
    const seed = skippedSuites('[seed] ✓ migrated 3 rows↓ tests/integration/silent.int.test.ts (16 tests | 16 skipped) 3ms', read);
    expect(seed.map((m) => [m.file, m.skipped])).toEqual([['tests/integration/silent.int.test.ts', 16]]);
    const stdout = skippedSuites('stdout | ✓ ok ✓ tests/integration/gotrue.int.test.ts (2 tests | 2 skipped)', read);
    expect(stdout.map((m) => m.file)).toEqual(['tests/integration/gotrue.int.test.ts']);
    const cross = skippedSuites('× boom ↓ tests/integration/partly.int.test.ts (10 tests | 3 skipped) 9ms', read);
    expect(cross.map((m) => m.file)).toEqual(['tests/integration/partly.int.test.ts']);
  });

  it('does not read a result line quoted mid-line (a stack trace or a message), only one that ends the line', () => {
    const quoted = skippedSuites('    at check ("↓ tests/integration/silent.int.test.ts (16 tests | 16 skipped) 3ms") x.ts:3', read);
    expect(quoted).toEqual([]);
  });

  it('reads a path with a space in it', () => {
    const spaced = skippedSuites(' ↓ tests/integration/zz spaced.int.test.ts (1 test | 1 skipped)', () => undefined);
    expect(spaced.map((m) => m.file)).toEqual(['tests/integration/zz spaced.int.test.ts']);
  });

  it('takes the reason only from a comment line of its own, not a string or a comment about the marker', () => {
    const files: Record<string, string> = {
      'tests/integration/string.int.test.ts': "const note = 'see ci-integration-skip: docs';\n",
      'tests/integration/aside.int.test.ts': '// unrelated note: the ci-integration-skip: marker is documented elsewhere\n',
      'tests/integration/indented.int.test.ts': 'describe(() => {\n  // ci-integration-skip: needs a live GoTrue\n});\n',
    };
    const log = Object.keys(files).map((f) => ` ↓ ${f} (1 test | 1 skipped)`).join('\n');
    const { unexplained } = skipNotice(skippedSuites(log, (f) => files[f]));
    expect(unexplained).toEqual(['tests/integration/aside.int.test.ts', 'tests/integration/string.int.test.ts']);
  });

  it('has nothing to say about a run where nothing skipped', () => {
    expect(skipNotice(skippedSuites(' ✓ tests/integration/ran.int.test.ts (5 tests) 1ms', read)))
      .toEqual({ lines: [], unexplained: [], unreadable: [] });
  });
});

describe('skipNotice: a suite whose result line cannot be read fails the report, by name', () => {
  it('cannot tell whether such a suite skipped, so it fails rather than dropping it', () => {
    const { lines, unexplained, unreadable } = skipNotice([], ['tests/integration/odd.int.test.ts']);
    expect(unexplained).toEqual([]);
    expect(unreadable).toEqual(['tests/integration/odd.int.test.ts']);
    expect(lines).toContain('[skip] FAIL: 1 suite(s) started but left no readable result line, so whether they skipped is '
      + 'unknown:');
    expect(lines).toContain('[skip]   tests/integration/odd.int.test.ts');
  });

  it('says nothing extra when every started suite was read', () => {
    expect(skipNotice([], [])).toEqual({ lines: [], unexplained: [], unreadable: [] });
  });
});

describe('report-skipped-integration.ts reads each log\'s sibling .started list', () => {
  it('exits 1 and names a started suite with no readable result line', () => {
    const dir = mkdtempSync(join(tmpdir(), 'skip-report-'));
    try {
      writeFileSync(join(dir, 'isaflow_test.log'), ' ✓ tests/integration/a.int.test.ts (3 tests) 1m 2s\n');
      writeFileSync(join(dir, 'isaflow_test.started'), `${join(process.cwd(), 'tests/integration/a.int.test.ts')}\n`);
      const r = spawnSync('bun', ['scripts/ci/report-skipped-integration.ts', join(dir, 'isaflow_test.log')], { encoding: 'utf8' });
      expect(r.status).toBe(1);
      expect(r.stdout).toContain('[skip]   tests/integration/a.int.test.ts');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('fails loud, by name, for a log whose .started list cannot be found (not *.log, or no sibling list)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'skip-report-'));
    try {
      writeFileSync(join(dir, 'odd.txt'), ' ✓ tests/integration/a.int.test.ts (3 tests) 1ms\n');
      writeFileSync(join(dir, 'lone.log'), ' ✓ tests/integration/a.int.test.ts (3 tests) 1ms\n');
      const r = spawnSync('bun', ['scripts/ci/report-skipped-integration.ts', join(dir, 'odd.txt'), join(dir, 'lone.log')],
        { encoding: 'utf8' });
      expect(r.status).toBe(1);
      expect(r.stdout).toContain(`[skip] FAIL: no started-file list for ${join(dir, 'odd.txt')} (expected a sibling <name>.started)`);
      expect(r.stdout).toContain(`[skip] FAIL: no started-file list for ${join(dir, 'lone.log')} (expected ${join(dir, 'lone.started')})`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
