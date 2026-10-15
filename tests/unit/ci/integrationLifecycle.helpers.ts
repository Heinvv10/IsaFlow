/**
 * Shared by the integration gate's lifecycle tests: run the real shell
 * functions (scripts/ci/integration/lifecycle.sh via pg-cluster.sh) in a
 * scratch directory, against real processes.
 *
 * Cleanup kills ONLY processes a test started and recorded: its ChildProcess
 * handles, and pids that test-started shells wrote with `record()` (pid +
 * start time, re-checked before the kill). Never by matching command lines.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach } from 'vitest';

export const LIB = resolve('scripts/ci/integration/pg-cluster.sh');
export const SHARD = resolve('scripts/ci/integration/shard.sh');
let scratch = '';
const children: ChildProcess[] = [];

export const scratchDir = (): string => scratch;
const spawned = (): string => join(scratch, 'spawned');

/** Run bash with the gate's functions loaded; TMPDIR is the scratch dir. */
export function sh(script: string): string {
  return execFileSync('bash', ['-c', `set -u; source ${JSON.stringify(LIB)}; ${script}`], {
    encoding: 'utf8', env: { ...process.env, TMPDIR: scratch },
  }).trim();
}

/**
 * A shell fragment that records its own pid and start time for cleanup. The pid is read BEFORE the command
 * substitution: inside $(…) $BASHPID is that substitution's own child, whose start time is a tick later under load,
 * so the record never matched and the cleanup skipped the very process it was for (blind review, 2026-10-15).
 */
export const record = (): string => `p=$BASHPID; echo $p $(cut -d" " -f22 /proc/$p/stat) >> ${spawned()}`;

/** Spins without end for the tests' purposes, but stops by itself after 60 s should no cleanup ever reach it. */
export const SPIN = 'until=$(( SECONDS + 60 )); while [ $SECONDS -lt $until ]; do sleep 0.1; done';

/**
 * A loop that ignores TERM and forks a named child every 0.3 s. Each child restores TERM before it execs: an ignored
 * TERM survives exec, and children that kept it piled up through the TERM phase (3 -> 123 members, each snapshot
 * slower; isaflow-0b's measurement). Bounded, so a run killed before its cleanup cannot leak it for good: it stops forking after 60 s and its
 * children end after 120 s. Unbounded, leaked loops from killed runs once filled this machine with 21k sleeps, and
 * every ps the gate's cleanup takes slowed until these very tests timed out and leaked more (2026-10-15).
 */
export const FORKER_LOOP = (name: string): string =>
  `until=$(( SECONDS + 60 )); while [ $SECONDS -lt $until ]; do (trap - TERM; ${record()}; exec -a ${name} sleep 120) & sleep 0.3; done`;

/** Take over cleanup of a process started by a script under test ("pid start"). */
export function adopt(line: string): void {
  appendFileSync(spawned(), `${line.trim()}\n`);
}

/** A process in a session of its own (detached: setsid), as an unrelated tool shell would be. */
export function victim(): number {
  const child = spawn('sleep', ['600'], { stdio: 'ignore', detached: true });
  children.push(child);
  return child.pid!;
}

/** A detached child the test starts itself (its pid is cleaned up). */
export function detached(cmd: string): ChildProcess {
  const child = spawn('bash', ['-c', cmd], { stdio: 'ignore', detached: true });
  children.push(child);
  return child;
}

export const alive = (pid: number): boolean =>
  existsSync(`/proc/${pid}`) && !readFileSync(`/proc/${pid}/stat`, 'utf8').includes(') Z ');
export const start = (pid: number): string => sh(`proc_start ${pid}`);
/** proc_start without a shell: field 22 of /proc/<pid>/stat, '' when gone or a zombie (the cleanup reads hundreds). */
function procStart(pid: number): string {
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch {
    return ''; // no such process
  }
  const fields = stat.slice(stat.lastIndexOf(') ') + 2).split(' ');
  return fields[0] === 'Z' ? '' : fields[19] ?? '';
}
export const settle = (pid: number): void => {
  for (let i = 0; i < 50 && start(pid) === ''; i++) execFileSync('sleep', ['0.05']);
};

export function useScratch(): void {
  beforeEach(() => { scratch = mkdtempSync(join(tmpdir(), 'lifecycle-')); });
  afterEach(() => {
    let failure: unknown = null;
    const kill = (pid: number): void => {
      try {
        process.kill(pid, 'SIGKILL');
      } catch (err) {
        // Gone between the read and the kill: fine. Anything else is reported once the sweep has finished.
        if ((err as NodeJS.ErrnoException).code !== 'ESRCH') failure ??= err;
      }
    };
    // Only while node has not seen it exit: once reaped, its pid may already belong to someone else.
    for (const c of children.splice(0)) {
      if (c.pid && c.exitCode === null && c.signalCode === null && procStart(c.pid) !== '') kill(c.pid);
    }
    // A recorded forker can fork one more child while it is being killed, and
    // that child records itself a moment later: re-read and repeat until two
    // passes in a row, 0.2 s apart, find nothing of ours still running.
    for (let pass = 0, quiet = 0; pass < 40 && quiet < 2; pass++) {
      let found = false;
      const lines = existsSync(spawned()) ? readFileSync(spawned(), 'utf8').split('\n') : [];
      for (const line of lines) {
        const [pid, at] = line.trim().split(' ');
        if (pid && at && procStart(Number(pid)) === at) {
          found = true;
          kill(Number(pid));
        }
      }
      quiet = found ? 0 : quiet + 1;
      execFileSync('sleep', ['0.2']);
    }
    rmSync(scratch, { recursive: true, force: true });
    if (failure) throw failure;
  }, 60_000); // a forker leaks for good if this hook is cut short; it reads /proc directly, so it is fast anyway
}
