/**
 * Shared by the budget-grid suites (budgets P2 PR-B): a company with an owner and a viewer, a
 * revenue/expense chart (leaf and header accounts, an inactive one, an asset), CC1/CC2/BU members,
 * registry years (the optional 14-month transition year), versions and amounts written directly,
 * posted and draft journals with dimension tags, and a caller for the real GET/POST routes.
 * Real PostgreSQL; synthetic rows only. Every row made here is removed by `cleanup()`.
 *
 * Registry years (default): FY2026 = Mar 2025 - Feb 2026, FY2027 = Mar 2026 - Feb 2027,
 * FY2028 = Mar 2027 - Feb 2028. With `transition`: FY2025 = Jan-Dec 2025 and the 14-month
 * FY2027 = Jan 2026 - Feb 2027 (the label 2026 is skipped, as after a change of year end).
 */
import type { Pool } from 'pg';
import { request, response } from '../mfa-impersonation-postgres.helpers';
import { signSession } from '../r-032-fake-gotrue.helpers';
import type { SetupUser } from './onboardingSetupFixture';

export const ACCOUNT_KEYS = [
  'sales', 'otherIncome', 'cos', 'rent', 'header', 'childA', 'childB', 'inactive', 'inactiveHeader', 'inactiveChild', 'bank',
] as const;
export type AccountKey = (typeof ACCOUNT_KEYS)[number];

export interface GridCo {
  id: string;
  /** The owner's user id, also `created_by` of versions and journals. */
  user: string;
  owner: SetupUser;
  viewer: SetupUser;
  acct: Record<AccountKey, string>;
  cc1: string; cc1b: string; cc1Inactive: string; cc2: string; bu: string;
  transition: boolean;
}

export interface Dims { cc1?: string | null; cc2?: string | null; bu?: string | null }
export interface JournalLine extends Dims { acct: string; debit?: number; credit?: number }
type Q = Pick<Pool, 'query'>;

export type RouteOut = { status: number; body: { data?: Record<string, unknown>; error?: { message?: string; details?: { code?: string } } } };

