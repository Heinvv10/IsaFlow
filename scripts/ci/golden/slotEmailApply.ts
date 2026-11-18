/**
 * The database and GoTrue half of migrate-slot-emails.ts: reads each known account's state, applies a plan. Both
 * collaborators are injected (a pg client and a GoTrue admin facade), so tests/unit/ci/goldenSlotEmailApply.test.ts drives
 * it against recording fakes. The caller has already passed the isaflow_dev and GoTrue-url guards.
 */
import { adminUpdateUser, adminHeaders, findUserByEmail, gotrueFetch, type GoTrueUser } from '../../../src/lib/auth/gotrue';
import { callAuthUpstream, readAuthUpstreamJson } from '../../../src/lib/auth/authUpstream';
import { rollbackFailed } from '../../../src/lib/rollbackFailed';
import { LEGACY_EMAIL_DOMAIN } from './slotConfig';
import type { AccountPlan, AccountState, KnownAccount } from './slotEmailPlan';

export interface Db { query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number | null }> }
export interface GoTrueOps {
  find(email: string): Promise<{ id: string; email: string } | null>;
  /** Every account whose address contains `filter` (GoTrue's own ILIKE), all pages. */
  list(filter: string): Promise<Array<{ id: string; email: string }>>;
  /** Changes the login address in place (same id). Throws unless GoTrue then reports the new address. */
  setEmail(id: string, email: string): Promise<void>;
}

const MAX_LIST_PAGES = 500;

/**
 * Every item of a paged list: pages are read until one comes back EMPTY (a server that caps per_page below the ask returns short
 * pages, so a short page is not the end). Throws at `maxPages` rather than return a truncated list: an account missed here is an
 * unknown old-domain address nobody sees.
 */
export async function paginate<T>(fetchPage: (page: number) => Promise<T[]>, maxPages: number): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const items = await fetchPage(page);
    if (items.length === 0) return out;
    out.push(...items);
  }
  throw new Error(`the list has more than ${maxPages} pages; refusing to go on with a truncated one`);
}

export function realGoTrueOps(): GoTrueOps {
  return {
    find: async (email) => { const u = await findUserByEmail(email); return u ? { id: u.id, email: u.email } : null; },
    list: (filter) => paginate(async (page) => {
      const res = await callAuthUpstream('gotrue admin list users', (signal) => gotrueFetch(
        `/admin/users?filter=${encodeURIComponent(filter)}&page=${page}&per_page=200`, { method: 'GET', signal }, adminHeaders()));
      if (!res.ok) throw new Error(`gotrue admin list users failed: ${res.status}`);
      const users = ((await readAuthUpstreamJson('gotrue admin list users', res)) as { users?: GoTrueUser[] }).users ?? [];
      return users.map((u) => ({ id: u.id, email: u.email ?? '' }));
    }, MAX_LIST_PAGES),
    setEmail: async (id, email) => {
      // email_confirm: an admin change then takes effect at once, with no confirmation mail to either address.
      const updated = await adminUpdateUser(id, { email, email_confirm: true });
      if ((updated.email ?? '').trim().toLowerCase() !== email.toLowerCase()) throw new Error(`GoTrue answered the email change for ${id} with another address`);
    },
  };
}

const SLOT_COMPANY_ID = '^601d000[0-9]-0000-4000-8000-00000000000[0-9]$';

export async function readAccountState(db: Db, gt: GoTrueOps, a: KnownAccount): Promise<AccountState> {
  const ids = async (email: string): Promise<string[]> =>
    (await db.query<{ id: string }>('SELECT id::text AS id FROM users WHERE lower(email) = lower($1)', [email])).rows.map((r) => r.id);
  const companiesOld = a.companyEmail
    ? (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM companies WHERE lower(email) = lower($1) AND id::text ~ '${SLOT_COMPANY_ID}'`, [a.oldEmail])).rows[0]?.n ?? 0
    : 0;
  return {
    gotrueOld: (await gt.find(a.oldEmail))?.id ?? null,
    gotrueNew: (await gt.find(a.newEmail))?.id ?? null,
    usersOld: await ids(a.oldEmail),
    usersNew: await ids(a.newEmail),
    companiesOld,
  };
}

/**
 * Addresses on the retired domain that no code knows: GoTrue accounts and `users` rows. Reported, never touched.
 */
export async function findUnknownLegacy(db: Db, gt: GoTrueOps, known: KnownAccount[]): Promise<{ gotrue: string[]; users: string[] }> {
  const knownOld = new Set(known.map((k) => k.oldEmail.toLowerCase()));
  const suffix = `@${LEGACY_EMAIL_DOMAIN}`;
  const unknown = (emails: string[]): string[] => [...new Set(emails.map((e) => e.trim().toLowerCase()))].filter((e) => e.endsWith(suffix) && !knownOld.has(e)).sort();
  const rows = await db.query<{ email: string }>(`SELECT email FROM users WHERE lower(email) LIKE '%' || $1`, [suffix]);
  return { gotrue: unknown((await gt.list(LEGACY_EMAIL_DOMAIN)).map((u) => u.email)), users: unknown(rows.rows.map((r) => r.email)) };
}

/**
 * Runs a 'migrate' plan: the database steps in one transaction, GoTrue last, then COMMIT. A GoTrue failure rolls the
 * database back; a COMMIT that fails after GoTrue changed leaves GoTrue ahead, which a re-run finishes (users row still on
 * the old address, GoTrue on the new: the planner's 'users-email' step alone).
 */
export async function applyPlan(db: Db, gt: GoTrueOps, plan: AccountPlan): Promise<void> {
  if (plan.action !== 'migrate' || !plan.userId) return;
  const { oldEmail, newEmail } = plan.account;
  await db.query('BEGIN');
  let committed = false;
  try {
    if (plan.steps.includes('users-email')) {
      const updated = await db.query('UPDATE users SET email = lower(btrim($2)) WHERE id::text = $1 AND lower(email) = lower($3)', [plan.userId, newEmail, oldEmail]);
      if (updated.rowCount !== 1) throw new Error(`${plan.account.label}: UPDATE users changed ${updated.rowCount ?? 'an unknown number of'} rows, exactly one was expected; rolled back, nothing was changed`);
    }
    if (plan.steps.includes('companies-email')) {
      await db.query(`UPDATE companies SET email = lower(btrim($1)) WHERE lower(email) = lower($2) AND id::text ~ '${SLOT_COMPANY_ID}'`, [newEmail, oldEmail]);
    }
    if (plan.steps.includes('gotrue-email')) await gt.setEmail(plan.userId, newEmail);
    await db.query('COMMIT');
    committed = true;
  } finally {
    if (!committed) await rollbackFailed(db, 'migrate-slot-emails');
  }
}
