/**
 * Moves the Golden Paths slot users and the other known test/QA logins from @isaflow.dev (no DNS records: whoever
 * registered the domain could receive their password-reset mail) to @isaflow.co.za, IN PLACE: the GoTrue user keeps its id,
 * so memberships and data stay.
 *
 *   bun scripts/ci/golden/migrate-slot-emails.ts                 # dry run (the default): prints the plan, writes nothing
 *   bun scripts/ci/golden/migrate-slot-emails.ts --apply         # does it
 *   options: --env-file <path> (config source, default /home/hein/isaflow-ci.env), --deploy-env-file <path> (default
 *            /home/hein/isaflow-deploy.env), --secrets-dir <dir> (default ~/.secrets), --workspace-root <dir> (default
 *            /home/hein/Workspace), --allowed-root <dir> (default /home/hein: no file resolving elsewhere is written),
 *            --allow-unrecognised <file> (with --apply only; repeatable; accepts that one scanned file's problem)
 *
 * Any other argument, a flag missing its value, or a repeated one is refused before anything runs.
 *
 * For each known account (slotEmailPlan.ts knownAccounts) it changes the GoTrue email (admin API), the `users` row (exactly
 * one row, else rolled back) and, for slots, the slot company's contact email, all on isaflow_dev. After EACH account's commit
 * it rewrites, in every env file found (slotEmailEnv.ts: the CI env file, the deploy env file, ~/.secrets/*.env, every IsaFlow* checkout's and
 * IsaFlow_wt worktree's .env.local), each line whose WHOLE value is that account's old address (an `export ` prefix, quotes and
 * CRLF are kept; mode, owner, group and symlinks too). Only paths and key names are printed, never a value. Idempotent: an
 * account already on the new address has no steps, and a re-run still rewrites its env keys.
 *
 * Refusals, all before any write: a conflict (the new address held by another GoTrue user, a users row that disagrees with
 * GoTrue) stops the database and GoTrue steps (keys of accounts already migrated are still rewritten); a line in a scanned file
 * that still mentions @isaflow.dev but cannot be rewritten (unknown address, half-quoted, in a comment, an unreadable file, a
 * file that resolves outside the allowed root) refuses --apply unless --allow-unrecognised names that file. Old-domain addresses no code knows are listed and never touched.
 * Production `users` rows for these GoTrue ids, if any, are not touched (this script has no production access).
 *
 * Run it BEFORE provision-slots.ts / provision-w6-qa.ts: those now create the @isaflow.co.za addresses, which would otherwise
 * be new accounts beside the old ones.
 *
 * Same guards and sources as provision-slots.ts: only isaflow_dev (by url and by current_database()), only the GoTrue pinned
 * in slotConfig.ts (shared with production), GOTRUE_URL / SUPABASE_SERVICE_ROLE_KEY / the database url from the env or the env file.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { applyPlan, findUnknownLegacy, readAccountState, realGoTrueOps, type Db, type GoTrueOps } from './slotEmailApply';
import { discoverEnvFiles, rewriteEnvFiles, scanEnvFiles } from './slotEmailEnv';
import { formatPlan, knownAccounts, parseMigrationArgs, planAccount, type AccountPlan } from './slotEmailPlan';
import { assertConnectedToDev, assertDevDatabaseUrl, assertGoTrueUrl, parseEnvFile } from './slotConfig';

const DEFAULT_ENV_FILE = '/home/hein/isaflow-ci.env';
const DEFAULT_WORKSPACE_ROOT = '/home/hein/Workspace';
const DEFAULT_DEPLOY_ENV_FILE = '/home/hein/isaflow-deploy.env';
const DEFAULT_ALLOWED_ROOT = '/home/hein';
const PRODUCTION_NOTE = 'note: production `users` rows for these GoTrue ids, if any, keep the old address (not touched: this script has no production access)';

export interface Io {
  processEnv: Record<string, string | undefined>;
  connect(url: string): Promise<Db & { end(): Promise<void> }>;
  /** Called with the checked GoTrue url and service key before any GoTrue call (the real facade reads process.env). */
  useGoTrue(url: string, serviceKey: string): GoTrueOps;
  say(line: string): void;
}

