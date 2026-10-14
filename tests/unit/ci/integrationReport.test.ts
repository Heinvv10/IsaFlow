import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
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
