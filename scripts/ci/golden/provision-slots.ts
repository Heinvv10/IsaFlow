/**
 * Provision the Golden Paths slots on isaflow_dev: three companies (golden-slot-1..3), each a copy of the Demo
 * company's setup data (no transactions), each with its own golden user as sole owner.
 *
 *   bun scripts/ci/golden/provision-slots.ts [--dry-run] [--verify] [--env-file <path>]
 *
 * Idempotent. A slot company that exists is kept (its data is the suite's to grow); its user, membership, GoTrue
 * password and env keys are re-asserted. A company is created with its membership in ONE transaction, so a failure
 * leaves nothing half-made. --dry-run does everything in a transaction it rolls back and touches neither GoTrue nor
 * the env file. --verify only reads and prints each slot's preconditions.
 *
 * Writes GOLDEN_SLOT_n_COMPANY_ID / _EMAIL / _PASSWORD (n = 1..3) to the env file (default /home/hein/isaflow-ci.env,
 * which the golden-paths job copies to .env.local and reads the keys from). Passwords are never printed.
 *
 * Refuses any database but isaflow_dev (production is `isaflow` on the same host and port).
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import pg from 'pg';
import { adminCreateUser, adminUpdateUser } from '../../../src/lib/auth/gotrue';
import { cloneCompany } from './cloneCompany';
import {
  DEV_DATABASE, GOLDEN_SLOTS, SOURCE_COMPANY_ID, assertDevDatabaseUrl, parseEnvFile, slotCompanyId, slotCompanyName,
  slotEmail, slotEnvKeys, upsertEnvKeys,
} from './slotConfig';
import { formatSlotReport, readSlotReport, slotProblems } from './slotVerify';

const DEFAULT_ENV_FILE = '/home/hein/isaflow-ci.env';
const say = (line: string): void => { process.stdout.write(`${line}\n`); };

function flag(name: string): boolean { return process.argv.includes(name); }
function option(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

/** @returns true when this run created the company */
async function ensureCompany(db: pg.ClientBase, n: number): Promise<boolean> {
  const id = slotCompanyId(n);
  const { created, copied } = await cloneCompany(db, {
    sourceId: SOURCE_COMPANY_ID,
    targetId: id,
    company: {
      name: slotCompanyName(n), registered_name: slotCompanyName(n), trading_name: slotCompanyName(n),
      registration_number: `GOLDEN/SLOT/${n}`, email: slotEmail(n), is_demo: true, onboarding_request_key: null,
    },
  });
  const rows = Object.entries(copied).map(([t, c]) => `${t}=${c}`).join(' ');
  say(`slot ${n}: company ${id} ${created ? 'created' : 'exists, kept'}${rows ? `; rows copied ${rows}` : ''}`);
  return created;
}

/** The golden user is a member of its slot company only (the suite's own sandbox companies are added by the specs). */
async function ensureUser(db: pg.ClientBase, n: number, userId: string): Promise<void> {
  const id = slotCompanyId(n);
  const email = slotEmail(n);
  const clash = await db.query<{ id: string }>('SELECT id FROM users WHERE lower(email) = lower($1) AND id <> $2', [email, userId]);
  if (clash.rowCount) throw new Error(`users already has ${email} under another id (${clash.rows[0]!.id}); the GoTrue user and public.users must agree`);
  await db.query(
    `INSERT INTO users (id, email, first_name, last_name, role, is_active, onboarding_completed, status, account_type)
     VALUES ($1, $2, 'Golden', $3, 'accountant', true, true, 'active', 'direct')
     ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, is_active = true, onboarding_completed = true, status = 'active'`,
    [userId, email, `Slot ${n}`]);
  await db.query(
    `INSERT INTO company_users (company_id, user_id, role, is_default) VALUES ($1::uuid, $2, 'owner', true)
     ON CONFLICT (user_id, company_id) DO UPDATE SET role = 'owner', is_default = true`,
    [id, userId]);
  // The setup-guide button pulses for a user's first three days and the a11y specs wait for every pulse to stop, so the
  // golden user has "first seen" long ago, as the Demo user does. The app writes its own on the first visit, so an
  // ISO date later than ours is moved back; an earlier one is kept (ISO strings order as text).
  await db.query(
    `INSERT INTO user_preferences (user_id, key, value, updated_at) VALUES ($1, 'setup-guide-first-seen', '2026-01-01T00:00:00.000Z', NOW())
     ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW() WHERE user_preferences.value > EXCLUDED.value`,
    [userId]);
  // Login opens the user's default company; the suite switches explicitly anyway, but keep the default honest.
  await db.query('UPDATE company_users SET is_default = false WHERE user_id = $1 AND company_id <> $2::uuid', [userId, id]);
}

