/**
 * The dev server the rubric harness is pointed at, as the server itself sees its config (master plan wave 4, MW).
 *
 * The server is found, not configured: the one process listening on the port. Its database config is then rebuilt the
 * way Next dev builds it: that process's own env (/proc/<pid>/environ) first, then the env files of its project dir,
 * by the server tree's own @next/env, run in a child process whose env IS the server's environ (so neither @next/env's
 * module state nor this process's env takes part). The pure judgement is _rubricDatabaseGuard.ts.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { assertDevDatabases, assertProjectDirs, parseProcEnviron } from './_rubricDatabaseGuard';
import { RubricGuardError, listenerPids } from './_rubricGuard';

/** The @next/env that `serverDir`'s own `next` loads. */
export function nextEnvModule(serverDir: string): string {
  const nextPackage = createRequire(join(serverDir, 'package.json')).resolve('next/package.json');
  return createRequire(nextPackage).resolve('@next/env');
}

/** Run in the child: argv ends with the @next/env path and the project dir; prints the *DATABASE_URL* keys as JSON. */
const LOADER = `
const [mod, dir] = process.argv.slice(-2);
const { loadEnvConfig } = require(mod);
const log = { info() {}, error(...args) { process.stderr.write(args.join(' ') + '\\n'); } };
const { combinedEnv } = loadEnvConfig(dir, true, log, true);
const out = {};
for (const [key, value] of Object.entries(combinedEnv)) if (key.includes('DATABASE_URL')) out[key] = value;
process.stdout.write(JSON.stringify(out));
`;

/**
 * Every *DATABASE_URL* key a Next dev server in `serverDir`, started with `environ`, sees. NODE_ENV defaults to
 * development, as `next dev` sets it before it loads the env files. The forked server's IPC channel (NODE_CHANNEL_*) is
 * dropped: in the child it names an fd that is no pipe, and node aborts. NODE_OPTIONS is kept: an `--env-file` there
 * loads into the child as it did into the server.
 */
export function serverDatabaseEnv(serverDir: string, environ: Record<string, string>, nextEnv = nextEnvModule(serverDir)):
  Record<string, string | undefined> {
  const env: NodeJS.ProcessEnv = { NODE_ENV: 'development' };
  for (const [key, value] of Object.entries(environ)) if (!key.startsWith('NODE_CHANNEL_')) env[key] = value;
  if (!env.NODE_ENV) env.NODE_ENV = 'development';
  try {
    const out = execFileSync(process.execPath, ['-e', LOADER, nextEnv, serverDir], { env, cwd: serverDir, encoding: 'utf8', stdio: 'pipe' });
    return JSON.parse(out) as Record<string, string | undefined>;
  } catch (err) {
    const stderr = String((err as { stderr?: unknown }).stderr ?? '').trim().split('\n').slice(-3).join(' | ');
    throw new RubricGuardError(`could not rebuild the server's env with ${nextEnv}: ${stderr || (err as Error).message.split('\n')[0]}`);
  }
}

const cmdline = (pid: number): string[] => readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
const parentOf = (pid: number): number => Number(/^PPid:\s+(\d+)/m.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1] ?? 0);

/** The listener and up to 5 ancestors (the `next dev` CLI that forked it among them), as far as /proc lets us read. */
function processChain(pid: number): Array<{ argv: string[]; cwd: string }> {
  const chain: Array<{ argv: string[]; cwd: string }> = [];
  let p = pid;
  while (p > 1 && chain.length < 6) {
    try {
      chain.push({ argv: cmdline(p), cwd: readlinkSync(`/proc/${p}/cwd`) });
      p = parentOf(p);
    } catch (err) {
      if (chain.length === 0) throw err; // the listener itself must be readable
      break; // another user's process: the chain above it is not this server's
    }
  }
  return chain;
}

export interface DevServer { pid: number; serverDir: string; databaseUrl: string; databaseKeys: string[] }

/** The one server on `port`, refused unless its project dir is its cwd and every *DATABASE_URL* it sees is dev. */
export function checkServer(port: number): DevServer {
  const ss = execFileSync('ss', ['-ltnpH', `sport = :${port}`], { encoding: 'utf8' });
  const pids = listenerPids(ss, port);
  if (pids.length !== 1) throw new RubricGuardError(`expected one process listening on :${port}, found ${pids.length}`);
  const pid = pids[0]!;
  const serverDir = readlinkSync(`/proc/${pid}/cwd`);
  assertProjectDirs(processChain(pid), serverDir);
  const env = serverDatabaseEnv(serverDir, parseProcEnviron(readFileSync(`/proc/${pid}/environ`, 'utf8')));
  const databaseKeys = assertDevDatabases(env);
  return { pid, serverDir, databaseUrl: env.DATABASE_URL!, databaseKeys };
}
