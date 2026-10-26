/**
 * Budgets P2 PR-B round 2, ruling Q1 (VER-M1): which rows a dimension-grain template holds, and
 * how many. By default a member is offered when it holds amounts in this version at that grain or
 * had activity there in the prior year; `members` (a comma list of ids, each the company's member
 * of that kind) names them instead. The rows are capped so a full commit fits one save
 * (floor(MAX_SAVE_CELLS / months), the import's row limit too), refused 400 above it. VER-L3: a
 * template at the cap, filled with 12-digit amounts and 60-character names and re-saved, imports.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import ExcelJS from 'exceljs';
import templateRoute from '../../pages/api/accounting/budget-grid/template';
import previewRoute from '../../pages/api/accounting/budget-grid/import-preview';
import { MAX_SAVE_CELLS } from '@/modules/accounting/services/budgets/gridSaveValidate';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { budgetGridFixture, type GridCo } from './helpers/budgetGridFixture';
import { budgetSheet, col, downloadTemplate, editWorkbook, uploadPreview } from './helpers/budgetImportFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const fx = budgetGridFixture(pool);
const CAP = Math.floor(MAX_SAVE_CELLS / 12);

let A: GridCo, B: GridCo, v: string;
const template = (c: GridCo, versionId: string, query: Record<string, string> = {}) =>
  downloadTemplate(templateRoute, c.owner, { version_id: versionId, grain: 'cc1', ...query });
async function members(file: Buffer): Promise<string[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(file as unknown as ArrayBuffer);
  const ws = budgetSheet(wb);
  const d = col(ws, 'Dimension code');
  const out = new Set<string>();
  for (let r = 2; r <= ws.rowCount; r++) out.add(String(ws.getRow(r).getCell(d).value));
  return [...out].sort();
}

beforeAll(async () => {
  A = await fx.company();
  B = await fx.company();
  v = await fx.version(A, { name: 'Members' });
  await fx.amount(A, v, A.acct.rent, '2026-03', 10, { cc1: A.cc1 }); // GC1 holds an amount
  await fx.journal(A, '2025-06-15', [{ acct: A.acct.cos, debit: 50, cc1: A.cc1b }]); // GC1B had PY activity
}, 120000);

afterAll(async () => { try { await fx.cleanup(); } finally { await pool.end(); } }, 600000);

describe('Q1: the members a dimension template offers', () => {
  it('by default: members holding amounts or with prior-year activity, never every active member', async () => {
    const extra = crypto.randomUUID();
    await pool.query(`INSERT INTO cost_centres (id, company_id, code, name, cc_type, is_active) VALUES ($1, $2, 'IDLE', 'Idle', 'cc1', true)`, [extra, A.id]);
    const r = await template(A, v);
    expect(r.status, JSON.stringify(r.json).slice(0, 300)).toBe(200);
    expect(await members(r.file!)).toEqual(['GC1', 'GC1B']);
  });

  it('VER-L7 / Q3a: the instructions never tell users to copy a row as is, or old values into a fresh file', async () => {
    const r = await template(A, v);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(r.file! as unknown as ArrayBuffer);
    const text: string[] = [];
    wb.getWorksheet('Instructions')!.eachRow((row) => text.push(String(row.getCell(1).value ?? '')));
    const all = text.join('\n');
    expect(all).not.toMatch(/copying one and changing its amounts only/i);
    expect(all).toMatch(/download a fresh template and make your changes in it/i);
    expect(all).toMatch(/do not copy amounts from an older file/i);
  });

  it('`members` names them instead', async () => {
    const r = await template(A, v, { members: `${A.cc1b}` });
    expect(r.status, JSON.stringify(r.json).slice(0, 300)).toBe(200);
    expect(await members(r.file!)).toEqual(['GC1B']);
  });

  it.each([
    ['another company\'s member', () => ({ members: B.cc1 })],
    ['a CC2 member on a CC1 template', () => ({ members: A.cc2 })],
    ['an id that is not a uuid', () => ({ members: 'nope' })],
    ['members on a company template', () => ({ members: A.cc1, grain: 'company' })],
  ])('refuses %s', async (_label, query) => {
    const r = await template(A, v, query());
    expect(r.status, JSON.stringify(r.json).slice(0, 300)).toBe(400);
  });
});

describe('Q5: template downloads are rate limited per member', () => {
  it('the 61st download in 15 minutes is a 429', async () => {
    const C = await fx.company();
    const vC = await fx.version(C, { name: 'Rate' });
    const statuses: number[] = [];
    for (let i = 0; i < 61; i++) statuses.push((await downloadTemplate(templateRoute, C.viewer, { version_id: vC, grain: 'company' })).status);
    expect(statuses.slice(0, 60).every((s) => s === 200)).toBe(true);
    expect(statuses[60]).toBe(429);
    expect((await downloadTemplate(templateRoute, C.owner, { version_id: vC, grain: 'company' })).status).toBe(200); // another member's bucket
  }, 300000);
});

describe('Q1 / VER-L3: rows are capped at one save; a template at the cap imports', () => {
  let Big: GridCo, vBig: string, ids: string[];
  beforeAll(async () => {
    Big = await fx.company();
    await pool.query(`UPDATE gl_accounts SET is_active = false WHERE company_id = $1 AND id <> $2`, [Big.id, Big.acct.sales]);
    ids = (await pool.query(
      `INSERT INTO cost_centres (id, company_id, code, name, cc_type, is_active)
       SELECT gen_random_uuid(), $1, 'M' || lpad(g::text, 6, '0'), rpad('Member ' || g || ' ', 60, 'x'), 'cc1', true FROM generate_series(1, $2::int) g
       RETURNING id`, [Big.id, CAP + 1])).rows.map((r) => String(r.id));
    vBig = await fx.version(Big, { name: 'Big' });
  }, 300000);

  it(`refuses one row past the cap (${CAP + 1}) and says to pick fewer members`, async () => {
    const r = await template(Big, vBig, { members: ids.join(',') });
    expect(r.status).toBe(400);
    expect(r.json?.error?.message).toMatch(new RegExp(`${CAP + 1}.*${CAP}.*fewer members`));
  }, 120000);

  it('a template at the cap, filled with 12-digit amounts and re-saved, imports with no error', async () => {
    const at = ids.slice(0, CAP);
    await pool.query(
      `INSERT INTO budget_month_amounts (company_id, version_id, gl_account_id, month, amount, cc1_id)
       SELECT $1, $2, $3, m::date, 123456789012.34, cc
         FROM unnest($4::uuid[]) cc CROSS JOIN generate_series('2026-03-01'::date, '2027-02-01'::date, interval '1 month') m`,
      [Big.id, vBig, Big.acct.sales, at]);
    const t = await template(Big, vBig);
    expect(t.status, JSON.stringify(t.json).slice(0, 300)).toBe(200);
    const resaved = await editWorkbook(t.file!, (wb) => { budgetSheet(wb).getRow(2).getCell(col(budgetSheet(wb), '2026-03')).value = 999999999999.99; });
    const r = await uploadPreview(previewRoute, Big.owner, vBig, resaved);
    expect(r.status, JSON.stringify(r.body).slice(0, 300)).toBe(200);
    const p = r.body.data as unknown as { changes: unknown[]; errors: unknown[]; counts: { unchanged: number } };
    expect(p.errors).toEqual([]);
    expect(p.changes).toHaveLength(1);
    expect(p.counts.unchanged).toBe(CAP * 12 - 1);
  }, 900000);
});
