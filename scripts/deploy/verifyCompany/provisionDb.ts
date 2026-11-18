/**
 * The database half of provisioning the Deploy Verification company: the two users' `users` rows, the company through
 * create_company_with_owner (the call the app's own "new company" and seed-demo.sql make: company row, owner membership,
 * chart of accounts with the system-account mappings, AFS lines), the approver's membership, and the fiscal years the specs
 * post into.
 *
 * Additive only. A row that exists is never updated except `user_preferences`, whose two keys are only ever moved the way
 * they already move (the same guarded upserts as scripts/ci/golden/slotProvision.ts ensureUser). The caller owns the
 * transaction: --dry-run rolls it back. The first statement takes the run's transaction-level advisory lock, so two runs
 * cannot both find no company and each create one.
 */
import type { ClientBase } from 'pg';
import { actorRank, requiredRank } from '../../../src/modules/accounting/services/gl/approvalRank';
import { APPROVER_LOGIN, APPROVER_ROLE, VERIFY_COMPANY_NAME, VERIFY_LOGIN, type LoginIdentity } from './identity';
import { lockTransaction } from './lock';

export interface DbOutcome {
  companyId: string;
  userCreated: boolean;
  approverCreated: boolean;
  companyCreated: boolean;
  approverJoined: boolean;
  /** The role the approver holds (chosen from the company's pay-run rule). */
  approverRole: string;
  /** Fiscal periods created by this run (a re-run on the same day creates none). */
  periodsCreated: number;
}

export interface UserIds { verify: string; approver: string }

/** What the company is created with: seed-demo.sql's Demo, renamed, with its own registration and VAT numbers. */
const COMPANY_PAYLOAD = {
  name: VERIFY_COMPANY_NAME,
  tradingName: VERIFY_COMPANY_NAME,
  registrationNumber: '2026/000002/07',
  vatNumber: '4000000002',
  email: VERIFY_LOGIN.email,
  phone: '0110000000',
  addressLine1: '1 Verification Street',
  city: 'Johannesburg',
  province: 'Gauteng',
  postalCode: '2000',
  financialYearStart: 3,
  vatPeriod: 'bi-monthly',
};

/** Dates whose financial years the specs post into: 2026-01 .. 2027-02 (the payroll sandbox month is 2027-02) and beyond. */
const STATIC_ANCHORS = ['2025-06-01', '2026-06-01', '2027-01-15', '2027-06-01'];

const iso = (d: Date): string => d.toISOString().slice(0, 10);

/** The financial year (start month March) holding `d`: the year its March 1st falls in. */
export function fyStartYear(d: Date): number { return d.getUTCMonth() >= 2 ? d.getUTCFullYear() : d.getUTCFullYear() - 1; }
/** The budget label of that year: the calendar year it ends in (FY2027 = Mar 2026 - Feb 2027). */
export function fyLabel(d: Date): number { return fyStartYear(d) + 1; }
/** A day in the middle (August) of the financial year `yearsAhead` years from the one holding `d`. */
export function midFy(d: Date, yearsAhead: number): string { return `${fyStartYear(d) + yearsAhead}-08-15`; }

/** Every date whose year gets periods: the static anchors, and the previous, current and next year of the run's date. */
export function periodAnchors(today: Date): string[] {
  return [...new Set([...STATIC_ANCHORS, midFy(today, -1), iso(today), midFy(today, 1)])];
}