export function budgetGridFixture(pool: Pool) {
  const companies: GridCo[] = [];
  const users: string[] = [];

  async function member(companyId: string, role: string): Promise<SetupUser> {
    const userId = crypto.randomUUID();
    await pool.query(`INSERT INTO users (id, email, role, is_active, onboarding_completed) VALUES ($1, $2, 'admin', true, true)`, [userId, `${userId}@test.local`]);
    await pool.query(`INSERT INTO company_users (company_id, user_id, role, is_default) VALUES ($1, $2, $3, true)`, [companyId, userId, role]);
    users.push(userId);
    return { userId, homeCompanyId: companyId, token: await signSession(userId, undefined, 'aal2') };
  }

  /** A March-year company with the chart, members, dimensions and registry years described in the header. */
  async function company(opts: { transition?: boolean; name?: string } = {}): Promise<GridCo> {
    const id = crypto.randomUUID();
    const a = Object.fromEntries(ACCOUNT_KEYS.map((k) => [k, crypto.randomUUID()])) as Record<AccountKey, string>;
    await pool.query('INSERT INTO companies (id, name, financial_year_start) VALUES ($1, $2, $3)', [id, opts.name ?? `BGRID ${id.slice(0, 8)}`, opts.transition ? 1 : 3]);
    const owner = await member(id, 'owner');
    const viewer = await member(id, 'viewer');
    const chart: Array<[AccountKey, string, string, string, string | null, string, boolean, string | null]> = [
      // key, code, name, type, subtype, normal balance, active, parent key
      ['sales', '4000', 'Sales', 'revenue', null, 'credit', true, null],
      ['otherIncome', '4900', 'Interest received', 'revenue', 'other_income', 'credit', true, null],
      ['cos', '5000', 'Cost of sales', 'expense', 'cost_of_sales', 'debit', true, null],
      ['rent', '6000', 'Rent', 'expense', 'operating_expense', 'debit', true, null],
      ['header', '6100', 'Premises', 'expense', 'operating_expense', 'debit', true, null],
      ['childA', '6110', 'Premises: rates', 'expense', 'operating_expense', 'debit', true, 'header'],
      ['childB', '6120', 'Premises: cleaning', 'expense', 'operating_expense', 'debit', true, 'header'],
      ['inactive', '6900', 'Old consultants', 'expense', 'operating_expense', 'debit', false, null],
      // An inactive child still makes its parent a header (the leafAccountOptions rule).
      ['inactiveHeader', '6200', 'Travel', 'expense', 'operating_expense', 'debit', true, null],
      ['inactiveChild', '6210', 'Travel: air', 'expense', 'operating_expense', 'debit', false, 'inactiveHeader'],
      ['bank', '1000', 'Bank', 'asset', 'bank', 'debit', true, null],
    ];
    for (const [key, code, name, type, subtype, normal, active] of chart) {
      await pool.query(
        `INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type, account_subtype, normal_balance, level, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 3, $8)`, [a[key], id, code, name, type, subtype, normal, active]);
    }
    for (const [key, , , , , , , parent] of chart) {
      if (parent) await pool.query('UPDATE gl_accounts SET parent_account_id = $1 WHERE id = $2 AND company_id = $3', [a[parent as AccountKey], a[key], id]);
    }
    const co: GridCo = {
      id, user: owner.userId, owner, viewer, acct: a, transition: opts.transition === true,
      cc1: crypto.randomUUID(), cc1b: crypto.randomUUID(), cc1Inactive: crypto.randomUUID(), cc2: crypto.randomUUID(), bu: crypto.randomUUID(),
    };
    await pool.query(
      `INSERT INTO cost_centres (id, company_id, code, name, cc_type, is_active)
       VALUES ($1, $5, 'GC1', 'Cape Town', 'cc1', true), ($2, $5, 'GC1B', 'Durban', 'cc1', true),
              ($3, $5, 'GC1X', 'Closed branch', 'cc1', false), ($4, $5, 'GC2', 'Retail', 'cc2', true)`,
      [co.cc1, co.cc1b, co.cc1Inactive, co.cc2, id]);
    await pool.query(`INSERT INTO business_units (id, company_id, code, name) VALUES ($1, $2, 'GBU', 'Operations')`, [co.bu, id]);
    const years = opts.transition
      ? [[2025, '2025-01-01', '2025-12-31', 'normal'], [2027, '2026-01-01', '2027-02-28', 'transition'], [2028, '2027-03-01', '2028-02-29', 'normal']]
      : [[2026, '2025-03-01', '2026-02-28', 'normal'], [2027, '2026-03-01', '2027-02-28', 'normal'], [2028, '2027-03-01', '2028-02-29', 'normal']];
    for (const [fy, start, end, kind] of years) {
      await pool.query('INSERT INTO fiscal_years (company_id, fiscal_year, start_date, end_date, kind) VALUES ($1, $2, $3, $4, $5)', [id, fy, start, end, kind]);
    }
    companies.push(co);
    return co;
  }

  /** A version; `status` approved/locked is reached through the legal moves, stamped by the company's owner. */
  async function version(c: GridCo, opts: { fy?: number; name?: string; kind?: string; status?: 'draft' | 'approved' | 'locked'; primary?: boolean } = {}, q: Q = pool): Promise<string> {
    const id = (await q.query(
      `INSERT INTO budget_versions (company_id, fiscal_year, name, kind, is_primary, created_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [c.id, opts.fy ?? 2027, opts.name ?? `V-${crypto.randomUUID().slice(0, 8)}`, opts.kind ?? 'scenario', opts.primary ?? false, c.user])).rows[0].id as string;
    if (opts.status === 'approved' || opts.status === 'locked') {
      await q.query(`UPDATE budget_versions SET status = 'approved', approved_by = $2, approved_at = clock_timestamp() WHERE id = $1`, [id, c.user]);
    }
    if (opts.status === 'locked') {
      await q.query(`UPDATE budget_versions SET status = 'locked', locked_by = $2, locked_at = clock_timestamp() WHERE id = $1`, [id, c.user]);
    }
    return id;
  }

  /** One amount; `month` is 'YYYY-MM'. */
  const amount = (c: GridCo, versionId: string, acct: string, month: string, value: number, dims: Dims = {}, q: Q = pool) => q.query(
    `INSERT INTO budget_month_amounts (company_id, version_id, gl_account_id, month, amount, cc1_id, cc2_id, bu_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [c.id, versionId, acct, `${month}-01`, value, dims.cc1 ?? null, dims.cc2 ?? null, dims.bu ?? null]);

  /** The same amount in every one of `months`. */
  async function amounts(c: GridCo, versionId: string, acct: string, months: readonly string[], value: number, dims: Dims = {}) {
    for (const m of months) await amount(c, versionId, acct, m, value, dims);
  }

  /** A journal with its lines; posted by default. Lines need not balance for the readers, but this one adds the bank leg so they do. */
  async function journal(c: GridCo, date: string, lines: JournalLine[], opts: { status?: 'draft' | 'posted'; source?: string } = {}): Promise<string> {
    const entry = crypto.randomUUID();
    await pool.query(
      `INSERT INTO gl_journal_entries (id, company_id, entry_date, created_by, description, status, source)
       VALUES ($1, $2, $3, $4, 'budget grid fixture', $5, $6)`,
      [entry, c.id, date, c.user, opts.status ?? 'posted', opts.source ?? 'manual']);
    const net = lines.reduce((s, l) => s + (l.debit ?? 0) - (l.credit ?? 0), 0);
    const all: JournalLine[] = [...lines, ...(net === 0 ? [] : [{ acct: c.acct.bank, debit: net < 0 ? -net : 0, credit: net > 0 ? net : 0 }])];
    for (const l of all) {
      await pool.query(
        `INSERT INTO gl_journal_lines (journal_entry_id, gl_account_id, debit, credit, company_id, cc1_id, cc2_id, bu_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [entry, l.acct, l.debit ?? 0, l.credit ?? 0, c.id, l.cc1 ?? null, l.cc2 ?? null, l.bu ?? null]);
    }
    return entry;
  }

  /** Calls a route as `u` in their company (real withAuth, request transaction, CSRF). */
  async function call(route: unknown, url: string, u: SetupUser, method: string, query: Record<string, string> = {}, body?: unknown): Promise<RouteOut> {
    const req = request({ 'sb-access-token': u.token, active_company_id: u.homeCompanyId }, method) as unknown as
      { url: string; query: Record<string, string>; body: unknown };
    req.url = url;
    req.query = query;
    req.body = body;
    const out = response();
    await (route as (a: never, b: never) => Promise<unknown>)(req as never, out.res as never);
    return { status: out.state.statusCode, body: (out.state.body ?? {}) as RouteOut['body'] };
  }

  async function cleanup(): Promise<void> {
    const ids = companies.map((c) => c.id);
    // Locked versions refuse DELETE (and so the cascade): unlock first, as QA purges do.
    await pool.query(
      `UPDATE budget_versions SET status = 'approved', unlocked_by = locked_by, unlocked_at = clock_timestamp(), unlock_reason = 'test cleanup'
        WHERE company_id = ANY($1) AND status = 'locked'`, [ids]);
    for (const t of ['audit_log', 'budget_month_amounts', 'budget_versions', 'accounting_budgets', 'gl_journal_lines', 'gl_journal_entries', 'cost_centres', 'business_units',
      'gl_accounts', 'fiscal_periods', 'fiscal_years']) {
      await pool.query(`DELETE FROM ${t} WHERE company_id = ANY($1)`, [ids]);
    }
    await pool.query('DELETE FROM company_users WHERE company_id = ANY($1)', [ids]);
    await pool.query('DELETE FROM companies WHERE id = ANY($1)', [ids]);
    await pool.query('DELETE FROM users WHERE id = ANY($1::text[])', [users]);
  }

  return { company, version, amount, amounts, journal, call, cleanup };
}

/** The twelve 'YYYY-MM' months from `start` ('YYYY-MM'), `count` of them. */
export function monthsFrom(start: string, count = 12): string[] {
  const [y, m] = start.split('-').map(Number) as [number, number];
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(Date.UTC(y, m - 1 + i, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  });
}
