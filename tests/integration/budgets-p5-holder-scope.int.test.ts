/**
 * Budgets P5-6 r2 (spec §3f, the holder's work view): the grid's side doors (the Excel template, the
 * import preview and prior actuals) are scoped to a holder's slices like the grid. A work scope, not
 * access control (managers read every budget in reports); the import refusal is write integrity.
 * Owners and admins see everything, as before.
 * World: the holder holds CC1 (Rent budgeted there, 10 a month; PY actual 1 234.56); Sales is budgeted
 * at company level (99 999, nobody's slice they hold) with a PY actual of 7 777.77 untagged.
 *
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import ExcelJS from 'exceljs';
import saveRoute from '../../pages/api/accounting/budget-grid/save';
import templateRoute from '../../pages/api/accounting/budget-grid/template';
import previewRoute from '../../pages/api/accounting/budget-grid/import-preview';
import priorRoute from '../../pages/api/accounting/budget-grid/prior-actuals';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { budgetHoldersFixture, errCodeOf, type GridWorld } from './helpers/budgetHoldersFixture';
import { downloadTemplate, editWorkbook, budgetSheet, setCell, uploadPreview } from './helpers/budgetImportFixture';
import type { SetupUser } from './helpers/onboardingSetupFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
const fx = budgetHoldersFixture(pool, saveRoute);
let w: GridWorld;
let holder: SetupUser;
let v: string;
const SECRET_BUDGET = 99999;
const SECRET_ACTUAL = 7777.77;
const MINE_ACTUAL = 1234.56;

/** Every value in every sheet of the workbook, as text. */
async function allValues(file: Buffer): Promise<string> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(file as unknown as ArrayBuffer);
  const out: string[] = [];
  wb.eachSheet((ws) => ws.eachRow((row) => row.eachCell((c) => { out.push(String(c.value)); })));
  return out.join('|');
}
const prior = (u: SetupUser, grain: string) => fx.call(priorRoute, u, 'GET', { query: { fiscal_year: String(w.label), grain } });
const priorAmounts = (r: { body: { data?: unknown } }) => (r.body.data as { cells: Array<{ amount: number }> }).cells.map((c) => c.amount);

/** One posted journal: `debit` on `acct` (with dims), the other side on the world's asset account. */
async function journal(date: string, acct: string, amount: number, dims: { cc1?: string } = {}, credit = false) {
  const id = crypto.randomUUID();
  await pool.query(`INSERT INTO gl_journal_entries (id, company_id, entry_date, created_by, description, status, source)
                    VALUES ($1, $2, $3, $4, 'p5-6 scope fixture', 'posted', 'manual')`, [id, w.u.homeCompanyId, date, w.u.userId]);
  await pool.query(`INSERT INTO gl_journal_lines (journal_entry_id, gl_account_id, debit, credit, company_id, cc1_id) VALUES
                    ($1, $2, $3, $4, $5, $6), ($1, $7, $4, $3, $5, NULL)`,
  [id, acct, credit ? 0 : amount, credit ? amount : 0, w.u.homeCompanyId, dims.cc1 ?? null, w.asset]);
}

beforeAll(async () => {
  w = await fx.world();
  holder = await fx.member(w.u.homeCompanyId, 'manager');
  v = await fx.version(w);
  for (const m of w.months) {
    await fx.amount(w, v, w.rent, m, 10, { cc1: w.cc1 });
    await fx.amount(w, v, w.sales, m, SECRET_BUDGET);
  }
  await fx.hold(w, v, holder.userId, { cc1: w.cc1 });
  const py = `${Number(w.months[0]!.slice(0, 4)) - 1}${w.months[0]!.slice(4)}-15`;
  await journal(py, w.rent, MINE_ACTUAL, { cc1: w.cc1 });
  await journal(py, w.sales, SECRET_ACTUAL, {}, true);
}, 120_000);
afterAll(async () => {
  try {
    await pool.query('DELETE FROM gl_journal_lines WHERE company_id = $1', [w.u.homeCompanyId]);
    await pool.query('DELETE FROM gl_journal_entries WHERE company_id = $1', [w.u.homeCompanyId]);
    await fx.cleanup();
  } finally { await pool.end(); }
}, 120_000);

describe('prior actuals', () => {
  it('a holder gets only their slices\' members (no company level they do not hold); the owner gets everything', async () => {
    expect(priorAmounts(await prior(holder, 'cc1'))).toEqual([MINE_ACTUAL]);
    expect(priorAmounts(await prior(holder, 'company'))).toEqual([]);
    expect(JSON.stringify((await prior(holder, 'cc2')).body)).not.toContain('7777');
    expect(priorAmounts(await prior(w.u, 'company')).sort()).toEqual([MINE_ACTUAL, SECRET_ACTUAL].sort());
  });
});

describe('Excel template', () => {
  it('a holder\'s template carries no other slice\'s budget or prior actual, at any grain; the owner\'s does', async () => {
    for (const grain of ['company', 'cc1', 'cc2', 'bu']) {
      const r = await downloadTemplate(templateRoute, holder, { version_id: v, grain });
      expect(r.status, JSON.stringify(r.json).slice(0, 300)).toBe(200);
      const text = await allValues(r.file!);
      expect(text, grain).not.toContain(String(SECRET_BUDGET));
      expect(text, grain).not.toContain('7777');
    }
    const mine = await allValues((await downloadTemplate(templateRoute, holder, { version_id: v, grain: 'cc1' })).file!);
    expect(mine).toContain('1234.56');
    const owners = await allValues((await downloadTemplate(templateRoute, w.u, { version_id: v, grain: 'company' })).file!);
    expect(owners).toContain(String(SECRET_BUDGET));
  });
});

describe('import preview', () => {
  it('a holder\'s file touching another slice is refused (403) without echoing any figure of it; their own slice previews', async () => {
    // Their own company-level template (Sales shows blank to them) with a Sales figure typed in.
    const theirs = (await downloadTemplate(templateRoute, holder, { version_id: v, grain: 'company' })).file!;
    const edited = await editWorkbook(theirs, (wb) => setCell(budgetSheet(wb), 'GS-4000', w.months[1]!, 5));
    const r = await uploadPreview(previewRoute, holder, v, edited);
    expect([r.status, errCodeOf(r)], JSON.stringify(r.body).slice(0, 300)).toEqual([403, 'BUDGET_SLICE_FORBIDDEN']);
    expect(JSON.stringify(r.body)).not.toContain(String(SECRET_BUDGET));

    const mine = (await downloadTemplate(templateRoute, holder, { version_id: v, grain: 'cc1' })).file!;
    const ok = await uploadPreview(previewRoute, holder, v, mine);
    expect(ok.status, JSON.stringify(ok.body).slice(0, 300)).toBe(200);
    expect(JSON.stringify(ok.body)).not.toContain(String(SECRET_BUDGET));
  });
});
