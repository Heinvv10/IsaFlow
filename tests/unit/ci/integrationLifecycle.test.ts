/**
 * THE INTEGRATION GATE ENDS ITS OWN PROCESSES AND NOBODY ELSE'S.
 *
 * scripts/ci/integration/lifecycle.sh decides which recorded pids, sessions,
 * postmasters and run directories still belong to the gate. Pids wrap within
 * the hour on the shared box and every tool shell is a session leader, so a
 * pid or session id alone is not enough; a run from another pid namespace
 * cannot be judged at all. These run the real shell functions against real
 * processes (a `sleep` stands in for the victim) in a scratch directory.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const LIB = resolve('scripts/ci/integration/pg-cluster.sh');
let scratch = '';
const victims: ChildProcess[] = [];

/** Run bash with the gate's functions loaded; TMPDIR is the scratch dir. */
function sh(script: string): string {
  return execFileSync('bash', ['-c', `set -u; source ${JSON.stringify(LIB)}; ${script}`], {
    encoding: 'utf8', env: { ...process.env, TMPDIR: scratch },
  }).trim();
}

/** A process in a session of its own (detached: setsid), as an unrelated tool shell would be. */
function victim(): number {
  const child = spawn('sleep', ['600'], { stdio: 'ignore', detached: true });
  victims.push(child);
  return child.pid!;
}

const alive = (pid: number): boolean => existsSync(`/proc/${pid}`) && !readFileSync(`/proc/${pid}/stat`, 'utf8').includes(') Z ');
const start = (pid: number): string => sh(`proc_start ${pid}`);
const settle = (pid: number): void => { for (let i = 0; i < 50 && start(pid) === ''; i++) execFileSync('sleep', ['0.05']); };

/** A run directory as run.sh leaves it after SIGKILL, owned by a process that has exited. */
function deadRun(): string {
  const dir = mkdtempSync(join(scratch, 'isaflow-ci-int.'));
  const exited = Number(sh('bash -c \'echo $$\''));
  writeFileSync(join(dir, 'owner'), `${exited} 1 ${sh('my_pidns')} ${sh('boot_id')}\n`);
  return dir;
}

beforeEach(() => { scratch = mkdtempSync(join(tmpdir(), 'lifecycle-')); });
afterEach(() => {
  for (const v of victims.splice(0)) if (v.pid && alive(v.pid)) process.kill(v.pid, 'SIGKILL');
  rmSync(scratch, { recursive: true, force: true });
});

describe('owner_dead', () => {
  it('is false for a live process with its recorded start time', () => {
    const v = victim(); settle(v);
    expect(sh(`owner_dead ${v} ${start(v)} && echo dead || echo alive`)).toBe('alive');
  });
  it('is true when the pid now belongs to a newer process (pid reuse)', () => {
    const v = victim(); settle(v);
    expect(sh(`owner_dead ${v} 1 && echo dead || echo alive`)).toBe('dead');
  });
  it('is true when no such process exists', () => {
    const gone = Number(sh('bash -c \'echo $$\''));
    expect(sh(`owner_dead ${gone} 1 && echo dead || echo alive`)).toBe('dead');
  });
  it('is false for a process it may not signal (EPERM): not provably dead', () => {
    expect(sh('owner_dead 1 1 && echo dead || echo alive')).toBe('alive');
  });
});

describe('remove_run', () => {
  it('ends a session it recorded (same leader start time) and deletes the run', () => {
    const v = victim(); settle(v);
    const run = deadRun();
    mkdirSync(join(run, 'c3'));
    writeFileSync(join(run, 'c3', 'sid'), `${v} ${start(v)}\n`);
    sh(`remove_run ${JSON.stringify(run)}`);
    expect({ victim: alive(v), dir: existsSync(run) }).toEqual({ victim: false, dir: false });
  });
  it('leaves a session whose id was reused by another process alone', () => {
    const v = victim(); settle(v);
    const run = deadRun();
    mkdirSync(join(run, 'c3'));
    writeFileSync(join(run, 'c3', 'sid'), `${v} 1\n`);
    sh(`remove_run ${JSON.stringify(run)}`);
    expect({ victim: alive(v), dir: existsSync(run) }).toEqual({ victim: true, dir: false });
  });
  it('leaves a session alone whose leader has exited (a daemon-shaped session now holding a reused id)', () => {
    // setsid'd leader forks a worker and exits; the shell running it reaps the leader.
    const name = `lifecycle-victim-${process.pid}-${Date.now()}`;
    const worker = Number(sh(`setsid bash -c '(exec -a ${name} sleep 600) & exit 0' < /dev/null > /dev/null 2>&1
      sleep 0.3; ps -eo pid=,args= | awk -v n=${name} '$2 == n { print $1 }'`));
    const sid = Number(sh(`ps -o sid= -p ${worker}`));
    const run = deadRun();
    mkdirSync(join(run, 'c3'));
    writeFileSync(join(run, 'c3', 'sid'), `${sid} 12345\n`);
    try {
      expect({ leaderGone: !existsSync(`/proc/${sid}`), worker: alive(worker) }).toEqual({ leaderGone: true, worker: true });
      sh(`remove_run ${JSON.stringify(run)}`);
      expect({ worker: alive(worker), dir: existsSync(run) }).toEqual({ worker: true, dir: false });
    } finally {
      if (worker && alive(worker)) process.kill(worker, 'SIGKILL');
    }
  });
  it('does not signal a pid a stale postmaster.pid names when it is not a postmaster in that data dir', () => {
    const v = victim(); settle(v);
    const run = deadRun();
    mkdirSync(join(run, 'c1', 'data'), { recursive: true });
    // Enough of a data directory for pg_ctl to act on the pid file.
    writeFileSync(join(run, 'c1', 'data', 'PG_VERSION'), '16\n');
    writeFileSync(join(run, 'c1', 'data', 'postmaster.pid'), `${v}\n`);
    sh(`remove_run ${JSON.stringify(run)}`);
    expect({ victim: alive(v), dir: existsSync(run) }).toEqual({ victim: true, dir: false });
  });
});

