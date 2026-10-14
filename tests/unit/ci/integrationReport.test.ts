import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPORT = join(process.cwd(), 'scripts/ci/integration/report.sh');

describe('integration shard log reporting', () => {
  it('prints only failed shards and bounds both their lines and line width', () => {
    const work = mkdtempSync(join(tmpdir(), 'isaflow-integration-report-'));
    mkdirSync(join(work, 'c1'));
    mkdirSync(join(work, 'c2'));
    writeFileSync(join(work, 'c1', 'isaflow_test.log'), 'successful log must stay quiet\n');
    writeFileSync(join(work, 'c2', 'isaflow_test.log'), `old failure context\n${'x'.repeat(3000)}\nlast failure line\n`);

    const output = execFileSync('bash', ['-c', `
      source "$1"
      CI_INT_FAILURE_LOG_LINES=2 CI_INT_FAILURE_LOG_COLUMNS=100 \\
        report_integration_failure_logs "$2" 2 "2"
    `, 'bash', REPORT, work], { encoding: 'utf8' });

    expect(output).not.toContain('successful log must stay quiet');
    expect(output).not.toContain('old failure context');
    expect(output).toContain('shard 2/2, isaflow_test (failed; last 2 lines, 100 columns max)');
    expect(output).toContain(`${'x'.repeat(100)}\nlast failure line`);
    expect(Math.max(...output.split('\n').map((line) => line.length))).toBeLessThanOrEqual(100);
  });
});

