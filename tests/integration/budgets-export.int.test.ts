/**
 * The GL export's budget tables (budget_versions, budgets; FibreFlow contract
 * isaflow-budgets-1.0) against a real database, every read AS app_user with
 * the member's claims (the production app role: forced RLS and the table
 * grants apply), through the builders and through the real route (cookie
 * session, real withAuth).
 *
 * Fixture (budgetGridFixture, FY2027 = Mar 2026 - Feb 2027), company A:
 *  - PRIMARY 'Original' (approved): Sales 1000.10 a month and Interest
 *    received 40 in May at company level; Rent at CC1 grain (250.05 + 149.95
 *    a month); Cost of sales at CC1 grain (500.01 driver + 300.33 manual a
 *    month) with a per_head driver line on its CC1 row; Premises: rates at
 *    CC1 grain (10.00 a month) with a pct_of_line driver on Cost of sales'
 *    CC1 row (a salary-derived line).
 *  - a second, non-primary 'Scenario' (locked), as a copy leaves it: amounts
 *    and NO driver lines. Sales 2000 and Cost of sales 7.77 + 2.23 at two CC1
 *    centres in March.
 * Company B: a primary version of its own, which must never appear; its Cost
 *   of sales has no per_head line anywhere in B, so it stays at its centre.
 * Company C: a version labelled 1400, a year the registry cannot place (its
 *   walk from the nearest stored year gives up), is skipped with a warning;
 *   the rest of C exports.
 * Figures worked by hand in each test.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { als } from '@/lib/als';
import { buildBudgetVersions, buildBudgets } from '@/modules/accounting/services/reports/budgetsExport';
import { getBudgetVariance } from '@/modules/accounting/services/reports/budgetVarianceService';
import { loadGridCells } from '@/modules/accounting/services/budgets/gridReadModel';
import { FiscalYearLabelUnknownError } from '@/modules/accounting/services/gl/fiscalYearRegistry';
import handler from '../../pages/api/accounting/gl-lines-export';
import { assertDisposable, request } from './mfa-impersonation-postgres.helpers';
import { budgetGridFixture, monthsFrom, type Dims, type GridCo } from './helpers/budgetGridFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const fx = budgetGridFixture(pool);
const FY27 = monthsFrom('2026-03');
const cents = (n: unknown) => Math.round(Number(n) * 100);
type Row = Record<string, unknown>;
const sumCents = (rows: Row[]) => rows.reduce((s, r) => s + cents(r.Amount), 0);

let A: GridCo;
let B: GridCo;
let C: GridCo;
const v = { primary: '', scenario: '', other: '', stranded: '', cKept: '' };

async function cell(c: GridCo, versionId: string, acct: string, month: string, value: number, dims: Dims = {}, source = 'manual') {
  await pool.query(
    `INSERT INTO budget_month_amounts (company_id, version_id, gl_account_id, month, amount, cc1_id, cc2_id, bu_id, amount_source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [c.id, versionId, acct, `${month}-01`, value, dims.cc1 ?? null, dims.cc2 ?? null, dims.bu ?? null, source]);
}

/** One request transaction as withAuth opens one: app_user, the owner's claims, the company; rolled back. */
async function asApp<T>(c: GridCo, fn: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE app_user');
    const claims = { sub: c.user, role: 'authenticated', company_id: c.id };
    await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
    await client.query(`SELECT set_config('app.current_company_id', $1, true)`, [c.id]);
    expect((await client.query('SELECT current_user AS u')).rows[0].u).toBe('app_user');
    return await als.run({ client, userId: c.user, companyId: c.id, claims } as never, fn);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

/** GET the real route as the company's owner (cookie session → withAuth → app_user), collecting the streamed CSV. */
async function route(c: GridCo, query: Record<string, string>) {
  const req = request({ 'sb-access-token': c.owner.token, active_company_id: c.id }, 'GET') as unknown as { url: string; query: Record<string, string> };
  req.url = '/api/accounting/gl-lines-export';
  req.query = query;
  const headers = new Map<string, unknown>();
  const chunks: string[] = [];
  const res = {
    statusCode: 200, body: undefined as unknown, headersSent: false, writableEnded: false, destroyed: false,
    status(code: number) { this.statusCode = code; return this; },
    setHeader(k: string, val: unknown) { headers.set(k.toLowerCase(), val); return this; },
    getHeader(k: string) { return headers.get(k.toLowerCase()); },
    removeHeader(k: string) { headers.delete(k.toLowerCase()); },
    json(b: unknown) { this.body = b; return this.end(); },
    send(b: unknown) { this.body = b; return this.end(); },
    write(chunk: string) { this.headersSent = true; chunks.push(chunk); return true; },
    end(chunk?: unknown) { if (typeof chunk === 'string') chunks.push(chunk); this.writableEnded = true; return this; },
    once() { return this; }, off() { return this; }, on() { return this; },
  };
  await (handler as unknown as (q: unknown, s: unknown) => Promise<void>)(req, res);
  return { status: res.statusCode, headers, csv: chunks.join(''), body: res.body as { data?: Row } };
}

beforeAll(async () => {
  A = await fx.company();
  B = await fx.company();
  const a = A.acct;
  v.primary = await fx.version(A, { fy: 2027, name: 'Original', kind: 'original', primary: true });
  for (const m of FY27) {
    await cell(A, v.primary, a.sales, m, 1000.1);
    await cell(A, v.primary, a.rent, m, 250.05, { cc1: A.cc1 });
    await cell(A, v.primary, a.rent, m, 149.95, { cc1: A.cc1b });
    await cell(A, v.primary, a.cos, m, 500.01, { cc1: A.cc1 }, 'driver');
    await cell(A, v.primary, a.cos, m, 300.33, { cc1: A.cc1b });
    await cell(A, v.primary, a.childA, m, 10, { cc1: A.cc1 }, 'driver');
  }
  await cell(A, v.primary, a.otherIncome, '2026-05', 40);
  await pool.query(
    `INSERT INTO budget_driver_lines (company_id, version_id, gl_account_id, cc1_id, kind, from_month, to_month, amount, headcount_cost_centre_id, created_by)
     VALUES ($1, $2, $3, $4, 'per_head', '2026-03-01', '2027-02-01', 25000, $4, $5)`, [A.id, v.primary, a.cos, A.cc1, A.user]);
  await pool.query(
    `INSERT INTO budget_driver_lines (company_id, version_id, gl_account_id, cc1_id, kind, from_month, to_month, pct, ref_gl_account_id, ref_cc1_id, created_by)
     VALUES ($1, $2, $3, $4, 'pct_of_line', '2026-03-01', '2027-02-01', 1.25, $5, $4, $6)`, [A.id, v.primary, a.childA, A.cc1, a.cos, A.user]);
  await pool.query(`UPDATE budget_versions SET status = 'approved', approved_by = $2, approved_at = clock_timestamp() WHERE id = $1`, [v.primary, A.user]);

  v.scenario = await fx.version(A, { fy: 2027, name: 'Scenario', kind: 'scenario' });
  await cell(A, v.scenario, a.sales, '2026-03', 2000);
  await cell(A, v.scenario, a.cos, '2026-03', 7.77, { cc1: A.cc1 });
  await cell(A, v.scenario, a.cos, '2026-03', 2.23, { cc1: A.cc1b });
  await pool.query(`UPDATE budget_versions SET status = 'approved', approved_by = $2, approved_at = clock_timestamp() WHERE id = $1`, [v.scenario, A.user]);
  await pool.query(`UPDATE budget_versions SET status = 'locked', locked_by = $2, locked_at = clock_timestamp() WHERE id = $1`, [v.scenario, A.user]);

  v.other = await fx.version(B, { fy: 2027, name: 'Original', kind: 'original', primary: true });
  await cell(B, v.other, B.acct.sales, '2026-03', 999);
  await cell(B, v.other, B.acct.cos, '2026-03', 55, { cc1: B.cc1 });

  C = await fx.company();
  v.stranded = await fx.version(C, { fy: 1400, name: 'Stranded', kind: 'original' });
  v.cKept = await fx.version(C, { fy: 2027, name: 'Original', kind: 'original', primary: true });
  await cell(C, v.cKept, C.acct.sales, '2026-03', 123.45);
}, 120000);

afterAll(async () => {
  try {
    await pool.query('DELETE FROM budget_driver_lines WHERE company_id = ANY($1)', [[A?.id, B?.id].filter(Boolean)]);
    await pool.query(`DELETE FROM rate_limit_counters WHERE key = ANY($1)`, [[A, B, C].filter(Boolean).map((c) => `report:gl-lines-export:co:${c.id}`)]);
    await fx.cleanup();
  } finally {
    await pool.end();
  }
}, 60000);

describe('budget export tables against a real database, as app_user', () => {
  it('(1) the rows sum to the control total, in cents; (4) X-Row-Count = the rows the CSV carries', async () => {
    const out = await asApp(A, () => buildBudgets(A.id));
    // Primary: 12 × (1000.10 + 400 + 800.34 + 10) + 40; scenario: 2000 + 7.77 + 2.23.
    expect(sumCents(out.rows)).toBe(12 * (100010 + 40000 + 80034 + 1000) + 4000 + 200000 + 1000);
    expect(cents(out.summary.controlTotal)).toBe(sumCents(out.rows));
    expect(out.summary.rowCount).toBe(out.rows.length);

    const res = await route(A, { table: 'budgets' });
    expect(res.status).toBe(200);
    const lines = res.csv.trimEnd().split('\n');
    expect(lines[0]).toBe('Version_ID,GL_Account_ID,GL_Account_Code,Month,CC1_ID,CC2_ID,BU_ID,Amount,Source,Schema_Version');
    expect(lines.length - 1).toBe(out.rows.length);
    expect(res.headers.get('x-row-count')).toBe(String(out.rows.length));
    expect(res.headers.get('x-control-total')).toBe((sumCents(out.rows) / 100).toFixed(2));
    expect(res.headers.get('x-schema-version')).toBe('isaflow-budgets-1.0');
    // Σ the CSV's Amount column (index 7) = the header, in cents.
    expect(lines.slice(1).reduce((s, l) => s + cents(l.split(',')[7]), 0)).toBe(sumCents(out.rows));
  }, 60000);

  it('(2) primary version, Mar-May 2026: Σ rows by revenue and by expense = budget_variance section budgets, to the cent', async () => {
    const { out, variance } = await asApp(A, async () => ({
      out: await buildBudgets(A.id),
      variance: await getBudgetVariance(A.id, '2026-03-01', '2026-05-31'),
    }));
    const window = out.rows.filter((r) => r.Version_ID === v.primary && ['2026-03', '2026-04', '2026-05'].includes(String(r.Month)));
    const revenue = new Set([A.acct.sales, A.acct.otherIncome]);
    const rev = window.filter((r) => revenue.has(String(r.GL_Account_ID)));
    const exp = window.filter((r) => !revenue.has(String(r.GL_Account_ID)));
    expect(sumCents(rev)).toBe(cents(variance.sections.revenue.budget));
    expect(sumCents(exp)).toBe(cents(variance.sections.expense.budget));
    expect(sumCents(rev)).toBe(3 * 100010 + 4000);
    expect(sumCents(exp)).toBe(3 * (40000 + 80034 + 1000));
  }, 60000);

  it('(3) the per_head account and its pct_of_line dependent: company-level per_head_rollup rows only, in EVERY version', async () => {
    const out = await asApp(A, () => buildBudgets(A.id));
    const cos = out.rows.filter((r) => r.Version_ID === v.primary && r.GL_Account_ID === A.acct.cos);
    expect(cos).toHaveLength(12);
    for (const r of cos) {
      expect(r).toMatchObject({ CC1_ID: null, CC2_ID: null, BU_ID: null, Amount: 800.34, Source: 'per_head_rollup', GL_Account_Code: '5000' });
    }
    // The scenario (a copy: no driver lines) must not give the salary cells back at their centres.
    expect(out.rows.filter((r) => r.Version_ID === v.scenario && r.GL_Account_ID === A.acct.cos))
      .toEqual([expect.objectContaining({ CC1_ID: null, CC2_ID: null, BU_ID: null, Amount: 10, Source: 'per_head_rollup', Month: '2026-03' })]);
    // The pct_of_line line on Cost of sales would give the salary back by division: rolled up too.
    const rates = out.rows.filter((r) => r.Version_ID === v.primary && r.GL_Account_ID === A.acct.childA);
    expect(rates).toHaveLength(12);
    for (const r of rates) expect(r).toMatchObject({ CC1_ID: null, CC2_ID: null, BU_ID: null, Amount: 10, Source: 'per_head_rollup' });
    expect(out.rows.some((r) => [A.acct.cos, A.acct.childA].includes(String(r.GL_Account_ID)) && r.CC1_ID !== null)).toBe(false);
    // Rent (no driver) stays at its CC1 grain; every row carries at most one dimension.
    expect(out.rows.filter((r) => r.Version_ID === v.primary && r.GL_Account_ID === A.acct.rent && r.Month === '2026-03').map((r) => r.CC1_ID).sort())
      .toEqual([A.cc1, A.cc1b].sort());
    for (const r of out.rows) expect([r.CC1_ID, r.CC2_ID, r.BU_ID].filter((x) => x !== null).length).toBeLessThanOrEqual(1);
    // No rate, no headcount: the table's columns are the contract's, nothing more.
    expect(out.columns).toEqual(['Version_ID', 'GL_Account_ID', 'GL_Account_Code', 'Month', 'CC1_ID', 'CC2_ID', 'BU_ID', 'Amount', 'Source', 'Schema_Version']);
  }, 60000);

  it('(5) another company\'s versions and cells never appear (builders and route)', async () => {
    const versions = await asApp(A, () => buildBudgetVersions(A.id));
    expect(versions.rows.map((r) => r.Version_ID)).toEqual([v.primary, v.scenario].sort());
    const out = await asApp(A, () => buildBudgets(A.id));
    expect(new Set(out.rows.map((r) => r.Version_ID))).toEqual(new Set([v.primary, v.scenario]));
    const bAccounts = new Set(Object.values(B.acct));
    expect(out.rows.filter((r) => bAccounts.has(String(r.GL_Account_ID)))).toEqual([]);
    const res = await route(A, { table: 'budget_versions' });
    expect(res.csv).not.toContain(v.other);
    // B sees only its own.
    const theirs = await asApp(B, () => buildBudgets(B.id));
    expect(theirs.rows.map((r) => r.Version_ID)).toEqual([v.other, v.other]);
    // A's per_head line does not reach B: B's cost of sales stays at its centre.
    expect(theirs.rows.find((r) => r.GL_Account_ID === B.acct.cos)).toMatchObject({ CC1_ID: B.cc1, Amount: 55, Source: 'manual' });
  }, 60000);

  it('a version whose financial year label the registry does not carry is skipped; the rest of the company exports (route 200)', async () => {
    // The premise: the grid read refuses the stranded version.
    await expect(asApp(C, () => loadGridCells(C.id, { versionId: v.stranded }))).rejects.toBeInstanceOf(FiscalYearLabelUnknownError);
    const versions = await asApp(C, () => buildBudgetVersions(C.id));
    expect(versions.rows.map((r) => r.Version_ID).sort()).toEqual([v.stranded, v.cKept].sort());
    const out = await asApp(C, () => buildBudgets(C.id));
    expect(out.rows).toEqual([expect.objectContaining({ Version_ID: v.cKept, Month: '2026-03', Amount: 123.45 })]);
    const res = await route(C, { table: 'budgets' });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-control-total')).toBe('123.45');
  }, 60000);

  it('budget_versions: the version facts, token text as the services give it, no X-Control-Total', async () => {
    const versions = await asApp(A, () => buildBudgetVersions(A.id));
    const byId = new Map(versions.rows.map((r) => [r.Version_ID, r]));
    expect(byId.get(v.primary)).toMatchObject({ Fiscal_Year: 2027, Name: 'Original', Kind: 'original', Status: 'approved', Is_Primary: true, Locked_At: null });
    expect(byId.get(v.scenario)).toMatchObject({ Kind: 'scenario', Status: 'locked', Is_Primary: false });
    for (const r of versions.rows) expect(String(r.Updated_At)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
    const token = (await pool.query(
      `SELECT to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS t FROM budget_versions WHERE id = $1`, [v.primary])).rows[0].t;
    expect(byId.get(v.primary)!.Updated_At).toBe(token);

    const res = await route(A, { table: 'budget_versions' });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-row-count')).toBe('2');
    expect(res.headers.has('x-control-total')).toBe(false);
    const manifest = await route(A, { table: 'budgets', manifest: '1' });
    expect(manifest.body.data).toMatchObject({ table: 'budgets', schemaVersion: 'isaflow-budgets-1.0' });
  }, 60000);
});
