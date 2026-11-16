/**
 * The CLI body shared by scripts/reseed-demo-company.ts and the retired seeders
 * that now delegate to it (seed-demo-data.ts, seed-payroll-data.ts,
 * seed-practice-data.ts): parse, print the target (never the password), run.
 */

import { execFileSync } from 'child_process';
import { log } from '../../../src/lib/logger';
import { Refusal, describeTarget, parseArgs, resolveDbUrl } from './cli';
import { DB_URL_ENV, DEMO_MONTHS_BACK, DEMO_MONTHS_FORWARD } from './constants';
import { runReseed } from './run';

function gitSha(): string {
  try {
    return execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch (err) {
    log.warn('reseed: no git SHA for the run record', { message: (err as Error).message }, 'demo-reseed');
    return 'unknown';
  }
}

export async function reseedMain(argv: readonly string[], env: Readonly<Record<string, string | undefined>>, out: (s: string) => void): Promise<number> {
  let args;
  let url;
  try {
    args = parseArgs(argv);
    url = resolveDbUrl(env);
    out(`target: ${describeTarget(url)} (from ${DB_URL_ENV})`);
  } catch (err) {
    if (err instanceof Refusal) { out(`REFUSED: ${err.message}`); return 2; }
    throw err;
  }
  out(`mode: ${args.mode}; months back ${DEMO_MONTHS_BACK}, months forward ${DEMO_MONTHS_FORWARD}`);
  return (await runReseed({ ...args, url, out, gitSha: gitSha() })).exitCode;
}

/** Run as a process: exit with the run's code; any error is reported as rolled back. */
export function runAsProcess(notice?: string): void {
  const out = (line: string): void => { process.stdout.write(`${line}\n`); };
  if (notice) out(notice);
  reseedMain(process.argv.slice(2), process.env, out).then((code) => process.exit(code), (err: unknown) => {
    out(`FAILED (rolled back, nothing changed): ${(err as Error).message}`);
    log.error('demo reseed failed', { message: (err as Error).message }, 'demo-reseed');
    process.exit(1);
  });
}
