/**
 * Provision the wave-6 golden QA user on isaflow_dev: golden-qa-w6@isaflow.dev, owner of ONE company of its own,
 * "0W6 Golden Sandbox", and of nothing else. Wave-6 goldens that write sign in as it (loginAs) so they never share a
 * session, or an active company, with the reporting-qa users peers switch around.
 *
 *   bun scripts/ci/golden/provision-w6-qa.ts [--app-url http://localhost:<dev port>] [--env-file <path>] [--verify]
 *
 * Idempotent. The GoTrue user and its public.users row are re-asserted every run; the company is created once,
 * the way signup makes one (provisionTenant), and --app-url (a local dev server on isaflow_dev) seeds its standard
 * chart of accounts through the app's own coa-seed route as that user; without it the sandbox has no chart. The
 * password is read from the env file or made once (a lost env file therefore ROTATES the password: the run makes a new
 * one and sets it in GoTrue), set in GoTrue, and written to the env file (default ~/.secrets/isaflow-dev-golden-qa.env, mode 600); it is
 * never printed. --verify only reads: exits 1 unless the user belongs to exactly the sandbox, as owner.
 *
 * --app-url: only a local dev port is accepted, but nothing can prove from outside which database that server uses, so
 * start it from a checkout whose .env.local points at isaflow_dev (as provision-slots.ts requires).
 *
 * Refuses any database but isaflow_dev and any GoTrue but the one pinned in slotConfig.ts (shared with production).
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { adminCreateUser, adminUpdateUser } from '../../../src/lib/auth/gotrue';
import { rollbackFailed } from '../../../src/lib/rollbackFailed';
import { provisionTenant } from '../../../src/modules/onboarding/services/tenantProvisioningService';
import { FetchContext } from './fetchContext';
import { assertLocalBaseUrl } from './seedSlotClient';
import { writeEnvFileAtomic } from './slotEnvFile';
import { assertConnectedToDev, assertDevDatabaseUrl, assertGoTrueUrl, parseEnvFile, upsertEnvKeys } from './slotConfig';

export const W6_EMAIL = 'golden-qa-w6@isaflow.dev';
export const W6_COMPANY_NAME = '0W6 Golden Sandbox';
const DEFAULT_ENV_FILE = join(homedir(), '.secrets', 'isaflow-dev-golden-qa.env');
const say = (line: string): void => { process.stdout.write(`${line}\n`); };
const option = (name: string): string | undefined => { const at = process.argv.indexOf(name); return at >= 0 ? process.argv[at + 1] : undefined; };

interface Membership { id: string; name: string; role: string }

async function memberships(db: pg.Client, userId: string): Promise<Membership[]> {
  const r = await db.query<Membership>(
    `SELECT c.id, c.name, cu.role FROM company_users cu JOIN companies c ON c.id = cu.company_id WHERE cu.user_id = $1 ORDER BY c.name`, [userId]);
  return r.rows;
}

/** What --verify and the end of a run assert: exactly the sandbox, as owner. */
export function membershipProblems(rows: Membership[]): string[] {
  const out: string[] = [];
  if (rows.length !== 1) out.push(`${W6_EMAIL} belongs to ${rows.length} companies (${rows.map((r) => r.name).join(', ') || 'none'}), not exactly "${W6_COMPANY_NAME}"`);
  else if (rows[0]!.name !== W6_COMPANY_NAME) out.push(`its one company is "${rows[0]!.name}", not "${W6_COMPANY_NAME}"`);
  else if (rows[0]!.role !== 'owner') out.push(`its role in the sandbox is ${rows[0]!.role}, not owner`);
  return out;
}

async function ensureUserRow(db: pg.Client, userId: string): Promise<void> {
  await db.query(
    `INSERT INTO users (id, email, first_name, last_name, role, is_active, onboarding_completed, status, account_type)
     VALUES ($1, $2, 'Golden', 'QA W6', 'accountant', true, true, 'active', 'direct')
     ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, is_active = true, onboarding_completed = true, status = 'active'`,
    [userId, W6_EMAIL]);
  // Same as the slot users: no pulsing setup guide and no auto-starting tour mask over the first click.
  await db.query(
    `INSERT INTO user_preferences (user_id, key, value, updated_at) VALUES ($1, 'setup-guide-first-seen', '2026-01-01T00:00:00.000Z', NOW())
     ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW() WHERE user_preferences.value > EXCLUDED.value`, [userId]);
  await db.query(
    `INSERT INTO user_preferences (user_id, key, value, updated_at) VALUES ($1, 'onboarding_tour_completed', 'true', NOW())
     ON CONFLICT (user_id, key) DO UPDATE SET value = 'true', updated_at = NOW() WHERE user_preferences.value IS DISTINCT FROM 'true'`, [userId]);
}

/**
 * The company, as signup makes it: provisionTenant (company, trial subscription, owner membership, first fiscal year).
 * The check and the create share one transaction under an advisory lock, so two runs cannot both create it.
 */
export async function createSandbox(db: pg.Client, userId: string): Promise<void> {
  await db.query('BEGIN');
  try {
    await db.query(`SELECT pg_advisory_xact_lock(hashtextextended('provision-w6-qa:sandbox', 0))`);
    if ((await memberships(db, userId)).some((m) => m.name === W6_COMPANY_NAME)) { await db.query('COMMIT'); return; }
    await provisionTenant(db, {
      ownerUserId: userId, email: W6_EMAIL, firstName: 'Golden', lastName: 'QA W6', companyName: W6_COMPANY_NAME,
      phone: null, annualTurnoverCents: null, signupType: 'direct',
    });
    await db.query('COMMIT');
  } catch (err) {
    await rollbackFailed(db, 'provision-w6-qa');
    throw err;
  }
}

