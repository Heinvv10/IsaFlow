/**
 * golden-free-port — prints a port in [lo, hi] that nothing listens on, for
 * the golden-paths job's `next dev`.
 *
 *   bun scripts/ci/golden-free-port.ts 3300 3799
 *   stdout: the port; exit 1 when no free port was found
 *
 * Why: velo's docker apps listen in 3300-3799 (credaflow-demo-app on 3310,
 * flowcap-daymark-app on 3400, ...). A random pick that landed on one let
 * `next dev` fail to bind while the other app answered /api/health 200, and
 * the job logged in to it: `golden-paths login failed: 400 "Bad request."`
 * (#939 twice, docs/changelog-2026-10-29, 2026-10-29).
 * "Free" is decided by binding the port the way `next dev -p` does (no host:
 * dual-stack ::), so a listener on 127.0.0.1 alone counts as taken. The port
 * is released before printing; the job also checks its dev server is alive.
 */
import { createServer } from 'node:net';
import { cleanupSlotOrphans } from './golden/killSlotOrphans';

// Next.js refuses fetch-spec "bad ports"; 3659 (apple-sasl) is the only one in
// this range and failed a boot on 2026-10-28.
export const BAD_PORTS = new Set([3659]);

export function canBind(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, () => srv.close(() => resolve(true)));
  });
}

export async function pickFreePort(
  lo: number,
  hi: number,
  isFree: (port: number) => Promise<boolean> = canBind,
  random: () => number = Math.random,
  tries = 50,
): Promise<number | null> {
  for (let i = 0; i < tries; i++) {
    const port = lo + Math.floor(random() * (hi - lo + 1));
    if (BAD_PORTS.has(port)) continue;
    if (await isFree(port)) return port;
  }
  return null;
}

type Cleanup = (lo: number, hi: number, workspace: string, options?: { say: (line: string) => void }) => Promise<void>;

/** CI repeats cleanup here because this command is not masked by the workflow's legacy `|| true`. */
export async function prepareSlotWindow(
  lo: number, hi: number, githubActions: boolean, workspace: string, cleanup: Cleanup = cleanupSlotOrphans,
): Promise<void> {
  if (githubActions) await cleanup(lo, hi, workspace, { say: (line) => process.stderr.write(`${line}\n`) });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const [lo, hi] = args.map((a) => (/^\d+$/.test(a) ? Number(a) : NaN));
  const valid = (p: number | undefined): p is number => p !== undefined && Number.isInteger(p) && p >= 1 && p <= 65535;
  if (args.length !== 2 || !valid(lo) || !valid(hi) || lo > hi) {
    process.stderr.write('usage: golden-free-port.ts <lo> <hi>  (1-65535, lo <= hi)\n');
    process.exit(2);
  }
  await prepareSlotWindow(lo, hi, process.env.GITHUB_ACTIONS === 'true', process.env.GITHUB_WORKSPACE ?? '');
  const port = await pickFreePort(lo, hi);
  if (port === null) {
    process.stderr.write(`no free port in ${lo}-${hi}\n`);
    process.exit(1);
  }
  process.stdout.write(`${port}\n`);
}

if (import.meta.main) void main();
