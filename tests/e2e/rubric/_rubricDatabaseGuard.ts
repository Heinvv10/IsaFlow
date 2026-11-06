/**
 * The rubric harness's database guard (master plan wave 4, MW). Pure, like _rubricGuard.ts: every refusal is unit-tested
 * (tests/unit/e2e/rubricDatabaseGuard.test.ts). The runtime half that feeds it is _rubricServerEnv.ts.
 *
 * What is judged is what the dev server itself connects with: EVERY key containing DATABASE_URL in the env Next dev
 * builds (the process env first, then `.env.development.local`, `.env.local`, `.env.development`, `.env`). The app reads
 * `SERVICE_DATABASE_URL || DATABASE_URL`, plus PLATFORM_ADMIN_ and MIGRATION_ADMIN_DATABASE_URL, so one prod key beside
 * a dev DATABASE_URL is enough to write to production. Each must be dev Supabase, isaflow_dev, with no query parameter
 * that could move the connection (pg-connection-string reads `host`, `port`, `options`... from the query string).
 */
import { resolve } from 'node:path';
import { parse as pgParse } from 'pg-connection-string';
import { RubricGuardError } from './_rubricGuard';

export const DEV_DATABASE = 'isaflow_dev';
/**
 * Dev Supabase (the IsaFlow stack on velo-server), hardcoded. Named limit: if the dev database moves, the guard refuses
 * every server (it fails closed) until these and DEV_DB_SERVER_PORT are updated by hand.
 */
export const DEV_DB_HOST = '100.96.203.105';
export const DEV_DB_PORT = 7772;
/**
 * What the dev stack's Postgres reports as `inet_server_port()` behind the 7772 mapping (measured 2026-11-06). The
 * container port, not 7772: a connected server cannot report the host-side port, so this pins the server instead.
 */
export const DEV_DB_SERVER_PORT = 5436;
/** Query parameters that cannot move the connection. Anything else (host, hostaddr, port, options, dbname...) is refused. */
const SAFE_PARAMS: readonly string[] = ['sslmode', 'application_name', 'connect_timeout'];

/** One postgres URL is dev: host and port pinned, database isaflow_dev, as both the WHATWG parser and pg read it. */
export function assertDevDatabase(databaseUrl: string | undefined, key = 'DATABASE_URL'): void {
  const refuse = (why: string): never => { throw new RubricGuardError(`${key}: ${why}`); };
  if (!databaseUrl) return refuse('is empty (pg would connect to its defaults)');
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    return refuse('is not a URL');
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') return refuse(`must be postgres, got ${url.protocol}`);
  for (const name of url.searchParams.keys()) {
    if (!SAFE_PARAMS.includes(name)) refuse(`query parameter "${name}" is refused (only ${SAFE_PARAMS.join(', ')})`);
  }
  if (url.hostname !== DEV_DB_HOST) refuse(`host is "${url.hostname}", not ${DEV_DB_HOST}`);
  if (url.port !== String(DEV_DB_PORT)) refuse(`port is "${url.port || 'default'}", not ${DEV_DB_PORT}`);
  const name = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (name !== DEV_DATABASE) refuse(`database is "${name}", not ${DEV_DATABASE}`);
  // The parser pg uses, in case it reads the URL differently from WHATWG.
  const pg = pgParse(databaseUrl);
  if (pg.host !== DEV_DB_HOST || String(pg.port) !== String(DEV_DB_PORT) || pg.database !== DEV_DATABASE) {
    refuse(`pg reads it as ${pg.host ?? '?'}:${pg.port ?? '?'}/${pg.database ?? '?'}`);
  }
}

/** Judges every *DATABASE_URL* key; DATABASE_URL itself must be there. @returns the keys judged, sorted. */
export function assertDevDatabases(env: Record<string, string | undefined>): string[] {
  const keys = Object.keys(env).filter((k) => k.includes('DATABASE_URL')).sort();
  if (!keys.includes('DATABASE_URL')) throw new RubricGuardError('the server has no DATABASE_URL');
  for (const key of keys) assertDevDatabase(env[key], key);
  return keys;
}

