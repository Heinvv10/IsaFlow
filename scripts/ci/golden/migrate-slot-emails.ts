/**
 * Moves the Golden Paths slot users and the other known test/QA logins from @isaflow.dev (no DNS records: whoever
 * registered the domain could receive their password-reset mail) to @isaflow.co.za, IN PLACE: the GoTrue user keeps its id,
 * so memberships and data stay.
 *
 *   bun scripts/ci/golden/migrate-slot-emails.ts [--dry-run] [--env-file <path>] [--w6-env-file <path>]
 *
 * For each known account (slotEmailPlan.ts knownAccounts) it changes the GoTrue email (admin API), the `users` row and, for
 * slots, the slot company's contact email, all on isaflow_dev; then rewrites every line of the CI env file (default
 * /home/hein/isaflow-ci.env) and of the wave-6 QA env file whose WHOLE value is a known old address (keys only; values are
 * never printed; mode, owner and group kept, as provision-slots.ts does). Idempotent: an account already on the new address
 * has no steps. A conflict (the new address already held by another GoTrue user, a users row that disagrees with GoTrue)
 * refuses the whole run before anything is written. Addresses on the old domain that no code knows are listed and never touched.
 *
 * Run it BEFORE provision-slots.ts / provision-w6-qa.ts: those now create the @isaflow.co.za addresses, which would otherwise
 * be new accounts beside the old ones. --dry-run reads GoTrue and isaflow_dev and writes nothing.
 *
 * Same guards and sources as provision-slots.ts: only isaflow_dev (by url and by current_database()), only the GoTrue pinned
 * in slotConfig.ts (shared with production), GOTRUE_URL / SUPABASE_SERVICE_ROLE_KEY / the database url from the env or the env file.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { applyPlan, findUnknownLegacy, readAccountState, realGoTrueOps, type Db, type GoTrueOps } from './slotEmailApply';
import { formatPlan, knownAccounts, planAccount, planEnvRewrite } from './slotEmailPlan';
import { assertConnectedToDev, assertDevDatabaseUrl, assertGoTrueUrl, parseEnvFile } from './slotConfig';
import { writeEnvFileAtomic } from './slotEnvFile';

const DEFAULT_ENV_FILE = '/home/hein/isaflow-ci.env';
const DEFAULT_W6_ENV_FILE = join(homedir(), '.secrets', 'isaflow-dev-golden-qa.env');

export interface Io {
  processEnv: Record<string, string | undefined>;
  connect(url: string): Promise<Db & { end(): Promise<void> }>;
  /** Called with the checked GoTrue url and service key before any GoTrue call (the real facade reads process.env). */
  useGoTrue(url: string, serviceKey: string): GoTrueOps;
  say(line: string): void;
}

/** @returns the process exit code: 1 when a conflict refused the run. */
export async function main(argv: string[], io: Io): Promise<number> {
  const option = (name: string): string | undefined => { const at = argv.indexOf(name); return at >= 0 ? argv[at + 1] : undefined; };
  const dryRun = argv.includes('--dry-run');
  const envFile = option('--env-file') ?? DEFAULT_ENV_FILE;
  const w6EnvFile = option('--w6-env-file') ?? DEFAULT_W6_ENV_FILE;
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
    io.say(`database ${dbName}${dryRun ? ' (dry run: nothing is written)' : ''}`);
    const accounts = knownAccounts();
    const plans = [];
    for (const a of accounts) plans.push(planAccount(a, await readAccountState(db, gt, a)));
    for (const p of plans) io.say(formatPlan(p));
    const unknown = await findUnknownLegacy(db, gt, accounts);
    for (const e of unknown.gotrue) io.say(`UNKNOWN GoTrue account on the old domain, untouched: ${e}`);
    for (const e of unknown.users) io.say(`UNKNOWN users row on the old domain, untouched: ${e}`);

    const envFiles = [envFile, w6EnvFile].filter((f) => existsSync(f)).map((f) => ({ file: f, rewrite: planEnvRewrite(readFileSync(f, 'utf8'), accounts) }));
    for (const { file, rewrite } of envFiles) {
      if (rewrite.changedKeys.length) io.say(`${file}: ${dryRun ? 'would rewrite' : 'rewriting'} ${rewrite.changedKeys.join(', ')}`);
      if (rewrite.unrecognisedKeys.length) io.say(`${file}: keys mentioning the old domain that are not a known account address, untouched: ${rewrite.unrecognisedKeys.join(', ')}`);
    }

    if (plans.some((p) => p.action === 'conflict')) {
      io.say('REFUSED: a conflict above; nothing was written');
      return 1;
    }
    if (dryRun) { io.say('dry run: nothing written'); return 0; }
    for (const p of plans) {
      await applyPlan(db, gt, p);
      if (p.action === 'migrate') io.say(`${p.account.label}: migrated to ${p.account.newEmail}`);
    }
    for (const { file, rewrite } of envFiles) {
      if (rewrite.changedKeys.length) writeEnvFileAtomic(file, rewrite.text);
    }
    io.say('done');
    return 0;
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
