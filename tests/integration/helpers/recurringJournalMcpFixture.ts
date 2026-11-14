/**
 * Fixture for the recurring-journal MCP suites: a company with an expense, an accruals and a VAT Output account,
 * open monthly fiscal periods for last month and this month, and recurring templates planted directly. The tools
 * run the way the bearer pipeline runs them: one pooled client, BEGIN, the ALS request context bound to it.
 *
 * Dates are relative to the business day (SAST) the database reports, so the suites hold on any day: `prev` is the
 * whole of last month (every run in it is due), `cur` is this month, `next` next month.
 */
import type { Pool, PoolClient } from 'pg';
import { als } from '@/lib/als';
import type { McpToolContext, McpToolResult } from '@/lib/mcp/types';

export interface Month { period: string; start: string; end: string; lastDay: number }
export interface Calendar { today: string; prev: Month; cur: Month; next: Month; before: Month }
export interface Co { c: string; exp: string; accrual: string; vatOut: string }

function month(year: number, m: number): Month {
  const d = new Date(Date.UTC(year, m - 1, 1));
  const y = d.getUTCFullYear();
  const mm = d.getUTCMonth() + 1;
  const lastDay = new Date(Date.UTC(y, mm, 0)).getUTCDate();
  const period = `${y}-${String(mm).padStart(2, '0')}`;
  return { period, start: `${period}-01`, end: `${period}-${String(lastDay).padStart(2, '0')}`, lastDay };
}

export async function calendar(pool: Pool): Promise<Calendar> {
  const today = String((await pool.query(
    "SELECT (NOW() AT TIME ZONE 'Africa/Johannesburg')::DATE::TEXT AS d")).rows[0].d);
  const [y, m] = today.split('-').map(Number) as [number, number];
  return { today, before: month(y, m - 2), prev: month(y, m - 1), cur: month(y, m), next: month(y, m + 1) };
}

export const day = (mo: Month, d: number) => `${mo.period}-${String(d).padStart(2, '0')}`;

/** A company with three accounts and OPEN periods for `months` (one row each, holding only its own dates). */
export async function company(pool: Pool, user: string, months: Month[], companies: string[]): Promise<Co> {
  const c = crypto.randomUUID();
  companies.push(c);
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [c, `RJMCP ${c.slice(0, 8)}`]);
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'owner')", [c, user]);
  const ids: string[] = [];
  for (const [code, type, normal, subtype] of [['6100', 'expense', 'debit', null], ['2400', 'liability', 'credit', null],
    ['2120', 'liability', 'credit', 'vat_output']] as const) {
    const { rows } = await pool.query(
      `INSERT INTO gl_accounts(company_id,account_code,account_name,account_type,normal_balance,account_subtype,level,is_active)
       VALUES($1,$2,$3,$4,$5,$6,3,true) RETURNING id`, [c, `${code}-${c.slice(0, 4)}`, `RJMCP ${code}`, type, normal, subtype]);
    ids.push(String(rows[0].id));
  }
  for (const mo of months) {
    await pool.query(
      `INSERT INTO fiscal_periods(company_id,period_name,period_number,fiscal_year,start_date,end_date,status)
       VALUES($1,$2,$3,$4,$5::DATE,$6::DATE,'open')`,
      [c, `RJMCP ${mo.period}`, Number(mo.period.slice(5)), Number(mo.period.slice(0, 4)), mo.start, mo.end]);
  }
  return { c, exp: ids[0]!, accrual: ids[1]!, vatOut: ids[2]! };
}

/** A recurring template, as the app's own table holds it. Lines DR exp / CR `credit` (default accruals). */
export async function plantTemplate(pool: Pool, co: Co, user: string, opts: {
  name: string; frequency: string; next: string; amount?: number; autoPost?: boolean; credit?: string; endDate?: string;
}): Promise<string> {
  const id = crypto.randomUUID();
  const amount = opts.amount ?? 500;
  const lines = [
    { glAccountId: co.exp, debit: amount, credit: 0, description: `${opts.name} DR` },
    { glAccountId: opts.credit ?? co.accrual, debit: 0, credit: amount, description: `${opts.name} CR` },
  ];
  await pool.query(
    `INSERT INTO recurring_journals(id,company_id,template_name,frequency,next_run_date,end_date,lines,total_amount,created_by,auto_post)
     VALUES($1,$2,$3,$4,$5::DATE,$6::DATE,$7::JSONB,$8,$9,$10)`,
    [id, co.c, opts.name, opts.frequency, opts.next, opts.endDate ?? null, JSON.stringify(lines), amount, user,
      opts.autoPost ?? true]);
  return id;
}

export const ctxFor = (co: Co, user: string, scopes: string[]) =>
  ({ companyId: co.c, userId: user, tokenJti: 'jti-rjmcp', scopes, companyRole: 'owner' }) as unknown as McpToolContext;

/** Run `fn` on `client` with the request context bound (no BEGIN/COMMIT: the caller owns the transaction). */
export function onClient<T>(client: PoolClient, co: Co, user: string, fn: () => Promise<T>): Promise<T> {
  return als.run({ client, userId: user, companyId: co.c, claims: {} } as never, fn);
}

/** One committed request: BEGIN, `fn` with ALS bound, COMMIT (ROLLBACK when it throws). */
export async function request<T>(pool: Pool, co: Co, user: string, fn: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await onClient(client, co, user, fn);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export const parsed = (r: McpToolResult) => JSON.parse(r.content[0]!.text) as Record<string, unknown>;

export interface JournalRow { id: string; entry_date: string; status: string; source: string; posting_agent: string }

export async function journals(pool: Pool, co: Co): Promise<JournalRow[]> {
  return (await pool.query(
    `SELECT id, entry_date::TEXT AS entry_date, status, source, posting_agent FROM gl_journal_entries
     WHERE company_id = $1 ORDER BY entry_date, id`, [co.c])).rows as JournalRow[];
}

export async function templateState(pool: Pool, id: string): Promise<{ next: string; runs: number; status: string }> {
  const r = (await pool.query(
    'SELECT next_run_date::TEXT AS next, run_count, status FROM recurring_journals WHERE id = $1', [id])).rows[0];
  return { next: String(r.next), runs: Number(r.run_count), status: String(r.status) };
}

/** The weekly run dates from the 1st to the month's end. */
export const weeklyDays = (mo: Month) => [1, 8, 15, 22, 29].filter((d) => d <= mo.lastDay).map((d) => day(mo, d));
