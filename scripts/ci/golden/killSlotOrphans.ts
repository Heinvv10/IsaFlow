/**
 * Pre-step of the golden-paths job: stops a dev server a previous, timed-out job of THIS runner left listening in the
 * runner's own slot port window, so it cannot go on writing to the slot company while the new job uses it.
 *
 *   bun scripts/ci/golden/killSlotOrphans.ts <firstPort> <lastPort>
 *
 * The window is not exclusive: other worktrees' dev servers and docker-proxy listen inside 3300-3799. So a listener is
 * stopped only when it is a process of this runner's workspace (its cwd is under $GITHUB_WORKSPACE), by its exact pid
 * taken from `ss`, never by a name pattern and never for this process or one of its ancestors. Discovery and stop
 * failures are fatal: selecting another port while the old process survives would let two jobs write the same slot.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readlinkSync } from 'node:fs';

export interface Listener { pid: number; port: number }

/** Listeners from `ss -ltnp` output. A line with no `pid=` (another user's process) yields nothing. */
export function parseListeners(ss: string): Listener[] {
  const out: Listener[] = [];
  for (const line of ss.split('\n')) {
    const cols = line.trim().split(/\s+/);
    if (cols[0] !== 'LISTEN') continue;
    const port = Number(/:(\d+)$/.exec(cols[3] ?? '')?.[1]);
    if (!Number.isInteger(port)) continue;
    for (const m of line.matchAll(/pid=(\d+)/g)) out.push({ pid: Number(m[1]), port });
  }
  return out;
}

/** Fewest path components a workspace may have: `/`, `/home` and `/home/runner` would match far more than one job's checkout. */
const MIN_WORKSPACE_DEPTH = 3;

/** Why `workspace` is too broad to tell this runner's processes from anyone's, or null when it is fine. */
export function workspaceProblem(workspace: string): string | null {
  if (workspace === '') return 'GITHUB_WORKSPACE is not set';
  const depth = workspace.split('/').filter(Boolean).length;
  if (!workspace.startsWith('/') || depth < MIN_WORKSPACE_DEPTH) {
    return `GITHUB_WORKSPACE "${workspace}" is not an absolute path of at least ${MIN_WORKSPACE_DEPTH} components, so a cwd under it would not identify this runner's processes`;
  }
  return null;
}

/** True when `cwd` is the workspace or inside it. A workspace that is too broad (workspaceProblem) matches nothing. */
export const inWorkspace = (cwd: string | null, workspace: string): boolean =>
  cwd !== null && workspaceProblem(workspace) === null && (cwd === workspace || cwd.startsWith(`${workspace.replace(/\/+$/, '')}/`));

/**
 * The pids to stop: listeners in [first, last] whose cwd is in the workspace, minus `protectedPids`.
 * @param cwdOf a process's cwd, or null when it cannot be read (then it is left alone)
 */
export function selectOrphans(
  listeners: Listener[], first: number, last: number, workspace: string, cwdOf: (pid: number) => string | null, protectedPids: ReadonlySet<number>,
): number[] {
  const pids = new Set<number>();
  for (const l of listeners) {
    if (l.port < first || l.port > last || protectedPids.has(l.pid)) continue;
    if (inWorkspace(cwdOf(l.pid), workspace)) pids.add(l.pid);
  }
  return [...pids];
}

const procCwd = (pid: number): string | null => { try { return readlinkSync(`/proc/${pid}/cwd`); } catch { return null; } };
export const startTimeOf = (pid: number): string | null => {
  try {
    const fields = readFileSync(`/proc/${pid}/stat`, 'utf8').replace(/^.*\) /, '').split(/\s+/);
    return fields[19] || null;
  } catch { return null; }
};
export const parentOf = (pid: number): number | null => {
  try { return Number(/^\d+ \(.*\) \S (\d+) /.exec(readFileSync(`/proc/${pid}/stat`, 'utf8'))?.[1]) || null; } catch { return null; }
};
export function selfAndAncestors(): Set<number> {
  const seen = new Set<number>();
  for (let pid: number | null = process.pid; pid && !seen.has(pid); pid = parentOf(pid)) seen.add(pid);
  return seen;
}
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const say = (line: string): void => { process.stdout.write(`${line}\n`); };