/** @returns the process exit code: 1 when a conflict or an unrecognised line refused (part of) the run. */
export async function main(argv: string[], io: Io): Promise<number> {
  const args = parseMigrationArgs(argv);
  const envFile = args.envFile ?? DEFAULT_ENV_FILE;
  if (!existsSync(envFile)) throw new Error(`env file ${envFile} not found`);
  const fileEnv = parseEnvFile(readFileSync(envFile, 'utf8'));
  const get = (k: string): string | undefined => io.processEnv[k] || fileEnv[k] || undefined;

  const dbUrl = get('MIGRATION_ADMIN_DATABASE_URL') ?? get('DATABASE_URL');
  if (!dbUrl) throw new Error('MIGRATION_ADMIN_DATABASE_URL or DATABASE_URL is not set');
  assertDevDatabaseUrl(dbUrl);
  const gotrueUrl = get('GOTRUE_URL');
  assertGoTrueUrl(gotrueUrl);
  const serviceKey = get('SUPABASE_SERVICE_ROLE_KEY');
  if (!serviceKey) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set');
  const gt = io.useGoTrue(gotrueUrl!, serviceKey);

  const db = await io.connect(dbUrl);
  try {
    const dbName = await assertConnectedToDev(db as { query(sql: string): Promise<{ rows: Array<{ db: string }> }> });
    io.say(`database ${dbName}${args.apply ? '' : ' (dry run, the default: nothing is written; --apply does it)'}`);
    const accounts = knownAccounts();
    const plans: AccountPlan[] = [];
    for (const a of accounts) plans.push(planAccount(a, await readAccountState(db, gt, a)));
    for (const p of plans) io.say(formatPlan(p));
    const unknown = await findUnknownLegacy(db, gt, accounts);
    for (const e of unknown.gotrue) io.say(`UNKNOWN GoTrue account on the old domain, untouched: ${e}`);
    for (const e of unknown.users) io.say(`UNKNOWN users row on the old domain, untouched: ${e}`);

    const allowedRoot = args.allowedRoot ?? DEFAULT_ALLOWED_ROOT;
    const paths = discoverEnvFiles({
      envFile, deployEnvFile: args.deployEnvFile ?? DEFAULT_DEPLOY_ENV_FILE, secretsDir: args.secretsDir ?? join(homedir(), '.secrets'),
      workspaceRoot: args.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT,
    });
    const scans = scanEnvFiles(paths, accounts, allowedRoot);
    const real = (p: string): string => { try { return realpathSync(p); } catch { return p; } };
    const allowedReal = new Set(args.allowUnrecognised.map(real));
    const scannedReal = new Set(scans.map((x) => real(x.path)));
    for (const a of args.allowUnrecognised) if (!scannedReal.has(real(a))) throw new Error(`--allow-unrecognised ${a}: not a scanned env file (see the "env files checked" list of a dry run)`);
    io.say(`env files checked: ${scans.length}`);
    const blocked: string[] = [];
    for (const { path, unreadable, outside, rewrite } of scans) {
      let problem = false;
      if (unreadable) { io.say(`${path}: cannot be read; it may hold an old address`); problem = true; }
      if (outside) { io.say(`${path}: resolves outside ${allowedRoot}, will not be written`); problem = true; }
      if (rewrite) {
        if (rewrite.changedKeys.length && !outside) io.say(`${path}: ${args.apply ? 'will rewrite' : 'would rewrite'} ${rewrite.changedKeys.join(', ')}`);
        if (rewrite.unrecognised.length) { io.say(`${path}: still mentions the old domain, would not be rewritten: ${rewrite.unrecognised.join(', ')}`); problem = true; }
      }
      if (problem && !allowedReal.has(real(path))) blocked.push(path);
    }
    const unrecognised = blocked.length;
    io.say(PRODUCTION_NOTE);
    const conflict = plans.some((p) => p.action === 'conflict');

    if (!args.apply) {
      if (unrecognised) io.say('--apply will refuse until those files are fixed by hand, or each is named with --allow-unrecognised <file> (it is then left as written)');
      if (conflict) io.say('REFUSED: a conflict above; --apply would write nothing to the database or GoTrue');
      io.say('dry run: nothing written');
      return conflict ? 1 : 0;
    }
    if (unrecognised) {
      io.say(`REFUSED: ${blocked.join(', ')} cannot be fully rewritten (see above); nothing was written. Fix by hand, or name each with --allow-unrecognised <file>`);
      return 1;
    }
    const rewriteKeys = (p: AccountPlan): void => {
      for (const c of rewriteEnvFiles(paths, [p.account], allowedRoot)) io.say(`${c.path}: rewrote ${c.keys.join(', ')}`);
    };
    if (conflict) io.say('REFUSED: a conflict above; nothing is written to the database or GoTrue');
    for (const p of plans) {
      if (conflict) { if (p.action === 'noop' && p.userId) rewriteKeys(p); continue; }
      await applyPlan(db, gt, p);
      if (p.action === 'migrate') io.say(`${p.account.label}: migrated to ${p.account.newEmail}`);
      if (p.action === 'migrate' || (p.action === 'noop' && p.userId)) rewriteKeys(p);
    }
    io.say(conflict ? 'finished with a conflict' : 'done');
    return conflict ? 1 : 0;
  } finally {
    await db.end();
  }
}

if (process.argv[1]?.endsWith('migrate-slot-emails.ts')) {
  const io: Io = {
    processEnv: process.env,
    connect: async (url) => { const c = new pg.Client({ connectionString: url }); await c.connect(); return c as unknown as Db & { end(): Promise<void> }; },
    useGoTrue: (url, key) => { process.env.GOTRUE_URL = url; process.env.SUPABASE_SERVICE_ROLE_KEY = key; return realGoTrueOps(); },
    say: (line) => { process.stdout.write(`${line}\n`); },
  };
  main(process.argv.slice(2), io).then((code) => process.exit(code), (err: unknown) => {
    process.stderr.write(`migrate-slot-emails failed: ${(err as Error).message}\n`);
    process.exit(1);
  });
}