async function ensureUserRow(db: ClientBase, who: LoginIdentity, userId: string): Promise<boolean> {
  const clash = await db.query<{ id: string }>('SELECT id FROM users WHERE lower(email) = lower($1) AND id <> $2', [who.email, userId]);
  if (clash.rowCount) throw new Error(`users already has ${who.email} under another id (${clash.rows[0]!.id}); the GoTrue user and public.users must agree`);
  const made = await db.query(
    `INSERT INTO users (id, email, first_name, last_name, role, is_active, onboarding_completed, status, account_type)
     VALUES ($1, lower(btrim($2)), $3, $4, 'accountant', true, true, 'active', 'direct')
     ON CONFLICT (id) DO NOTHING`,
    [userId, who.email, who.firstName, who.lastName]);
  // The setup guide pulses for a user's first three days (the specs wait for every pulse to stop) and the first-visit tour
  // puts a full-screen mask over /accounting: these users are long-standing, as the Demo user is.
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
  // is_demo keeps it out of platform metrics, MRR and trial counts; the admin console shows it as "internal". (The public
  // landing statistics count some rows by company without that filter; see .claude.md.)
  await db.query(`UPDATE companies SET is_demo = true, status = 'active', is_active = true WHERE id = $1::uuid`, [id]);
  return id;
}

/**
 * The least role that can decide a pay-run request in this company: `manager` when the pay-run rule demands no more than that
 * (migration 951 seeds it so; the decide path ratchets to max(request snapshot, rule today)), `admin` only if the rule has been
 * raised above manager. No rule: the code's own default demand, admin. A rule above admin is refused: the approver login is
 * never made an owner (a second owner could remove the first, and the verify login is the company's only owner by design).
 */
export function chooseApproverRole(ruleRole: string | null): string {
  const demanded = ruleRole ?? 'admin';
  if (actorRank('manager') >= requiredRank(demanded)) return APPROVER_ROLE;
  if (actorRank('admin') >= requiredRank(demanded)) return 'admin';
  throw new Error(`the pay-run approval rule of the verify company demands "${demanded}", above admin: refusing to make the approver login an owner; lower the rule or decide this by hand`);
}

async function payRunRuleRole(db: ClientBase, companyId: string): Promise<string | null> {
  const r = await db.query<{ approver_role: string | null }>(
    `SELECT approver_role FROM approval_rules WHERE company_id = $1::uuid AND document_type = 'pay_run' AND is_active ORDER BY priority LIMIT 1`, [companyId]);
  return r.rows[0]?.approver_role ?? null;
}

/** The approver is a plain member of the company at the least role that can decide a pay run, never its owner; an existing membership is left as it is. */
async function ensureApproverMember(db: ClientBase, companyId: string, approverId: string, role: string): Promise<boolean> {
  const made = await db.query(
    `INSERT INTO company_users (company_id, user_id, role, is_default) VALUES ($1::uuid, $2, $3, true)
     ON CONFLICT (user_id, company_id) DO NOTHING`,
    [companyId, approverId, role]);
  return (made.rowCount ?? 0) > 0;
}

/** Fills every month of the years holding the anchor dates that has no period yet; existing periods are untouched. */
async function ensurePeriods(db: ClientBase, companyId: string, today: Date): Promise<number> {
  const made = await db.query<{ n: number }>(
    `SELECT fiscal_periods_generate(fiscal_year_ensure($1::uuid, d::date)) AS n FROM unnest($2::text[]) AS d`, [companyId, periodAnchors(today)]);
  return made.rows.reduce((sum, r) => sum + Number(r.n), 0);
}

export async function ensureUserAndCompany(db: ClientBase, ids: UserIds, today: Date): Promise<DbOutcome> {
  await lockTransaction(db);
  const userCreated = await ensureUserRow(db, VERIFY_LOGIN, ids.verify);
  const approverCreated = await ensureUserRow(db, APPROVER_LOGIN, ids.approver);
  let companyId = await findCompany(db, ids.verify);
  const companyCreated = companyId === null;
  if (companyId === null) companyId = await createCompany(db, ids.verify);
  const approverRole = chooseApproverRole(await payRunRuleRole(db, companyId));
  const approverJoined = await ensureApproverMember(db, companyId, ids.approver, approverRole);
  return { companyId, userCreated, approverCreated, companyCreated, approverJoined, approverRole, periodsCreated: await ensurePeriods(db, companyId, today) };
}
