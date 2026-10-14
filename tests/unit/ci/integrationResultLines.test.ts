/**
 * THE INTEGRATION GATE READS VITEST'S PER-FILE RESULT LINES ONE WAY, EVERYWHERE.
 *
 * shard.sh requires exactly one result line per planned file, run.sh lists the
 * failing files, and the skip report counts skipped tests: all three read
 * ` ✓ tests/x.int.test.ts (3 tests | 1 skipped) 12ms` through
 * scripts/ci/integration/resultLines.ts. A suite's own output can run into that
 * line (no newline before the mark), and that output can carry a ✓ or × of its
 * own; a stack trace can quote a result line. The path is the one after the LAST
 * mark, and the line must END with the result.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { failingLines, resultLine, resultLines, unreadable, wrongCounts } from '../../../scripts/ci/integration/resultLines';

const A = 'tests/integration/a.int.test.ts';
const B = 'tests/integration/b.int.test.ts';

describe('resultLine', () => {
  it('reads a plain, a coloured and a glued result line', () => {
    expect(resultLine(` ✓ ${A} (5 tests) 120ms`)).toEqual({ mark: '✓', file: A, total: 5, counts: {} });
    expect(resultLine(`\u001b[32m ✓\u001b[39m ${A} (1 test) 3ms`)?.file).toBe(A);
    expect(resultLine(`noise without newline↓ ${A} (2 tests | 2 skipped)`))
      .toEqual({ mark: '↓', file: A, total: 2, counts: { skipped: 2 } });
    expect(resultLine(` ❯ ${A} (10 tests | 1 failed | 3 skipped) 410ms`)?.counts).toEqual({ failed: 1, skipped: 3 });
  });

  it('takes the path after the LAST mark when the glued-in output has a ✓ or × of its own', () => {
    expect(resultLine(`[seed] ✓ migrated 3 rows↓ ${A} (4 tests | 4 skipped) 3ms`)?.file).toBe(A);
    expect(resultLine(`stdout | ✓ ok ✓ ${A} (4 tests) 3ms`)?.file).toBe(A);
    expect(resultLine(`× expected 1 ❯ ${A} (4 tests | 1 failed) 3ms`)).toMatchObject({ mark: '❯', file: A });
  });

  it('does not read a result line quoted inside a longer line (a stack trace, a message)', () => {
    expect(resultLine(`    at check ("✓ ${A} (4 tests) 3ms") x.ts:3:1`)).toBeNull();
    expect(resultLine(`Error: wanted "× ${A} (" in the log`)).toBeNull();
    expect(resultLine('     ✓ a test inside a file 3ms')).toBeNull();
  });

  it("reads vitest's optional heap-usage suffix (--logHeapUsage)", () => {
    expect(resultLine(` ✓ ${A} (4 tests) 3ms 45 MB heap used`)).toMatchObject({ mark: '✓', file: A, total: 4 });
    expect(resultLine(`[seed] ✓ hi× ${A} (4 tests | 1 failed) 1203ms 112 MB heap used`)).toMatchObject({ mark: '×', file: A });
    expect(resultLine(`    at x ("✓ ${A} (4 tests) 3ms 45 MB heap used") y.ts:1`)).toBeNull();
  });

  it('reads a path with a space in it', () => {
    expect(resultLine(' ↓ tests/integration/zz spaced.int.test.ts (1 test | 1 skipped)')?.file)
      .toBe('tests/integration/zz spaced.int.test.ts');
  });
});

// The module line of vitest 4.1.2's default reporter (node_modules/vitest/dist/chunks/index.*.js, getModuleLog and
// getEntityPrefix): ` <mark>[ |<project>|][  TS ] <path> (<n> test[s][ | k failed][ | k skipped][ | k todo])`
// then ` <integer>ms` when it has a duration, then ` <integer> MB heap used` with --logHeapUsage. These strings are
// built that way (NO_COLOR, as the gate runs it).
describe('resultLine: every module-line form vitest 4.1.2 writes', () => {
  it.each([
    [` ✓ ${A} (0 test)`, { mark: '✓', file: A, total: 0, counts: {} }],
    [` ✓ ${A} (1 test) 0ms`, { mark: '✓', file: A, total: 1, counts: {} }],
    [` ❯ ${A} (9 tests | 2 failed | 3 skipped | 1 todo) 61234ms`, { mark: '❯', file: A, total: 9, counts: { failed: 2, skipped: 3, todo: 1 } }],
    [` ↓ ${A} (2 tests | 2 skipped)`, { mark: '↓', file: A, total: 2, counts: { skipped: 2 } }],
    [` ✓ ${A} (2 tests) 12ms 45 MB heap used`, { mark: '✓', file: A, total: 2, counts: {} }],
    [` ✓ |integration| ${A} (2 tests) 12ms`, { mark: '✓', file: A, total: 2, counts: {} }],
    [` ❯ |integration|  TS  ${A} (2 tests | 1 failed) 12ms`, { mark: '❯', file: A, total: 2, counts: { failed: 1 } }],
  ])('%s', (line, want) => {
    expect(resultLine(line)).toEqual(want);
  });

  // Not vitest's module line, so not read (and then named as unreadable, below): formatTime's `1.50s` / `1m 2s` is the
  // run summary's, the module line's duration is always integer ms with no space; `(slow)` is not written; `expected
  // fail` is counted only in the Test Files / Tests summary, never on a file's line.
  it.each([` ✓ ${A} (3 tests) 1m 2s`, ` ✓ ${A} (3 tests) 1.50s`, ` ✓ ${A} (3 tests) 10ms (slow)`, ` ✓ ${A} (3 tests) 10 ms`,
    ` ✓ ${A} (3 tests | 1 failed | 1 expected fail) 9ms`])('%s is not read', (line) => {
    expect(resultLine(line)).toBeNull();
  });

  it('reads only the counts vitest 4.1.2 writes: an unknown count word leaves the line unread, and the file is named', () => {
    const odd = ` ✓ ${A} (3 tests | 1 flaky) 9ms`;
    expect(resultLine(odd)).toBeNull();
    expect(unreadable(resultLines(odd), [`/repo/${A}`], '/repo')).toEqual([A]);
  });

  it('NAMED LIMIT: a line holding two results reads only the last; the first file then has no result line and fails closed', () => {
    const glued = ` ✓ ${A} (3 tests) 10ms ❯ ${B} (3 tests | 1 failed) 10ms`;
    expect(resultLines(glued).map((r) => r.file)).toEqual([B]);
    expect(wrongCounts(resultLines(glued), [A, B])).toEqual([{ file: A, n: 0 }]);
  });
});

describe('unreadable: a started suite whose result line cannot be read is named, not dropped', () => {
  it('names each started file (absolute, as vitest records it) with no readable result line', () => {
    const log = [` ✓ ${A} (1 test) 1ms`, ` ✓ ${B} (3 tests) 1m 2s`].join('\n');
    expect(unreadable(resultLines(log), [`/repo/${A}`, `/repo/${B}`], '/repo')).toEqual([B]);
    expect(unreadable(resultLines(log), [`/repo/${A}`], '/repo')).toEqual([]);
  });
});

describe('unreadable compares real paths: a root or a started path reached through a symlink still matches', () => {
  const base = mkdtempSync(join(tmpdir(), 'unreadable-real-'));
  afterAll(() => rmSync(base, { recursive: true, force: true }));
  const real = join(base, 'repo');
  mkdirSync(join(real, 'tests/integration'), { recursive: true });
  writeFileSync(join(real, A), '');
  const link = join(base, 'link');
  symlinkSync(real, link);
  const lines = resultLines(` ✓ ${A} (1 test) 1ms`);

  it('started through the symlink, root real (vitest kept the symlinked cwd; run.sh cd\'s to the physical top level)', () => {
    expect(unreadable(lines, [join(link, A)], real)).toEqual([]);
  });

  it('started real, root through the symlink', () => {
    expect(unreadable(lines, [join(real, A)], link)).toEqual([]);
  });

  it('a path that does not exist is compared as written', () => {
    expect(unreadable(lines, [join(real, B)], link)).toEqual([B]);
  });
});

describe('wrongCounts (shard.sh: exactly one result line per planned file)', () => {
  it('passes a log with one result line per file, glued or not', () => {
    const log = [` ✓ ${A} (1 test) 1ms`, `[seed] ✓ done× ${B} (2 tests | 1 failed) 2ms`].join('\n');
    expect(wrongCounts(resultLines(log), [A, B])).toEqual([]);
  });

  it('does not count a stack trace that quotes a result line, so it cannot double a file or stand in for a missing one', () => {
    const doubled = [` ✓ ${A} (1 test) 1ms`, `    at x ("✓ ${A} (1 test) 1ms")`].join('\n');
    expect(wrongCounts(resultLines(doubled), [A])).toEqual([]);
    const missing = [` ✓ ${A} (1 test) 1ms`, `Error: no "✓ ${B} (" line yet`].join('\n');
    expect(wrongCounts(resultLines(missing), [A, B])).toEqual([{ file: B, n: 0 }]);
  });

  it('flags a file reported twice', () => {
    const log = [` ✓ ${A} (1 test) 1ms`, ` ✓ ${A} (1 test) 1ms`].join('\n');
    expect(wrongCounts(resultLines(log), [A])).toEqual([{ file: A, n: 2 }]);
  });
});

describe('failingLines (run.sh: the failing files in the summary)', () => {
  it('lists a failing file whose result line a suite\'s output ran into, and not a passing one', () => {
    const log = [` ✓ ${A} (1 test) 1ms`, `stdout | ✓ ok❯ ${B} (3 tests | 1 failed) 9ms`].join('\n');
    expect(failingLines(resultLines(log))).toEqual([` ❯ ${B} (3 tests | 1 failed)`]);
  });
});

describe('result-lines.ts, as shard.sh and run.sh call it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'result-lines-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, 'shard.log');
  writeFileSync(log, [` ✓ ${A} (1 test) 1ms`, `    at x ("✓ ${A} (1 test) 1ms")`, `[seed] ✓ hi× ${B} (2 tests | 1 failed) 2ms`].join('\n'));
  const run = (...args: string[]) => spawnSync('bun', ['scripts/ci/integration/result-lines.ts', ...args], { encoding: 'utf8' });

  it('counts: prints only the files without exactly one result line', () => {
    expect(run('counts', log, A, B).stdout).toBe('');
    expect(run('counts', log, A, B, 'tests/integration/c.int.test.ts').stdout).toBe('0\ttests/integration/c.int.test.ts\n');
  });

  it('failed: prints the failing files', () => {
    expect(run('failed', log).stdout).toBe(` × ${B} (2 tests | 1 failed)\n`);
  });

  it('failed <log> <started>: also names a started suite whose result line cannot be read', () => {
    const started = join(dir, 'shard.started');
    writeFileSync(started, `${join(process.cwd(), A)}\n${join(process.cwd(), 'tests/integration/c.int.test.ts')}\n`);
    expect(run('failed', log, started).stdout).toBe(` × ${B} (2 tests | 1 failed)\n`
      + ' ? tests/integration/c.int.test.ts (started, but no readable result line)\n');
  });

  it('refuses an unknown command', () => {
    expect(run('nope', log).status).toBe(2);
  });
});
