/**
 * Provision the Golden Paths slots on isaflow_dev: three companies (golden-slot-1..3), each a copy of the Demo
 * company's setup data (no transactions), each with its own golden user as sole owner.
 *
 *   bun scripts/ci/golden/provision-slots.ts [--dry-run] [--verify] [--reset-slot <n>] [--seed-url <url>] [--env-file <path>]
 *
 * Idempotent. A slot company that exists is kept (its data is the suite's to grow); its user, membership, GoTrue
 * password and env keys are re-asserted. A company is created with its membership in ONE transaction, so a failure
 * leaves nothing half-made. --dry-run does everything in a transaction it rolls back and touches neither GoTrue nor
 * the env file. --verify only reads and prints each slot's preconditions and seed volume, and exits 1 when a slot lacks
 * one. --reset-slot n retires slot n's company (a poisoned one: a payroll run stuck in the sandbox month, say) and
 * builds a fresh generation under a new id, which replaces GOLDEN_SLOT_n_COMPANY_ID in the env file; nothing is
 * deleted. A reset needs --seed-url (a bare clone fails the volume specs).
 *
 * --seed-url <local dev server> then seeds each provisioned slot with transactions through the app's own routes
 * (seedSlotData.ts): 80 approved supplier invoices, 10 posted journals, a 200-row bank statement, a migration session.
 * Idempotent; the server must run from a checkout whose .env.local points at isaflow_dev.
 *
 * Writes GOLDEN_SLOT_n_COMPANY_ID / _EMAIL / _PASSWORD (n = 1..3) to the env file (default /home/hein/isaflow-ci.env,
 * which the golden-paths job reads the keys from). Passwords are never printed.
 *
 * Refuses any database but isaflow_dev (production is `isaflow` on the same host and port) and any GoTrue but the
 * one pinned in slotConfig.ts (it is shared with production).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import pg from 'pg';
import { rollbackFailed } from '../../../src/lib/rollbackFailed';
import {
  DEV_DATABASE, GOLDEN_SLOTS, SOURCE_COMPANY_ID, assertDevDatabaseUrl, assertResetSeeds, assertGoTrueUrl, generationOf, parseEnvFile,
  slotCompanyId, slotEmail, slotEnvKeys, upsertEnvKeys,
} from './slotConfig';
import { seedSlotViaApp } from './seedSlotClient';
import { writeEnvFileAtomic } from './slotEnvFile';
import { ensureCompany, ensureGoTrueUser, ensureUser, retireSlotCompany } from './slotProvision';
import { formatSlotReport, readSlotReport, seedProblems, slotProblems, slotWarnings } from './slotVerify';

const DEFAULT_ENV_FILE = '/home/hein/isaflow-ci.env';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const say = (line: string): void => { process.stdout.write(`${line}\n`); };

function flag(name: string): boolean { return process.argv.includes(name); }
function option(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

async function main(): Promise<void> {
  const envFile = option('--env-file') ?? DEFAULT_ENV_FILE;
  const dryRun = flag('--dry-run');
  const verifyOnly = flag('--verify');
  const seedUrl = option('--seed-url');
  const resetArg = option('--reset-slot');
  const resetSlot = resetArg === undefined ? undefined : Number(resetArg);
  if (resetSlot !== undefined && !(GOLDEN_SLOTS as readonly number[]).includes(resetSlot)) throw new Error(`--reset-slot takes one of ${GOLDEN_SLOTS.join(', ')}`);
  assertResetSeeds(resetSlot, seedUrl, dryRun);
  if (!existsSync(envFile)) throw new Error(`env file ${envFile} not found`);
  let envText = readFileSync(envFile, 'utf8');
  const fileEnv = parseEnvFile(envText);
  const get = (k: string): string | undefined => process.env[k] || fileEnv[k] || undefined;

  const dbUrl = get('MIGRATION_ADMIN_DATABASE_URL') ?? get('DATABASE_URL');
  if (!dbUrl) throw new Error('MIGRATION_ADMIN_DATABASE_URL or DATABASE_URL is not set');
  assertDevDatabaseUrl(dbUrl);
  // GoTrue helpers read process.env.
  if (!verifyOnly && !dryRun) assertGoTrueUrl(get('GOTRUE_URL'));
  for (const k of ['GOTRUE_URL', 'SUPABASE_SERVICE_ROLE_KEY']) {
    const v = get(k);
    if (!v && !verifyOnly && !dryRun) throw new Error(`${k} is not set`);
    if (v) process.env[k] = v;
  }
  /** The slot's current company: the env file's (a reset moves it to a new id), else the first generation's. */
  const currentId = (n: number): string => {
    const fromEnv = get(slotEnvKeys(n).companyId);
    return fromEnv && UUID.test(fromEnv) ? fromEnv : slotCompanyId(n);
  };

  const db = new pg.Client({ connectionString: dbUrl });
  await db.connect();
  try {
    const actual = (await db.query<{ db: string }>('SELECT current_database() AS db')).rows[0]!.db;
    if (actual !== DEV_DATABASE) throw new Error(`connected to "${actual}", not ${DEV_DATABASE}; stopping before any write`);
    say(`database ${actual}${dryRun ? ' (dry run: everything rolls back)' : ''}`);

    if (verifyOnly) {
      say(formatSlotReport('demo  ', await readSlotReport(db, SOURCE_COMPANY_ID)).replace(/, members \d+(?=, seed:)/, ''));
      let failing = 0;
      for (const n of GOLDEN_SLOTS) {
        const report = await readSlotReport(db, currentId(n));
        say(formatSlotReport(`slot ${n}`, report));
        for (const p of [...slotProblems(report, false), ...seedProblems(report)]) { say(`slot ${n}: PROBLEM: ${p}`); failing++; }
      }
      if (failing) process.exitCode = 1;
      return;
    }

    for (const n of resetSlot === undefined ? GOLDEN_SLOTS : [resetSlot]) {
      const keys = slotEnvKeys(n);
      const password = get(keys.password) ?? randomBytes(24).toString('base64url');
      // A dry run leaves GoTrue alone: it reuses the id public.users already has, or a throwaway one for a fresh user.
      const existing = dryRun ? await db.query<{ id: string }>('SELECT id FROM users WHERE lower(email) = lower($1)', [slotEmail(n)]) : null;
      const userId = dryRun ? existing!.rows[0]?.id ?? randomUUID() : await ensureGoTrueUser(n, password);

      await db.query('BEGIN');
      let committed = false;
      let companyId = currentId(n);
      try {
        if (resetSlot !== undefined) companyId = (await retireSlotCompany(db, n, companyId)).id;
        const fresh = await ensureCompany(db, n, companyId, generationOf(companyId));
        await ensureUser(db, n, companyId, userId);
        const report = await readSlotReport(db, companyId);
        say(formatSlotReport(`slot ${n}`, report));
        for (const w of slotWarnings(report, fresh)) say(`slot ${n}: warning: ${w}`);
        const problems = slotProblems(report, fresh);
        if (problems.length) throw new Error(`slot ${n} is not usable: ${problems.join('; ')}`);
        if (!dryRun) {
          await db.query('COMMIT');
          committed = true;
        }
      } finally {
        if (!committed) await rollbackFailed(db, 'provision-slots');
      }

      if (!dryRun) {
        // Per slot, right after its commit: the password now lives in GoTrue, so it must reach the file.
        envText = upsertEnvKeys(envText, { [keys.companyId]: companyId, [keys.email]: slotEmail(n), [keys.password]: password });
        writeEnvFileAtomic(envFile, envText);
        say(`slot ${n}: ${keys.companyId}, ${keys.email}, ${keys.password} written to ${envFile}`);
        if (seedUrl) {
          const report = await seedSlotViaApp(seedUrl, { companyId, email: slotEmail(n), password });
          say(`slot ${n}: seeded ${JSON.stringify(report)}`);
          const missing = seedProblems(await readSlotReport(db, companyId));
          if (missing.length) throw new Error(`slot ${n} is still short of its seed: ${missing.join('; ')}`);
        }
      }
    }
  } finally {
    await db.end();
  }
}

main().then(() => process.exit(process.exitCode ?? 0), (err: unknown) => {
  process.stderr.write(`provision-slots failed: ${(err as Error).message}\n`);
  process.exit(1);
});
