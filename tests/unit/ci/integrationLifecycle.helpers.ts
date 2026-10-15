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

/** A shell fragment that records its own pid and start time for cleanup. */
export const record = (): string => `echo $BASHPID $(cut -d" " -f22 /proc/$BASHPID/stat) >> ${spawned()}`;

/**
 * A loop that ignores TERM and forks a named child every 0.3 s (the children inherit the ignored TERM: it survives
 * exec). Bounded, so a run killed before its cleanup cannot leak it for good: it stops forking after 60 s and its
 * children end after 120 s. Unbounded, leaked loops from killed runs once filled this machine with 21k sleeps, and
 * every ps the gate's cleanup takes slowed until these very tests timed out and leaked more (2026-10-15).
 */
export const FORKER_LOOP = (name: string): string =>
  `until=$(( SECONDS + 60 )); while [ $SECONDS -lt $until ]; do (${record()}; exec -a ${name} sleep 120) & sleep 0.3; done`;

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
    for (const c of children.splice(0)) if (c.pid && alive(c.pid)) process.kill(c.pid, 'SIGKILL');
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
          try {
            process.kill(Number(pid), 'SIGKILL');
          } catch (err) {
            // Gone between the read and the kill: fine. Anything else must not end the cleanup silently.
            if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err;
          }
        }
      }
      quiet = found ? 0 : quiet + 1;
      execFileSync('sleep', ['0.2']);
    }
    rmSync(scratch, { recursive: true, force: true });
  }, 60_000); // a forker leaks for good if this hook is cut short; it reads /proc directly, so it is fast anyway
}
