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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const REPORT = join(process.cwd(), 'scripts/ci/integration/report.sh');
const RUN = join(process.cwd(), 'scripts/ci/integration/run.sh');
const A = 'tests/integration/a.int.test.ts';
const SILENT = 'tests/integration/zz-no-such-suite.int.test.ts';

/** Every temporary directory this file makes, removed after it. */
const made: string[] = [];
const tempDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
};
afterAll(() => { for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function workDir(files: Record<string, string>): string {
  const work = tempDir('isaflow-finish-run-');
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

const WAIT = 'wait_shards "${PIDS[@]}"';
/** The only statements run.sh's tail may hold (comments and blank lines aside), in this order. */
const TAIL_ALLOWED = [/^finish_run "\$WORK" "\$SHARDS" "\$FAILED_SHARDS" "\$START" "\$PWD\/\.ci-integration-logs"$/, /^exit "\$FAILED"$/];

/**
 * run.sh's lines after its one `wait_shards "${PIDS[@]}"` line. Fails closed: it throws, so nothing is run, when that
 * line is not there exactly once (reformatted, or with anything appended such as `; FAILED=0`), or when the tail,
 * comments and blank lines aside, is anything but the finish_run call and `exit "$FAILED"`, in that order (an
 * allowlist: cutting at the wrong place, or one more command, could run the whole gate from vitest).
 */
function runShTail(text: string): string {
  const lines = text.split('\n');
  const hits = lines.flatMap((l, i) => (l.trim() === WAIT ? [i] : []));
  if (hits.length !== 1) throw new Error(`run.sh: expected exactly one line \`${WAIT}\`, found ${hits.length}`);
  const tail = lines.slice(hits[0]! + 1);
  const code = tail.map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('#'));
  const ok = code.length === TAIL_ALLOWED.length && code.every((l, i) => TAIL_ALLOWED[i]!.test(l));
  if (!ok) {
    throw new Error(`run.sh's tail after \`${WAIT}\` must be exactly the finish_run call and \`exit "$FAILED"\`; `
      + `found: ${JSON.stringify(code)}; refusing to run it`);
  }
  return tail.join('\n');
}

describe('runShTail: cutting run.sh fails closed, before anything runs', () => {
  const FINISH = 'finish_run "$WORK" "$SHARDS" "$FAILED_SHARDS" "$START" "$PWD/.ci-integration-logs"';
  const EXIT = 'exit "$FAILED"';

  it('throws for a missing anchor, including one with `; FAILED=0` appended', () => {
    expect(() => runShTail(`${FINISH}\n${EXIT}\n`)).toThrow(/found 0/);
    expect(() => runShTail(`${WAIT}; FAILED=0\n${FINISH}\n${EXIT}\n`)).toThrow(/found 0/);
  });

  it('throws for a duplicate anchor', () => {
    expect(() => runShTail(`${WAIT}\n${WAIT}\n${FINISH}\n${EXIT}\n`)).toThrow(/found 2/);
  });

  it('refuses any tail but the finish_run call and the exit: another command, a harmless echo, the wrong order', () => {
    for (const extra of ['bash "$(dirname "$0")/run.sh"', 'pg_ctl -D x start', 'echo harmless', 'FAILED=0']) {
      expect(() => runShTail(`${WAIT}\n${FINISH}\n${extra}\n${EXIT}\n`)).toThrow(/refusing to run it/);
    }
    expect(() => runShTail(`${WAIT}\n${EXIT}\n${FINISH}\n`)).toThrow(/refusing to run it/);
    expect(() => runShTail(`${WAIT}\n${FINISH}\n`)).toThrow(/refusing to run it/);
  });

  it('accepts comments and blank lines around the two statements', () => {
    expect(runShTail(`${WAIT}\n\n# 3. Report\n${FINISH}\n  # note\n${EXIT}\n`)).toContain(FINISH);
  });

  it('cuts run.sh itself', () => {
    const tail = runShTail(readFileSync(RUN, 'utf8'));
    expect(tail).toContain(FINISH);
    expect(tail).toMatch(/^exit "\$FAILED"$/m);
  });
});

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

  it('a print failure (stdout closed) never changes the verdict: 0 stays 0, 1 stays 1', () => {
    const verdict = (work: string) => spawnSync('bash', ['-c', `source "$1"; FAILED=0
      finish_run "$2" 2 "" 0 "$2/local-logs" >&-; echo "FAILED=$FAILED" >&2`, 'bash', REPORT, work], { encoding: 'utf8' });
    const healthy = verdict(runDir());
    expect(healthy.stderr).toContain('could not print the whole report');
    expect(healthy.stderr).toMatch(/FAILED=0\n$/);
    const failing = verdict(runDir({ 'c2/isaflow_test.log': ` ↓ ${SILENT} (2 tests | 2 skipped)\n`,
      'c2/isaflow_test.started': `${join(process.cwd(), SILENT)}\n` }));
    expect(failing.stderr).toMatch(/FAILED=1\n$/);
  });

  it('gives the caller back its shell options: errexit, nounset and pipefail on stay on, off stay off', () => {
    const opts = (set: string) => spawnSync('bash', ['-c', `${set}; source "$1"; FAILED=0
      finish_run "$2" 2 "" 0 "$2/local-logs" > /dev/null
      for o in errexit nounset pipefail; do [[ -o $o ]] && echo "$o=on" || echo "$o=off"; done`, 'bash', REPORT, runDir()],
    { encoding: 'utf8' });
    const on = opts('set -euo pipefail');
    expect(on.stdout, on.stderr).toBe('errexit=on\nnounset=on\npipefail=on\n');
    expect(opts('set +e +u +o pipefail').stdout).toBe('errexit=off\nnounset=off\npipefail=off\n');
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
  // pointed at a scratch dir (run.sh keeps its local logs in $PWD/.ci-integration-logs). runShTail throws at collect
  // time, before anything runs, unless it can cut exactly that tail (see its tests below).
  const tail = runShTail(readFileSync(RUN, 'utf8'));
  const runTail = (work: string, failedShards: string) => {
    const here = tempDir('isaflow-run-tail-');
    const r = spawnSync('bash', ['-c', `source "$1"; WORK="$2"; SHARDS=2; START=0; FAILED=\${3:+1}; FAILED=\${FAILED:-0}
      FAILED_SHARDS="$3"; PWD="$4"
${tail}`, 'bash', REPORT, work, failedShards, here], { encoding: 'utf8' });
    return { ...r, logDir: join(here, '.ci-integration-logs') };
  };

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