/** A work dir with shard logs and summaries, as shard.sh leaves them. */
function workDir(files: Record<string, string>): string {
  const work = mkdtempSync(join(tmpdir(), 'isaflow-integration-report-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(work, path, '..'), { recursive: true });
    writeFileSync(join(work, path), text);
  }
  return work;
}
const sh = (script: string, work: string): string =>
  execFileSync('bash', ['-c', `source "$1"; ${script}`, 'bash', REPORT, work], { encoding: 'utf8', cwd: process.cwd() });

describe('integration report: failed shards, one database at a time', () => {
  it('keeps a database quiet when its shard summary says it passed, even when the other database failed', () => {
    const work = workDir({
      'c1/isaflow_schema_fixture.log': 'fixture passed quietly\n',
      'c1/isaflow_test.log': 'the test database failed here\n',
      'c1/summary': '[integration] shard 1/1 isaflow_schema_fixture: 3 files, 2s, exit 0\n'
        + '[integration] shard 1/1 isaflow_test: 2 files, 2s, exit 1\n',
    });
    const out = sh('report_integration_failure_logs "$2" 1 " 1"', work);
    expect(out).not.toContain('fixture passed quietly');
    expect(out).toContain('the test database failed here');
  });

  it('bounds a tail at 400 lines of 400 columns by default', () => {
    const lines = Array.from({ length: 450 }, (_, i) => `${i}:${'y'.repeat(600)}`).join('\n');
    const out = sh('report_integration_failure_logs "$2" 1 "1"', workDir({ 'c1/isaflow_test.log': `${lines}\n` }));
    expect(out).toContain('(failed; last 400 lines, 400 columns max)');
    expect(out).not.toContain('\n49:');
    expect(out).toContain('\n50:');
    expect(Math.max(...out.split('\n').map((l) => l.length))).toBeLessThanOrEqual(400);
  });
});

describe('integration report: every database\'s results', () => {
  it('prints totals, the failing files (a glued line too), the failure excerpt and the gate notes, not the log', () => {
    const log = [
      '{"level":"info","message":"API Request"}',
      ' ✓ tests/integration/a.int.test.ts (1 test) 1ms',
      '[seed] ✓ migrated 3 rows❯ tests/integration/b.int.test.ts (2 tests | 1 failed) 9ms',
      '⎯⎯⎯ Failed Tests 1 ⎯⎯⎯',
      ' FAIL  tests/integration/b.int.test.ts > b > fails',
      ' Test Files  1 failed | 1 passed (2)',
      '      Tests  1 failed | 2 passed (3)',
      '[integration] shard 1/1 isaflow_test: vitest ran 2 files of 2',
    ].join('\n');
    const out = sh('report_shard_results "$2" 1', workDir({ 'c1/isaflow_test.log': `${log}\n` }));
    expect(out).toContain('----- [integration] shard 1/1, isaflow_test -----');
    expect(out).toContain(' Test Files  1 failed | 1 passed (2)');
    expect(out).toContain(' ❯ tests/integration/b.int.test.ts (2 tests | 1 failed)');
    expect(out).toContain(' FAIL  tests/integration/b.int.test.ts > b > fails');
    expect(out).toContain('[integration] shard 1/1 isaflow_test: vitest ran 2 files of 2');
    expect(out).not.toContain('API Request');
    expect(out).not.toContain('a.int.test.ts');
  });

  it('print_report never fails the caller, even when stdout is closed', () => {
    const work = workDir({ 'report.txt': 'the report\n' });
    const r = spawnSync('bash', ['-c', 'source "$1"; set -e; print_report "$2/report.txt" /x >&-; echo survived >&2',
      'bash', REPORT, work], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('could not print the whole report');
    expect(r.stderr).toContain('survived');
  });
});

describe('integration report: a failed shard is never silent (review round 9)', () => {
  it('names a failed shard with no log and no summary at all, and each database it has nothing for', () => {
    const work = workDir({ 'c1/.keep': '', 'plan.tsv': '1\tisaflow_schema_fixture\ttests/integration/a.int.test.ts\n' });
    const out = sh('report_integration_failure_logs "$2" 1 " 1"', work);
    expect(out).toContain('[integration] shard 1/1 FAILED');
    expect(out).toContain('[integration] shard 1/1 isaflow_schema_fixture: NO LOG (1 file planned)');
    expect(out).toContain('[integration] shard 1/1 isaflow_test: NO LOG (no files planned)');
  });

  it('never treats a database without a summary line as passed: it says so and prints the tail', () => {
    const work = workDir({
      'c1/isaflow_schema_fixture.log': 'fixture passed\n',
      'c1/isaflow_test.log': 'the shard died in the middle of this\n',
      'c1/summary': '[integration] shard 1/1 isaflow_schema_fixture: 3 files, 2s, exit 0\n',
    });
    const out = sh('report_integration_failure_logs "$2" 1 "1"', work);
    expect(out).toContain('[integration] shard 1/1 isaflow_schema_fixture: passed (exit 0), log not printed');
    expect(out).not.toContain('fixture passed');
    expect(out).toContain('[integration] shard 1/1 isaflow_test: NO SUMMARY LINE');
    expect(out).toContain('the shard died in the middle of this');
  });

  it('prints the tail of a database that timed out (its summary line has no exit status)', () => {
    const work = workDir({
      'c1/isaflow_test.log': 'last file was hanging\n',
      'c1/summary': '[integration] shard 1/1 isaflow_test: TIMED OUT after 1800s (shard limit 1800s); last file started: x\n',
    });
    expect(sh('report_integration_failure_logs "$2" 1 "1"', work)).toContain('last file was hanging');
  });

  it('cuts by characters, not bytes: a ✓ at the column limit stays whole', () => {
    const line = `${'a'.repeat(399)}✓✓✓ tail`;
    const out = sh('report_integration_failure_logs "$2" 1 "1"', workDir({ 'c1/isaflow_test.log': `${line}\n` }));
    expect(out.split('\n')).toContain(`${'a'.repeat(399)}✓`);
    expect(out).not.toContain('�');
  });
});

describe('integration report: the failure section, and which shards failed', () => {
  it('caps vitest\'s failure section at 300 lines', () => {
    const body = Array.from({ length: 500 }, (_, i) => `failure detail ${i}`);
    const log = ['⎯⎯⎯ Failed Tests 1 ⎯⎯⎯', ...body, ' Test Files  1 failed (1)'].join('\n');
    const out = sh('report_shard_results "$2" 1', workDir({ 'c1/isaflow_test.log': `${log}\n` }));
    expect(out).toContain('failure detail 298');
    expect(out).not.toContain('failure detail 299');
  });

  it('wait_shards hands the failed shards (by exit status) to the report', () => {
    const work = workDir({ 'c2/isaflow_test.log': 'shard two failed here\n', 'c1/isaflow_test.log': 'shard one passed\n',
      'plan.tsv': '' });
    const out = sh(`(exit 0) & a=$!; (exit 3) & b=$!; (exit 0) & c=$!
      wait_shards "$a" "$b" "$c"; echo "failed=$FAILED shards=[$FAILED_SHARDS]"
      report_integration_failure_logs "$2" 3 "$FAILED_SHARDS"`, work);
    expect(out).toContain('failed=1 shards=[ 2]');
    expect(out).toContain('[integration] shard 2/3 FAILED');
    expect(out).toContain('shard two failed here');
    expect(out).not.toContain('shard one passed');
  });
});

describe('integration report: the tail bounds are validated (review round 12)', () => {
  const run = (env: Record<string, string>, work: string) => spawnSync('bash', ['-c',
    'source "$1"; report_integration_failure_logs "$2" 1 "1"', 'bash', REPORT, work],
  { encoding: 'utf8', env: { ...process.env, ...env } });
  const log = `${Array.from({ length: 450 }, (_, i) => `${i}:${'z'.repeat(500)}`).join('\n')}\n`;

  // Under a UTF-8 locale, as a GitHub runner and most shells are: a regex [0-9] there also takes U+0663 (٣).
  const utf8 = { LC_ALL: 'en_US.UTF-8', LANG: 'en_US.UTF-8' };
  const BAD = ['abc', '0', '-5', '1;system("echo pwned")', '٣', '5٣', '05', '5\n', '1234567890', '', '7\n::error::boom'];
  for (const bad of BAD) {
    it(`falls back to the default 400 x 400 for CI_INT_FAILURE_LOG_COLUMNS / _LINES=${JSON.stringify(bad)}, saying so on stderr`, () => {
      const r = run({ ...utf8, CI_INT_FAILURE_LOG_COLUMNS: bad, CI_INT_FAILURE_LOG_LINES: bad },
        workDir({ 'c1/isaflow_test.log': log }));
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('(failed; last 400 lines, 400 columns max)');
      expect(r.stdout).toContain(`\n449:${'z'.repeat(396)}\n`);
      expect(r.stdout).not.toContain('\n49:');
      expect(r.stdout).not.toContain('pwned');
      // Exactly one note per variable, each one line of its own, starting with the gate's prefix.
      const notes = r.stderr.split('\n').filter((l) => l !== '');
      expect(notes).toHaveLength(2);
      expect(notes[0]).toMatch(/^\[integration\] CI_INT_FAILURE_LOG_LINES=.* is not a positive integer; using 400$/);
      expect(notes[1]).toMatch(/^\[integration\] CI_INT_FAILURE_LOG_COLUMNS=.* is not a positive integer; using 400$/);
    });
  }

  it('quotes the value in the note: a newline in it cannot start a line, an empty one shows as \'\'', () => {
    const work = workDir({ 'c1/isaflow_test.log': log });
    expect(run({ ...utf8, CI_INT_FAILURE_LOG_LINES: '7\n::error::boom' }, work).stderr)
      .toBe("[integration] CI_INT_FAILURE_LOG_LINES=$'7\\n::error::boom' is not a positive integer; using 400\n");
    expect(run({ ...utf8, CI_INT_FAILURE_LOG_LINES: '' }, work).stderr)
      .toBe("[integration] CI_INT_FAILURE_LOG_LINES='' is not a positive integer; using 400\n");
  });

  it('the cap is 9 digits: 999999999 is taken, 1000000000 is not', () => {
    const work = workDir({ 'c1/isaflow_test.log': log });
    expect(run({ ...utf8, CI_INT_FAILURE_LOG_COLUMNS: '999999999' }, work).stdout).toContain('999999999 columns max');
    const ten = run({ ...utf8, CI_INT_FAILURE_LOG_COLUMNS: '1000000000' }, work);
    expect(ten.stdout).toContain('400 columns max');
    expect(ten.stderr).toContain('CI_INT_FAILURE_LOG_COLUMNS=1000000000 is not a positive integer; using 400');
  });

  it('is silent when the variables are unset, and takes 9 digits', () => {
    const env = { ...process.env, ...utf8 };
    delete env.CI_INT_FAILURE_LOG_LINES;
    delete env.CI_INT_FAILURE_LOG_COLUMNS;
    const r = spawnSync('bash', ['-c', 'source "$1"; report_integration_failure_logs "$2" 1 "1"', 'bash', REPORT,
      workDir({ 'c1/isaflow_test.log': log })], { encoding: 'utf8', env });
    expect(r.stderr).toBe('');
    expect(r.stdout).toContain('(failed; last 400 lines, 400 columns max)');
    const nine = run({ ...utf8, CI_INT_FAILURE_LOG_LINES: '999999999' }, workDir({ 'c1/isaflow_test.log': log }));
    expect(nine.stderr).toBe('');
    expect(nine.stdout).toContain('(failed; last 999999999 lines, 400 columns max)');
  });

  it('still takes a valid override', () => {
    const r = run({ CI_INT_FAILURE_LOG_COLUMNS: '7', CI_INT_FAILURE_LOG_LINES: '1' }, workDir({ 'c1/isaflow_test.log': log }));
    expect(r.stdout).toContain('(failed; last 1 lines, 7 columns max) -----\n449:zzz\n');
    expect(r.stderr).toBe('');
  });

  it('says "(log empty)" under the header of a failed database whose log is empty', () => {
    const out = sh('report_integration_failure_logs "$2" 1 "1"', workDir({
      'c1/isaflow_test.log': '',
      'c1/summary': '[integration] shard 1/1 isaflow_test: 0 files, 1s, exit 1\n',
    }));
    expect(out).toContain('(failed; last 400 lines, 400 columns max) -----\n(log empty)\n');
  });
});

describe('unblock_stdio (the GitHub runner EAGAIN fix)', () => {
  // stdout and stderr are separate pipes here (spawnSync's default), as on a runner that keeps the two streams apart.
  it('clears O_NONBLOCK on stdout AND on a separate stderr pipe', () => {
    const work = workDir({});
    const flags = join(work, 'flags');
    const flagsOf = (label: string) => `perl -MFcntl -e 'open(my $o, ">>", $ARGV[0]) or die; for my $fd (1, 2) {
      open(my $h, ">&=", $fd) or die; my $f = fcntl($h, F_GETFL, 0); print $o "${label} fd$fd=", ($f & O_NONBLOCK ? 1 : 0), "\\n" }' "$2"`;
    const r = spawnSync('bash', ['-c', `source "$1"
      perl -MFcntl -e 'for my $fd (1, 2) { open(my $h, ">&=", $fd) or die; my $f = fcntl($h, F_GETFL, 0);
        fcntl($h, F_SETFL, $f | O_NONBLOCK) or die }'
      ${flagsOf('before')}
      unblock_stdio
      ${flagsOf('after')}`, 'bash', REPORT, flags], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(flags, 'utf8')).toBe('before fd1=1\nbefore fd2=1\nafter fd1=0\nafter fd2=0\n');
  });
});

describe('report_skips: the skip report reads exactly the databases\' vitest logs (run.sh step 3)', () => {
  const started = (f: string) => `${join(process.cwd(), f)}\n`;
  const SILENT = 'tests/integration/zz-no-such-suite.int.test.ts';
  /** A work dir as a run leaves it: two shards, the clusters' own logs beside the databases' (server.log, initdb.log). */
  const runDir = (skipIn?: string) => {
    const files: Record<string, string> = { 'cp1/server.log': 'LOG: database system is ready\n', 'cp1/initdb.log': 'ok\n' };
    for (const [i, db] of [[1, 'isaflow_schema_fixture'], [2, 'isaflow_test']] as const) {
      const skipped = skipIn === db;
      files[`c${i}/server.log`] = 'LOG: database system is ready\n';
      files[`c${i}/${db}.log`] = skipped ? ` ↓ ${SILENT} (2 tests | 2 skipped)\n` : ` ✓ tests/integration/a.int.test.ts (1 test) 1ms\n`;
      files[`c${i}/${db}.started`] = started(skipped ? SILENT : 'tests/integration/a.int.test.ts');
    }
    return workDir(files);
  };
  const skips = (work: string) => spawnSync('bash', ['-c', 'source "$1"; report_skips "$2" 2', 'bash', REPORT, work],
    { encoding: 'utf8' });

  it('passes a healthy run: the clusters\' server.log and initdb.log are not read', () => {
    const r = skips(runDir());
    expect(r.stdout).not.toContain('[skip] FAIL');
    expect(r.status).toBe(0);
  });

  it.each(['isaflow_schema_fixture', 'isaflow_test'])('reads %s\'s log: a suite skipping everything unexplained there fails', (db) => {
    const r = skips(runDir(db));
    expect(r.status).toBe(1);
    expect(r.stdout).toContain(`[skip]   ${SILENT}`);
  });

  it('says so by name, and fails, when no database left a log', () => {
    const work = workDir({ 'c1/server.log': 'LOG: ready\n' });
    const r = skips(work);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe(`[skip] FAIL: no database log in ${work}/c*/: no shard left a vitest log, so no suite can be checked\n`);
  });
});