/** What `SELECT current_database(), inet_server_port()` said on the connection the harness writes through. */
export function assertConnectedDev(row: { database: string; port: number }): void {
  if (row.database !== DEV_DATABASE) throw new RubricGuardError(`connected to "${row.database}", not ${DEV_DATABASE}`);
  if (Number(row.port) !== DEV_DB_SERVER_PORT) {
    throw new RubricGuardError(`connected to server port ${row.port}, not the dev stack's ${DEV_DB_SERVER_PORT}`);
  }
}

/** /proc/<pid>/environ: NUL-separated KEY=VALUE. */
export function parseProcEnviron(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of text.split('\0')) {
    const eq = entry.indexOf('=');
    if (eq > 0) out[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return out;
}

/** `next dev|start` flags that take a value (so the value is not the project dir). */
const VALUE_FLAGS = ['-p', '--port', '-H', '--hostname', '--keepAliveTimeout', '--experimental-https-key',
  '--experimental-https-cert', '--experimental-https-ca', '--experimental-upload-trace'];
/** The next CLI as a token: `next`, `.../.bin/next`, `.../next/dist/bin/next.js`. */
const NEXT_BIN = /(^|\/)next(\.js)?$/;

/**
 * The next CLI a command line runs: its subcommand (the word after the CLI; undefined when a flag or nothing follows, as in a bare `next`)
 * and, for `dev|start`, the project dir it names. Arguments are split on whitespace too, so `sh -c "next dev ../x"` is
 * read. An unknown flag's value reads as a dir: fails closed.
 */
export function nextCommand(argv: readonly string[]): { command?: string; dir?: string } | undefined {
  const tokens = argv.flatMap((a) => a.split(/\s+/)).filter(Boolean);
  const isCli = (i: number) => NEXT_BIN.test(tokens[i]!);
  const isWord = (i: number) => /^[a-z][a-z-]*$/.test(tokens[i] ?? '');
  // The first next CLI followed by a subcommand (`cd /x/next && next dev` is `next dev`), else the first next CLI.
  let bin = tokens.findIndex((_, i) => isCli(i) && isWord(i + 1));
  if (bin < 0) bin = tokens.findIndex((_, i) => isCli(i));
  if (bin < 0) return undefined;
  const command = isWord(bin + 1) ? tokens[bin + 1] : undefined;
  if (command !== 'dev' && command !== 'start') return { command };
  for (let i = bin + 2; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (/^[0-9]*[<>|&;]/.test(t)) break; // a shell operator or redirect ends the command
    if (VALUE_FLAGS.includes(t)) { i++; continue; }
    if (t.startsWith('-')) continue;
    return { command, dir: t };
  }
  return { command };
}

/** The project dir a `next dev|start` command line names, or undefined (none named, or not a next CLI). */
export const nextProjectDir = (argv: readonly string[]): string | undefined => nextCommand(argv)?.dir;

/**
 * The listener's process chain is a `next dev` server whose project dir is its cwd. `next start` (or any other next
 * subcommand) is refused: it loads `.env.production*`, which the env rebuild models only in depth. A chain where no
 * `next dev` can be read (a custom server, a bare `next`, an ancestor /proc would not show) is refused too.
 */
export function assertProjectDirs(chain: ReadonlyArray<{ argv: readonly string[]; cwd: string }>, serverDir: string): void {
  let dev = false;
  for (const { argv, cwd } of chain) {
    const cli = nextCommand(argv);
    if (!cli?.command) continue; // not a next CLI, or one whose subcommand cannot be read: no next dev seen here
    if (cli.command !== 'dev') {
      throw new RubricGuardError(`the server was started with "next ${cli.command}" ("${argv.join(' ')}"); only next dev is allowed`);
    }
    dev = true;
    if (cli.dir !== undefined && resolve(cwd, cli.dir) !== resolve(serverDir)) {
      throw new RubricGuardError(`project dir ${resolve(cwd, cli.dir)} (from "${argv.join(' ')}") is not the server's cwd ${serverDir}`);
    }
  }
  if (!dev) throw new RubricGuardError(`no "next dev" in the listener's process chain (${chain.map((c) => c.argv.join(' ')).join(' <- ')})`);
}