describe('sweep_dead_runs', () => {
  it('removes a run whose owner is dead and one from an earlier boot; keeps a live one, one from another pid namespace, an old record and a symlink', () => {
    const dead = deadRun();
    const live = mkdtempSync(join(scratch, 'isaflow-ci-int.'));
    const v = victim(); settle(v);
    writeFileSync(join(live, 'owner'), `${v} ${start(v)} ${sh('my_pidns')} ${sh('boot_id')}\n`);
    const foreign = mkdtempSync(join(scratch, 'isaflow-ci-int.'));
    // Its pid means nothing here: from this namespace it looks like an exited process.
    const exited = Number(sh('bash -c \'echo $$\''));
    writeFileSync(join(foreign, 'owner'), `${exited} 1 pid:[1] ${sh('boot_id')}\n`);
    const otherBoot = mkdtempSync(join(scratch, 'isaflow-ci-int.'));
    writeFileSync(join(otherBoot, 'owner'), `${exited} 1 ${sh('my_pidns')} 00000000-0000-0000-0000-000000000000\n`);
    const legacy = mkdtempSync(join(scratch, 'isaflow-ci-int.'));
    writeFileSync(join(legacy, 'owner'), `${exited}\n`);
    // A link named like a run, to a directory that would otherwise be swept.
    const target = mkdtempSync(join(scratch, 'elsewhere-'));
    writeFileSync(join(target, 'owner'), `${exited} 1 ${sh('my_pidns')} ${sh('boot_id')}\n`);
    const link = join(scratch, 'isaflow-ci-int.linked');
    symlinkSync(target, link);
    sh('sweep_dead_runs > /dev/null');
    expect([dead, live, foreign, otherBoot, legacy, link, target].map((d) => existsSync(d)))
      .toEqual([false, true, true, false, true, true, true]);
  });
});

describe('pg_cluster_stop on a live postmaster', () => {
  it('stops the postmaster pg_cluster_start started, and not one whose start time differs', () => {
    const dir = mkdtempSync(join(scratch, 'cluster-'));
    const port = sh(`export PGPASSWORD=lc; pg_cluster_init ${JSON.stringify(dir)} && pg_cluster_start ${JSON.stringify(dir)}`);
    const pid = Number(readFileSync(join(dir, 'data', 'postmaster.pid'), 'utf8').split('\n')[0]);
    const recorded = readFileSync(join(dir, 'postmaster.start'), 'utf8').trim();
    try {
      writeFileSync(join(dir, 'postmaster.start'), '1\n');
      sh(`pg_cluster_stop ${JSON.stringify(dir)}`);
      expect({ port: /^\d+$/.test(port), runningAfterStaleRecord: alive(pid) }).toEqual({ port: true, runningAfterStaleRecord: true });
      writeFileSync(join(dir, 'postmaster.start'), `${recorded}\n`);
      sh(`pg_cluster_stop ${JSON.stringify(dir)}`);
      for (let i = 0; i < 100 && alive(pid); i++) execFileSync('sleep', ['0.1']);
      expect(alive(pid)).toBe(false);
    } finally {
      if (alive(pid)) process.kill(pid, 'SIGKILL');
    }
  }, 60_000);
});

describe('shard_outcome', () => {
  it.each([
    [124, 5, 600, 'timeout'],
    [137, 630, 600, 'timeout'],
    [137, 12, 600, 'killed'],
    [1, 12, 600, 'failed'],
    [0, 12, 600, 'ok'],
  ])('status %i after %is (limit %is) is %s', (status, took, limit, outcome) => {
    expect(sh(`shard_outcome ${status} ${took} ${limit}`)).toBe(outcome);
  });
});
