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
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FORKER_LOOP, SHARD, SPIN, alive, detached, record, scratchDir, settle, sh, start, useScratch, victim } from './integrationLifecycle.helpers';

useScratch();

/** A run directory as run.sh leaves it after SIGKILL, owned by a process that has exited. */
function deadRun(): string {
  const dir = mkdtempSync(join(scratchDir(), 'isaflow-ci-int.'));
  const exited = Number(sh('bash -c \'echo $$\''));
  writeFileSync(join(dir, 'owner'), `${exited} 1 ${sh('my_pidns')} ${sh('boot_id')}\n`);
  return dir;
}

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
  it('is false for another user\'s process (one it may not signal) with the recorded start time', () => {
    expect(sh('owner_dead 1 "$(proc_start 1)" && echo dead || echo alive')).toBe('alive');
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
    const worker = Number(sh(`setsid bash -c '(${record()}; exec -a ${name} sleep 600) & exit 0' < /dev/null > /dev/null 2>&1
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

describe('end_snapshot and a shard\'s own exit', () => {
  it('signals a listed process only while it still has the listed start time, and KILLs one that ignores TERM', () => {
    const stale = victim(); settle(stale);
    const stubborn = detached(`trap "" TERM; ${SPIN}`);
    settle(stubborn.pid!);
    sh(`end_snapshot "${stale} 1
${stubborn.pid} ${start(stubborn.pid!)}"`);
    for (let i = 0; i < 20 && alive(stubborn.pid!); i++) execFileSync('sleep', ['0.1']); // a KILL is not instant
    expect({ stale: alive(stale), stubborn: alive(stubborn.pid!) }).toEqual({ stale: true, stubborn: false });
  }, 20_000);

  // The real shard.sh, with an empty plan, as the leader of a session that
  // already holds what a suite left behind: its EXIT trap must end it.
  function shardWith(leftover: string): string {
    const work = mkdtempSync(join(scratchDir(), 'work-'));
    mkdirSync(join(work, 'c1'));
    writeFileSync(join(work, 'plan.tsv'), '');
    sh(`setsid bash -c '${leftover} & sleep 0.3; exec bash ${SHARD} 1 1 0 ${work} x y' < /dev/null > /dev/null 2>&1`);
    return work;
  }
  const running = (name: string) => sh(`ps -eo pid=,args= | awk -v n=${name} '$2 == n { print $1 }'`);

  it('shard.sh ends the leftovers in its own session on exit (a suite\'s forgotten child)', () => {
    const name = `lifecycle-leftover-${process.pid}-${Date.now()}`;
    shardWith(`(${record()}; exec -a ${name} sleep 600)`);
    expect(running(name)).toBe('');
  });

  it('shard.sh also ends children forked after its first round, even ones that ignore TERM', () => {
    const name = `lifecycle-forker-${process.pid}-${Date.now()}`;
    shardWith(`(trap "" TERM; ${record()}; ${FORKER_LOOP(name)})`);
    expect(running(name)).toBe('');
  }, 30_000);

  it('shard.sh TERMs its leftovers before it KILLs them, so one that handles TERM gets to', () => {
    const termed = join(scratchDir(), 'termed');
    shardWith(`(trap "echo termed >> ${termed}; exit 0" TERM; ${record()}; ${SPIN})`);
    expect(existsSync(termed) ? readFileSync(termed, 'utf8').trim() : 'KILLed without a TERM').toBe('termed');
  }, 30_000);

  // The sleep puts at least 5 clock ticks between the subshell's start and record()'s substitution, so the old
  // `echo $BASHPID $(cut … /proc/$BASHPID/stat)` fails this on an idle machine too.
  it('record() stores the recording shell\'s own start time (what proc_start reads), not its substitution\'s', () => {
    const lines = sh(`for k in $(seq 1 50); do (q=$BASHPID; sleep 0.05; ${record()}; echo "$q $(proc_start $q)"; sleep 0.2) & done; wait`)
      .split('\n').map((l) => l.trim()).sort();
    const recorded = readFileSync(join(scratchDir(), 'spawned'), 'utf8').trim().split('\n').map((l) => l.trim()).sort();
    expect(recorded).toEqual(lines);
  }, 30_000);
});

describe('sweep_dead_runs', () => {
  it('removes a run whose owner is dead; keeps a live one, another boot id made since this boot, another pid namespace, an old record and a symlink', () => {
    const dead = deadRun();
    const live = mkdtempSync(join(scratchDir(), 'isaflow-ci-int.'));
    const v = victim(); settle(v);
    writeFileSync(join(live, 'owner'), `${v} ${start(v)} ${sh('my_pidns')} ${sh('boot_id')}\n`);
    const foreign = mkdtempSync(join(scratchDir(), 'isaflow-ci-int.'));
    // Its pid means nothing here: from this namespace it looks like an exited process.
    const exited = Number(sh('bash -c \'echo $$\''));
    writeFileSync(join(foreign, 'owner'), `${exited} 1 pid:[1] ${sh('boot_id')}\n`);
    const otherBoot = mkdtempSync(join(scratchDir(), 'isaflow-ci-int.'));
    writeFileSync(join(otherBoot, 'owner'), `${exited} 1 ${sh('my_pidns')} 00000000-0000-0000-0000-000000000000\n`);
    const legacy = mkdtempSync(join(scratchDir(), 'isaflow-ci-int.'));
    writeFileSync(join(legacy, 'owner'), `${exited}\n`);
    // A link named like a run, to a directory that would otherwise be swept.
    const target = mkdtempSync(join(scratchDir(), 'elsewhere-'));
    writeFileSync(join(target, 'owner'), `${exited} 1 ${sh('my_pidns')} ${sh('boot_id')}\n`);
    const link = join(scratchDir(), 'isaflow-ci-int.linked');
    symlinkSync(target, link);
    sh('sweep_dead_runs > /dev/null');
    expect([dead, live, foreign, otherBoot, legacy, link, target].map((d) => existsSync(d)))
      .toEqual([false, true, true, true, true, true, true]);
  });

  it('leaves a run from another pid namespace alone however old, and says so (whether it lives cannot be told)', () => {
    const old = mkdtempSync(join(scratchDir(), 'isaflow-ci-int.'));
    writeFileSync(join(old, 'owner'), `27 1 pid:[1] ${sh('boot_id')}\n`);
    const said = sh('date() { echo $(( $(command date +%s) + 90000 )); }; sweep_dead_runs');
    expect({ dir: existsSync(old), said: said.includes('left alone') && said.includes('other pid namespace') })
      .toEqual({ dir: true, said: true });
  });

  it('deletes, without signalling, a run from another boot id made before this boot began', () => {
    const v = victim(); settle(v);
    const old = mkdtempSync(join(scratchDir(), 'isaflow-ci-int.'));
    writeFileSync(join(old, 'owner'), `${v} ${start(v)} ${sh('my_pidns')} 00000000-0000-0000-0000-000000000000\n`);
    mkdirSync(join(old, 'c3'));
    writeFileSync(join(old, 'c3', 'sid'), `${v} ${start(v)}\n`);
    // This boot "began" after the directory was made.
    sh('boot_time() { echo $(( $(date +%s) + 60 )); }; sweep_dead_runs > /dev/null');
    expect({ dir: existsSync(old), victim: alive(v) }).toEqual({ dir: false, victim: true });
  });
});

describe('pg_cluster_stop on a live postmaster', () => {
  it('stops the postmaster pg_cluster_start started, and not one whose start time differs', () => {
    const dir = mkdtempSync(join(scratchDir(), 'cluster-'));
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
