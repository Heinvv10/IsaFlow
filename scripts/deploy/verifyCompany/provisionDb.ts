/**
 * The database half of provisioning the Deploy Verification company: the verify user's `users` row, the company through
 * create_company_with_owner (the call the app's own "new company" and seed-demo.sql make: company row, owner membership,
 * chart of accounts with the system-account mappings, AFS lines), and the fiscal years the specs post into.
 *
 * Additive only. A row that exists is never updated except `user_preferences`, whose two keys are only ever moved the way
 * they already move (the same guarded upserts as scripts/ci/golden/slotProvision.ts ensureUser). The caller owns the
 * transaction: --dry-run rolls it back.
 */
import type { ClientBase } from 'pg';
import { PERIOD_ANCHOR_DATES, VERIFY_COMPANY_NAME, VERIFY_USER_EMAIL } from './config';

export interface DbOutcome {
  companyId: string;
  userCreated: boolean;
  companyCreated: boolean;
  /** Fiscal periods created by this run (a re-run on the same day creates none). */
  periodsCreated: number;
}

/** What the company is created with: seed-demo.sql's Demo, renamed, with its own registration and VAT numbers. */
const COMPANY_PAYLOAD = {
  name: VERIFY_COMPANY_NAME,
  tradingName: VERIFY_COMPANY_NAME,
  registrationNumber: '2026/000002/07',
  vatNumber: '4000000002',
  email: VERIFY_USER_EMAIL,
  phone: '0110000000',
  addressLine1: '1 Verification Street',
  city: 'Johannesburg',
  province: 'Gauteng',
  postalCode: '2000',
  financialYearStart: 3,
  vatPeriod: 'bi-monthly',
};

async function ensureUserRow(db: ClientBase, userId: string): Promise<boolean> {
  const clash = await db.query<{ id: string }>('SELECT id FROM users WHERE lower(email) = lower($1) AND id <> $2', [VERIFY_USER_EMAIL, userId]);
  if (clash.rowCount) throw new Error(`users already has ${VERIFY_USER_EMAIL} under another id (${clash.rows[0]!.id}); the GoTrue user and public.users must agree`);
  const made = await db.query(
    `INSERT INTO users (id, email, first_name, last_name, role, is_active, onboarding_completed, status, account_type)
     VALUES ($1, lower(btrim($2)), 'Deploy', 'Verification', 'accountant', true, true, 'active', 'direct')
     ON CONFLICT (id) DO NOTHING`,
    [userId, VERIFY_USER_EMAIL]);
  // The setup guide pulses for a user's first three days (the specs wait for every pulse to stop) and the first-visit tour
  // puts a full-screen mask over /accounting: this user is long-standing, as the Demo user is.
  await db.query(
    `INSERT INTO user_preferences (user_id, key, value, updated_at) VALUES ($1, 'setup-guide-first-seen', '2026-01-01T00:00:00.000Z', NOW())
     ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW() WHERE user_preferences.value > EXCLUDED.value`,
    [userId]);
  await db.query(
    `INSERT INTO user_preferences (user_id, key, value, updated_at) VALUES ($1, 'onboarding_tour_completed', 'true', NOW())
     ON CONFLICT (user_id, key) DO UPDATE SET value = 'true', updated_at = NOW() WHERE user_preferences.value IS DISTINCT FROM 'true'`,
    [userId]);
  return (made.rowCount ?? 0) > 0;
}

/** The company this user is a member of by the verify name, or null; a company of that name the user is not in is refused. */
async function findCompany(db: ClientBase, userId: string): Promise<string | null> {
  const named = await db.query<{ id: string; member: boolean }>(
    `SELECT c.id::text AS id, EXISTS (SELECT 1 FROM company_users cu WHERE cu.company_id = c.id AND cu.user_id = $1) AS member
       FROM companies c WHERE c.name = $2 ORDER BY c.created_at`,
    [userId, VERIFY_COMPANY_NAME]);
  const mine = named.rows.filter((r) => r.member);
  if (mine.length > 1) throw new Error(`the verify user is a member of ${mine.length} companies named "${VERIFY_COMPANY_NAME}" (${mine.map((r) => r.id).join(', ')}); keep one`);
  if (!mine[0] && named.rowCount) throw new Error(`a company named "${VERIFY_COMPANY_NAME}" exists (${named.rows[0]!.id}) without the verify user as a member; refusing to create a second or join it`);
  return mine[0]?.id ?? null;
}

async function createCompany(db: ClientBase, userId: string): Promise<string> {
  // auth.uid() inside create_company_with_owner reads this setting; local to the transaction.
  await db.query(`SELECT set_config('request.jwt.claims', json_build_object('sub', $1::text)::text, true)`, [userId]);
  const made = await db.query<{ id: string }>('SELECT id::text AS id FROM create_company_with_owner($1::jsonb)', [JSON.stringify(COMPANY_PAYLOAD)]);
  const id = made.rows[0]!.id;
  // is_demo keeps it out of platform metrics, MRR, the landing page and trial counts; the admin console shows it as "internal".
  await db.query(`UPDATE companies SET is_demo = true, status = 'active', is_active = true WHERE id = $1::uuid`, [id]);
  return id;
}

/** Fills every month of the years holding the anchor dates and today that has no period yet; existing periods are untouched. */
async function ensurePeriods(db: ClientBase, companyId: string, today: string): Promise<number> {
  const dates = [...PERIOD_ANCHOR_DATES, today];
  const made = await db.query<{ n: number }>(
    `SELECT fiscal_periods_generate(fiscal_year_ensure($1::uuid, d::date)) AS n FROM unnest($2::text[]) AS d`, [companyId, dates]);
  return made.rows.reduce((sum, r) => sum + Number(r.n), 0);
}

export async function ensureUserAndCompany(db: ClientBase, userId: string, today: string): Promise<DbOutcome> {
  const userCreated = await ensureUserRow(db, userId);
  let companyId = await findCompany(db, userId);
  const companyCreated = companyId === null;
  if (companyId === null) companyId = await createCompany(db, userId);
  return { companyId, userCreated, companyCreated, periodsCreated: await ensurePeriods(db, companyId, today) };
}
