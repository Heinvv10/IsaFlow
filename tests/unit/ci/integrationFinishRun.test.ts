/**
 * THE INTEGRATION GATE'S LAST STAGE, END TO END ON CRAFTED RUN DIRECTORIES.
 *
 * After the shards exit, run.sh hands everything to report.sh's finish_run: the
 * local copy of the databases' logs (.ci-integration-logs/shard<i>-<db>.log),
 * the skip report over the databases' logs only (never a cluster's server.log),
 * the verdict ($FAILED, which a failing skip report must set) and the printed
 * report. The last test runs run.sh's own tail (every line after the shards are
 * waited for) with the shards stubbed, so run.sh calling finish_run and exiting
 * with its verdict is pinned too.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPORT = join(process.cwd(), 'scripts/ci/integration/report.sh');
const RUN = join(process.cwd(), 'scripts/ci/integration/run.sh');
const A = 'tests/integration/a.int.test.ts';
const SILENT = 'tests/integration/zz-no-such-suite.int.test.ts';

function workDir(files: Record<string, string>): string {
  const work = mkdtempSync(join(tmpdir(), 'isaflow-finish-run-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(work, path)), { recursive: true });
    writeFileSync(join(work, path), text);
  }
  return work;
}

/** Two shards as shard.sh leaves them; the clusters' own logs beside. `override` replaces or adds files. */
function runDir(override: Record<string, string> = {}): string {
  const files: Record<string, string> = {
    'plan.tsv': `1\tisaflow_schema_fixture\t${A}\n2\tisaflow_test\t${A}\n`,
    'cp1/server.log': 'LOG: ready\n',
    'cp1/initdb.log': 'ok\n',
  };
  for (const [i, db] of [[1, 'isaflow_schema_fixture'], [2, 'isaflow_test']] as const) {
    files[`c${i}/server.log`] = 'LOG: ready\n';
    files[`c${i}/${db}.log`] = ` ✓ ${A} (1 test) 1ms\n Test Files  1 passed (1)\n`;
    files[`c${i}/${db}.started`] = `${join(process.cwd(), A)}\n`;
    files[`c${i}/summary`] = `[integration] shard ${i}/2 ${db}: 1 files, 1s, exit 0\n`;
  }
  return workDir({ ...files, ...override });
}

/** finish_run on `work`, with FAILED as wait_shards left it; prints FAILED= last. */
function finish(work: string, failedShards = '') {
  const logDir = join(work, 'local-logs');
  const r = spawnSync('bash', ['-c', `source "$1"; FAILED=\${4:+1}; FAILED=\${FAILED:-0}
    finish_run "$2" 2 "$4" 0 "$3"; echo "FAILED=$FAILED"`, 'bash', REPORT, work, logDir, failedShards],
  { encoding: 'utf8' });
  return { ...r, logDir, failed: /FAILED=(\d)\n$/.exec(r.stdout)?.[1] };
}

describe('finish_run (report.sh): the gate\'s last stage', () => {
  it('copies exactly the databases\' logs, named shard<i>-<db>.log, and passes a healthy run', () => {
    const r = finish(runDir());
    expect(readdirSync(r.logDir).sort()).toEqual(['shard1-isaflow_schema_fixture.log', 'shard2-isaflow_test.log']);
    expect(readFileSync(join(r.logDir, 'shard2-isaflow_test.log'), 'utf8')).toContain(A);
    expect(r.failed).toBe('0');
    expect(r.stdout).toContain('----- [integration] shard 2/2, isaflow_test -----');
    expect(r.stdout).toContain('[integration] 2 suites on 2 shards in');
    expect(r.stdout).not.toContain('[skip] FAIL');
  });

  it('a failing skip report sets FAILED=1 (a suite skipping everything with no stated reason)', () => {
    const r = finish(runDir({
      'c2/isaflow_test.log': ` ↓ ${SILENT} (2 tests | 2 skipped)\n`,
      'c2/isaflow_test.started': `${join(process.cwd(), SILENT)}\n`,
    }));
    expect(r.stdout).toContain(`[skip]   ${SILENT}`);
    expect(r.failed).toBe('1');
  });

  it('keeps FAILED=1 from the shards even when the report itself is clean', () => {
    expect(finish(runDir(), ' 1').failed).toBe('1');
  });

  it('an empty database log with no .started is a FAIL by name, not a "timed out before any suite started"', () => {
    const work = runDir({ 'c2/isaflow_test.log': '' });
    spawnSync('rm', [join(work, 'c2/isaflow_test.started')]);
    const r = finish(work);
    expect(r.stdout).toContain(`[skip] FAIL: no started-file list for ${join(work, 'c2/isaflow_test.log')}`);
    expect(r.stdout).not.toContain('timed out before any suite started');
    expect(r.failed).toBe('1');
  });
});

describe('run.sh\'s tail: after the shards are waited for, it hands over to finish_run and exits with its verdict', () => {
  // Every line of run.sh after `wait_shards "${PIDS[@]}"`, run as written, with wait_shards' result stubbed and PWD
  // pointed at a scratch dir (run.sh keeps its local logs in $PWD/.ci-integration-logs).
  const lines = readFileSync(RUN, 'utf8').split('\n');
  const at = lines.findIndex((l) => l.trim() === 'wait_shards "${PIDS[@]}"');
  const tail = lines.slice(at + 1).join('\n');
  const runTail = (work: string, failedShards: string) => {
    const here = mkdtempSync(join(tmpdir(), 'isaflow-run-tail-'));
    const r = spawnSync('bash', ['-c', `source "$1"; WORK="$2"; SHARDS=2; START=0; FAILED=\${3:+1}; FAILED=\${FAILED:-0}
      FAILED_SHARDS="$3"; PWD="$4"
${tail}`, 'bash', REPORT, work, failedShards, here], { encoding: 'utf8' });
    return { ...r, logDir: join(here, '.ci-integration-logs') };
  };

  it('finds the wait in run.sh', () => {
    expect(at).toBeGreaterThan(0);
  });

  it('copies the logs and exits 0 on a clean run', () => {
    const r = runTail(runDir(), '');
    expect(r.status).toBe(0);
    expect(existsSync(join(r.logDir, 'shard1-isaflow_schema_fixture.log'))).toBe(true);
  });

  it('exits 1 when the skip report fails, and when a shard failed', () => {
    const skip = runDir({ 'c1/isaflow_schema_fixture.log': ` ↓ ${SILENT} (1 test | 1 skipped)\n`,
      'c1/isaflow_schema_fixture.started': `${join(process.cwd(), SILENT)}\n` });
    expect(runTail(skip, '').status).toBe(1);
    expect(runTail(runDir(), ' 2').status).toBe(1);
  });
});
