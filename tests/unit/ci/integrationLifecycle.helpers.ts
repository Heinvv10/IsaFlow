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
        if (pid && at && alive(Number(pid)) && start(Number(pid)) === at) {
          found = true;
          process.kill(Number(pid), 'SIGKILL');
        }
      }
      quiet = found ? 0 : quiet + 1;
      execFileSync('sleep', ['0.2']);
    }
    rmSync(scratch, { recursive: true, force: true });
  });
}