/** Seeds the standard chart through the app's own route, as the sandbox's owner, on a local dev server. Idempotent. */
async function seedChart(appUrl: string, password: string): Promise<void> {
  assertLocalBaseUrl(appUrl);
  const ctx = new FetchContext(appUrl);
  const login = await ctx.post('/api/auth/login', { data: { email: W6_EMAIL, password } });
  if (login.status() !== 200) throw new Error(`login as ${W6_EMAIL} failed: ${login.status()} ${(await login.text()).slice(0, 300)}`);
  await ctx.get('/accounting');
  const csrf = (await ctx.storageState()).cookies.find((c) => c.name === 'isaflow_csrf')?.value ?? '';
  if (!csrf) throw new Error('no CSRF cookie after login');
  const seeded = await ctx.post('/api/accounting/coa-seed', { headers: { 'x-csrf-token': csrf }, data: { template: 'isaflow_standard' } });
  if (seeded.status() !== 200) throw new Error(`coa-seed failed: ${seeded.status()} ${(await seeded.text()).slice(0, 400)}`);
}

export async function main(): Promise<void> {
  const envFile = option('--env-file') ?? DEFAULT_ENV_FILE;
  const appUrl = option('--app-url');
  const verifyOnly = process.argv.includes('--verify');
  const fileText = existsSync(envFile) ? readFileSync(envFile, 'utf8') : '';
  const fileEnv = parseEnvFile(fileText);
  const localEnv = join(process.cwd(), '.env.local');
  const dev = existsSync(localEnv) ? parseEnvFile(readFileSync(localEnv, 'utf8')) : {};
  const get = (k: string): string | undefined => process.env[k] || dev[k] || undefined;
  const dbUrl = get('MIGRATION_ADMIN_DATABASE_URL') ?? get('DATABASE_URL');
  if (!dbUrl) throw new Error('MIGRATION_ADMIN_DATABASE_URL or DATABASE_URL is not set');
  assertDevDatabaseUrl(dbUrl);
  for (const k of ['GOTRUE_URL', 'SUPABASE_SERVICE_ROLE_KEY']) { const v = get(k); if (v) process.env[k] = v; }
  assertGoTrueUrl(process.env.GOTRUE_URL);
  const db = new pg.Client({ connectionString: dbUrl });
  await db.connect();
  try {
    say(`database ${await assertConnectedToDev(db)}`);
    const found = await db.query<{ id: string }>('SELECT id FROM users WHERE lower(email) = lower($1)', [W6_EMAIL]);
    if (verifyOnly) {
      const problems = found.rows[0] ? membershipProblems(await memberships(db, found.rows[0].id)) : [`${W6_EMAIL} has no users row`];
      for (const p of problems) say(`PROBLEM: ${p}`);
      say(problems.length ? 'verify: FAILED' : `verify: ok (${W6_EMAIL} owns only "${W6_COMPANY_NAME}")`);
      if (problems.length) process.exitCode = 1;
      return;
    }
    const password = fileEnv.GOLDEN_QA_W6_PASSWORD || randomBytes(24).toString('base64url');
    const user = await adminCreateUser({ email: W6_EMAIL, password, email_confirm: true, user_metadata: { purpose: 'wave-6 golden QA' } });
    // Before the password is touched: a user that already belongs to some other company is not this account.
    const held = (await memberships(db, user.id)).filter((m) => m.name !== W6_COMPANY_NAME);
    if (held.length) throw new Error(`${W6_EMAIL} already belongs to ${held.map((m) => m.name).join(', ')}; refusing to continue (password untouched)`);
    await adminUpdateUser(user.id, { password, email_confirm: true });
    await ensureUserRow(db, user.id);
    if (!existsSync(envFile)) writeFileSync(envFile, '', { mode: 0o600 });
    // Written before the company step: the password in GoTrue must be recoverable even if onboarding then fails.
    writeEnvFileAtomic(envFile, upsertEnvKeys(fileText, { GOLDEN_QA_W6_EMAIL: W6_EMAIL, GOLDEN_QA_W6_PASSWORD: password }));
    say(`${W6_EMAIL}: GoTrue user and users row asserted; login written to ${envFile}`);
    if (!(await memberships(db, user.id)).some((m) => m.name === W6_COMPANY_NAME)) {
      await createSandbox(db, user.id);
    }
    if (appUrl) { await seedChart(appUrl, password); say('standard chart of accounts seeded (idempotent)'); }
    const problems = membershipProblems(await memberships(db, user.id));
    if (problems.length) throw new Error(problems.join('; '));
    // The sandbox's id is not known until it exists, so the login block is completed here: loginAs needs it.
    const companyId = (await memberships(db, user.id))[0]!.id;
    writeEnvFileAtomic(envFile, upsertEnvKeys(readFileSync(envFile, 'utf8'), { GOLDEN_QA_W6_COMPANY_ID: companyId }));
    say(`${W6_EMAIL}: owner of "${W6_COMPANY_NAME}" only (${companyId})`);
  } finally {
    await db.end();
  }
}

if (process.argv[1]?.endsWith('provision-w6-qa.ts')) {
  main().catch((err) => { process.stderr.write(`${(err as Error).message}\n`); process.exit(1); });
}