async function ensureGoTrueUser(n: number, password: string): Promise<string> {
  const user = await adminCreateUser({ email: slotEmail(n), password, email_confirm: true, user_metadata: { purpose: 'golden-paths CI slot' } });
  // adminCreateUser answers an existing user as is, so the password is set explicitly to the one in the env file.
  await adminUpdateUser(user.id, { password, email_confirm: true });
  return user.id;
}

async function main(): Promise<void> {
  const envFile = option('--env-file') ?? DEFAULT_ENV_FILE;
  const dryRun = flag('--dry-run');
  const verifyOnly = flag('--verify');
  if (!existsSync(envFile)) throw new Error(`env file ${envFile} not found`);
  let envText = readFileSync(envFile, 'utf8');
  const fileEnv = parseEnvFile(envText);
  const get = (k: string): string | undefined => process.env[k] || fileEnv[k] || undefined;

  const dbUrl = get('MIGRATION_ADMIN_DATABASE_URL') ?? get('DATABASE_URL');
  if (!dbUrl) throw new Error('MIGRATION_ADMIN_DATABASE_URL or DATABASE_URL is not set');
  assertDevDatabaseUrl(dbUrl);
  // GoTrue helpers read process.env.
  for (const k of ['GOTRUE_URL', 'SUPABASE_SERVICE_ROLE_KEY']) {
    const v = get(k);
    if (!v && !verifyOnly && !dryRun) throw new Error(`${k} is not set`);
    if (v) process.env[k] = v;
  }

  const db = new pg.Client({ connectionString: dbUrl });
  await db.connect();
  try {
    const actual = (await db.query<{ db: string }>('SELECT current_database() AS db')).rows[0]!.db;
    if (actual !== DEV_DATABASE) throw new Error(`connected to "${actual}", not ${DEV_DATABASE}; stopping before any write`);
    say(`database ${actual}${dryRun ? ' (dry run: everything rolls back)' : ''}`);

    if (verifyOnly) {
      say(formatSlotReport('demo  ', await readSlotReport(db, SOURCE_COMPANY_ID)).replace(/, members \d+$/, ''));
      for (const n of GOLDEN_SLOTS) say(formatSlotReport(`slot ${n}`, await readSlotReport(db, slotCompanyId(n))));
      return;
    }

    for (const n of GOLDEN_SLOTS) {
      const keys = slotEnvKeys(n);
      const password = get(keys.password) ?? randomBytes(24).toString('base64url');
      const userId = dryRun ? `dry-run-user-${n}` : await ensureGoTrueUser(n, password);

      await db.query('BEGIN');
      try {
        const fresh = await ensureCompany(db, n);
        await ensureUser(db, n, userId);
        const report = await readSlotReport(db, slotCompanyId(n));
        say(formatSlotReport(`slot ${n}`, report));
        const problems = slotProblems(report, fresh);
        if (problems.length) throw new Error(`slot ${n} is not usable: ${problems.join('; ')}`);
        await db.query(dryRun ? 'ROLLBACK' : 'COMMIT');
      } catch (err) {
        await db.query('ROLLBACK');
        throw err;
      }

      if (!dryRun) {
        // Per slot, right after its commit: the password now lives in GoTrue, so it must reach the file.
        envText = upsertEnvKeys(envText, { [keys.companyId]: slotCompanyId(n), [keys.email]: slotEmail(n), [keys.password]: password });
        writeFileSync(envFile, envText); // writes through the symlink the CI env file is
        say(`slot ${n}: ${keys.companyId}, ${keys.email}, ${keys.password} written to ${envFile}`);
      }
    }
  } finally {
    await db.end();
  }
}

main().then(() => process.exit(0), (err: unknown) => {
  process.stderr.write(`provision-slots failed: ${(err as Error).message}\n`);
  process.exit(1);
});