/** The process operations stopOrphan uses, so a test can stand in for them. */
export interface ProcessOps { cwdOf(pid: number): string | null; startTimeOf(pid: number): string | null; alive(pid: number): boolean; kill(pid: number, signal: 'SIGTERM' | 'SIGKILL'): void; sleep(ms: number): Promise<void> }
const realOps: ProcessOps = { cwdOf: procCwd, startTimeOf, alive, kill: (pid, signal) => process.kill(pid, signal), sleep };

/**
 * SIGTERM, then SIGKILL after 5 s. The pid was chosen by cwd a moment ago, but a pid can be reused: its cwd is read
 * again before each signal and the process is left alone when it is no longer in the workspace.
 * @returns 'stopped', or 'reused' when the pid no longer belongs to the workspace
 */
export async function stopOrphan(pid: number, workspace: string, ops: ProcessOps = realOps): Promise<'stopped' | 'reused'> {
  const startTime = ops.startTimeOf(pid);
  const stillOriginal = (): boolean => startTime !== null && ops.startTimeOf(pid) === startTime && inWorkspace(ops.cwdOf(pid), workspace);
  if (!stillOriginal()) return 'reused';
  ops.kill(pid, 'SIGTERM');
  for (let i = 0; i < 25 && ops.alive(pid); i++) await ops.sleep(200);
  if (ops.alive(pid)) {
    if (!stillOriginal()) return 'reused';
    ops.kill(pid, 'SIGKILL');
    for (let i = 0; i < 10 && ops.alive(pid); i++) await ops.sleep(100);
    if (ops.alive(pid) && stillOriginal()) throw new Error(`pid ${pid} is still alive after SIGKILL`);
  }
  return 'stopped';
}

export interface CleanupOptions {
  listListeners?: () => string;
  cwdOf?: (pid: number) => string | null;
  protectedPids?: ReadonlySet<number>;
  stop?: (pid: number, workspace: string) => Promise<'stopped' | 'reused'>;
  say?: (line: string) => void;
}

export async function cleanupSlotOrphans(first: number, last: number, workspace: string, options: CleanupOptions = {}): Promise<void> {
  const problem = workspaceProblem(workspace);
  if (problem) throw new Error(problem);
  const report = options.say ?? say;
  const cwdOf = options.cwdOf ?? procCwd;
  const listeners = parseListeners((options.listListeners ?? (() => execFileSync('ss', ['-ltnp'], { encoding: 'utf8' })))());
  const victims = selectOrphans(listeners, first, last, workspace, cwdOf, options.protectedPids ?? selfAndAncestors());
  for (const pid of victims) {
    const port = listeners.find((l) => l.pid === pid)!.port;
    report(`killSlotOrphans: stopping pid ${pid} (listening on ${port}, cwd ${cwdOf(pid)}), left behind by an earlier job of this runner`);
    if (await (options.stop ?? stopOrphan)(pid, workspace) === 'reused') {
      report(`killSlotOrphans: pid ${pid} is no longer a process of this workspace, left alone`);
    }
  }
  if (victims.length === 0) report(`killSlotOrphans: nothing of this workspace listens on ${first}-${last}`);
}

async function main(): Promise<void> {
  const [first, last] = process.argv.slice(2, 4).map(Number);
  if (!Number.isInteger(first) || !Number.isInteger(last) || first! > last!) throw new Error('usage: killSlotOrphans.ts <firstPort> <lastPort>');
  await cleanupSlotOrphans(first!, last!, process.env.GITHUB_WORKSPACE ?? '');
}

if (import.meta.main) {
  main().then(() => process.exit(0), (err: unknown) => { process.stderr.write(`killSlotOrphans: ${(err as Error).message}\n`); process.exit(1); });
}
