/**
 * CANCELLING THE INTEGRATION GATE ENDS EVERYTHING IT STARTED, IN AN ORDER THAT
 * LEAVES NOTHING BEHIND (run.sh cleanup = lifecycle.sh end_run / remove_run).
 *
 * Real shell functions, the real shard.sh and real processes, as in
 * integrationLifecycle.test.ts.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LIB, SHARD, adopt, alive, detached, record, scratchDir, sh, start, useScratch } from './integrationLifecycle.helpers';

useScratch();

const running = (name: string): string => sh(`ps -eo pid=,args= | awk -v n=${name} '$2 == n { print $1 }'`);
const waitGone = (pid: number, seconds: number): void => {
  for (let i = 0; i < seconds * 10 && alive(pid); i++) execFileSync('sleep', ['0.1']);
};

describe('hold_signals / release_signals', () => {
  it('notes a TERM while held and acts on it at release', () => {
    const r = spawnSync('bash', ['-c', `source ${LIB}; release_signals; hold_signals; kill -TERM $$; echo held; release_signals; echo not-reached`],
      { encoding: 'utf8' });
    expect({ out: r.stdout.trim(), status: r.status }).toEqual({ out: 'held', status: 143 });
  });
});

describe('launch_session', () => {
  it('records the new session leader by pid and start time, once it has called setsid', () => {
    const rec = join(scratchDir(), 'sid');
    const pid = Number(sh(`launch_session ${rec} sleep 600 < /dev/null > /dev/null 2>&1; echo $LAUNCHED`));
    const recorded = readFileSync(rec, 'utf8').trim();
    adopt(recorded);
    expect({ recorded, sid: sh(`proc_sid ${pid}`) }).toEqual({ recorded: `${pid} ${start(pid)}`, sid: String(pid) });
  });
});

describe('end_run', () => {
  it('finishes, run dir and all, when a TERM arrives in the middle of it', () => {
    const run = mkdtempSync(join(scratchDir(), 'isaflow-ci-int.'));
    mkdirSync(join(run, 'c1'));
    const out = sh(`pg_cluster_stop() { kill -TERM $$; sleep 0.2; }; end_run ${run}; echo finished`);
    expect({ out, dir: existsSync(run) }).toEqual({ out: 'finished', dir: false });
  });
});

describe('remove_run order', () => {
  it('TERMs the session before it stops the clusters, and gives a leader longer than its own cleanup', () => {
    const run = mkdtempSync(join(scratchDir(), 'isaflow-ci-int.'));
    mkdirSync(join(run, 'c1'));
    const log = join(scratchDir(), 'log');
    // The leader takes 12 s over its own exit (end_own_session's bound is about 11 s);
    // one member logs its TERM, one ignores TERM.
    const leader = detached(`${record()}; trap 'echo leader-term >> ${log}; sleep 12; echo leader-done >> ${log}; exit 0' TERM
      (trap "echo member-term >> ${log}; exit 0" TERM; ${record()}; while :; do sleep 0.1; done) &
      (trap "" TERM; ${record()}; while :; do sleep 0.1; done) &
      while :; do sleep 0.1; done`);
    for (let i = 0; i < 50 && sh(`proc_sid ${leader.pid}`) !== String(leader.pid); i++) execFileSync('sleep', ['0.05']);
    execFileSync('sleep', ['0.5']);
    writeFileSync(join(run, 'c1', 'sid'), `${leader.pid} ${start(leader.pid!)}\n`);
    // A bash trap runs once its current command returns (here within 0.1 s), so the
    // stand-in cluster stop takes 1 s: a TERM sent before it is logged before it.
    sh(`pg_cluster_stop() { sleep 1; echo stop >> ${log}; }; remove_run ${run}`);
    const lines = readFileSync(log, 'utf8').trim().split('\n');
    expect({
      termsBeforeStop: lines.indexOf('stop') > Math.max(lines.indexOf('member-term'), lines.indexOf('leader-term')),
      leaderFinished: lines.includes('leader-done'),
      sessionEmpty: sh(`session_pids ${leader.pid}`),
    }).toEqual({ termsBeforeStop: true, leaderFinished: true, sessionEmpty: '' });
  }, 60_000);
});

describe('a real shard signalled in the middle of its own cleanup', () => {
  it.each(['TERM', 'INT', 'HUP'])('still ends every leftover after a %s', (sig) => {
    const name = `cancel-forker-${process.pid}-${Date.now()}`;
    const work = mkdtempSync(join(scratchDir(), 'work-'));
    mkdirSync(join(work, 'c1'));
    writeFileSync(join(work, 'plan.tsv'), '');
    const shard = detached(`(trap "" TERM; ${record()}; while :; do (${record()}; exec -a ${name} sleep 600) & sleep 0.3; done) &
      sleep 0.3; exec bash ${SHARD} 1 1 0 ${work} x y`);
    execFileSync('sleep', ['2']); // the shard is in its EXIT trap, ending a TERM-ignoring forker
    process.kill(shard.pid!, `SIG${sig}`);
    waitGone(shard.pid!, 30);
    expect({ shardDone: !alive(shard.pid!), left: running(name) }).toEqual({ shardDone: true, left: '' });
  }, 60_000);
});
