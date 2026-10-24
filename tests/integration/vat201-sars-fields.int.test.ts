/**
 * The VAT201 page's data is the SARS form (fields 1, 1A ... 20), and every field
 * is what `getVat201Report` says: the page API (`getVat201Return`, the one call
 * pages/api/accounting/sars/sars-vat201.ts makes) must agree with the report
 * service box for box, with the legacy field1..11 keys beside it, and must carry
 * nothing from another tenant.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { getVat201Return } from '../../src/modules/accounting/services/reports/vat201LedgerFields';
import { getVat201Report } from '../../src/modules/accounting/services/reports/vat201ReportService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

assertDisposable();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const user = crypto.randomUUID();
const A = crypto.randomUUID();
const B = crypto.randomUUID();
const EMPTY = crypto.randomUUID();
const START = '2026-06-01';
const END = '2026-06-30';

interface Accounts { revenue: string; receivable: string; vatOutput: string; expense: string; payable: string; vatInput: string; asset: string }
const acc = (): Accounts => ({
  revenue: crypto.randomUUID(), receivable: crypto.randomUUID(), vatOutput: crypto.randomUUID(),
  expense: crypto.randomUUID(), payable: crypto.randomUUID(), vatInput: crypto.randomUUID(), asset: crypto.randomUUID(),
});
const accA = acc();
const accB = acc();

async function accounts(company: string, a: Accounts) {
  await pool.query(
    `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance)
     VALUES($1,$8,'S-4000','Sales','revenue','sales','credit'),
           ($2,$8,'S-1100','Receivables','asset','receivable','debit'),
           ($3,$8,'S-2120','VAT output','liability','vat_output','credit'),
           ($4,$8,'S-5000','Consumables','expense','operating_expense','debit'),
           ($5,$8,'S-2100','Payables','liability','payable','credit'),
           ($6,$8,'S-1140','VAT input','asset','vat_input','debit'),
           ($7,$8,'S-1500','Equipment','asset','fixed_asset','debit')`,
    [a.revenue, a.receivable, a.vatOutput, a.expense, a.payable, a.vatInput, a.asset, company],
  );
}
let n = 0;
async function post(company: string, date: string, legs: Array<[string, number, number, string | null]>) {
  const id = crypto.randomUUID();
  n += 1;
  await pool.query(
    `INSERT INTO gl_journal_entries(id,company_id,entry_number,entry_date,description,status,source,created_by)
     VALUES($1,$2,$3,$4,'SARS fields fixture','posted','manual',$5)`,
    [id, company, `SARSF-${n}`, date, user],
  );
  for (const [account, debit, credit, vatType] of legs) {
    await pool.query(
      `INSERT INTO gl_journal_lines(journal_entry_id,company_id,gl_account_id,debit,credit,vat_type)
       VALUES($1,$2,$3,$4,$5,$6)`,
      [id, company, account, debit, credit, vatType],
    );
  }
}

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$4),($2,$5),($3,$6)', [
    A, B, EMPTY, 'SARS fields A', 'SARS fields B (other tenant)', 'SARS fields empty',
  ]);
  await accounts(A, accA);
  await accounts(B, accB);

  // Company A: standard sale R10 000 + R1 500; export R4 000; exempt R2 000;
  // standard purchase R6 000 + R900 and capital purchase R5 000 + R750.
  await post(A, '2026-06-10', [[accA.receivable, 11500, 0, null], [accA.revenue, 0, 10000, 'standard'], [accA.vatOutput, 0, 1500, 'standard']]);
  await post(A, '2026-06-12', [[accA.receivable, 4000, 0, null], [accA.revenue, 0, 4000, 'export']]);
  await post(A, '2026-06-14', [[accA.receivable, 2000, 0, null], [accA.revenue, 0, 2000, 'exempt']]);
  await post(A, '2026-06-18', [[accA.expense, 6000, 0, 'standard'], [accA.vatInput, 900, 0, 'standard'], [accA.payable, 0, 6900, null]]);
  await post(A, '2026-06-20', [[accA.asset, 5000, 0, 'capital_goods'], [accA.vatInput, 750, 0, 'capital_goods'], [accA.payable, 0, 5750, null]]);

  // Company B, same period, very different numbers. None of it may reach A.
  await post(B, '2026-06-11', [[accB.receivable, 1150000, 0, null], [accB.revenue, 0, 1000000, 'standard'], [accB.vatOutput, 0, 150000, 'standard']]);
  await post(B, '2026-06-13', [[accB.receivable, 900000, 0, null], [accB.revenue, 0, 900000, 'export']]);
  await post(B, '2026-06-15', [[accB.expense, 200000, 0, 'standard'], [accB.vatInput, 30000, 0, 'standard'], [accB.payable, 0, 230000, null]]);
});

afterAll(async () => {
  await pool.query('DELETE FROM gl_journal_lines WHERE company_id = ANY($1::uuid[])', [[A, B, EMPTY]]);
  await pool.query('DELETE FROM gl_journal_entries WHERE company_id = ANY($1::uuid[])', [[A, B, EMPTY]]);
  await pool.query('DELETE FROM gl_accounts WHERE company_id = ANY($1::uuid[])', [[A, B, EMPTY]]);
  await pool.query('DELETE FROM companies WHERE id = ANY($1::uuid[])', [[A, B, EMPTY]]);
  await pool.end();
});

function byField(fields: Array<{ field: string; amount: number | null }>): Record<string, number | null> {
  return Object.fromEntries(fields.map((f) => [f.field, f.amount]));
}

describe('getVat201Return — the page API', () => {
  it('returns the SARS form with the values the ledger holds for this company', async () => {
    const ret = await getVat201Return(A, START, END);
    const f = byField(ret.sarsFields);
    expect(f).toMatchObject({
      '1': 11500, '4': 1500, '1A': 0, '4A': 0,
      '2': 0, '2A': 4000, '3': 2000,
      '12': 0, '13': 1500,
      '14': 750, '15': 900, '15A': 0, '16': 0, '17': 0, '18': 0,
      '19': 1650, '20': -150,
    });
    expect(ret.sarsFields.map((x) => x.field)).toHaveLength(25);
  });

  it('equals vat201ReportService box for box, and its totals', async () => {
    const ret = await getVat201Return(A, START, END);
    const report = await getVat201Report(A, START, END, { detail: 'summary' });
    const f = byField(ret.sarsFields);
    const tax = (box: string) => report.boxes.filter((b) => b.box === box).reduce((s, b) => s + b.tax, 0);
    const base = (box: string) => report.boxes.filter((b) => b.box === box).reduce((s, b) => s + b.base, 0);
    expect(f['4']).toBeCloseTo(tax('1'), 2);
    expect(f['1']).toBeCloseTo(base('1') + tax('1'), 2);
    expect(f['14']).toBeCloseTo(tax('14'), 2);
    expect(f['15']).toBeCloseTo(tax('15'), 2);
    expect(f['13']).toBeCloseTo(report.totals.outputTax, 2);
    expect(f['19']).toBeCloseTo(report.totals.inputTax, 2);
    expect(f['20']).toBeCloseTo(report.totals.netVat, 2);
  });

  it('keeps the legacy storage keys equal to the SARS totals, so the page and the filing path cannot disagree', async () => {
    const ret = await getVat201Return(A, START, END);
    const f = byField(ret.sarsFields);
    expect(ret.field5_outputVAT).toBeCloseTo(f['13'] ?? NaN, 2);
    expect(ret.field10_totalInputVAT).toBeCloseTo(f['19'] ?? NaN, 2);
    expect(ret.field11_vatPayableOrRefundable).toBeCloseTo(f['20'] ?? NaN, 2);
  });

  it('carries nothing from another company', async () => {
    const a = byField((await getVat201Return(A, START, END)).sarsFields);
    const b = byField((await getVat201Return(B, START, END)).sarsFields);
    expect(b).toMatchObject({ '1': 1150000, '4': 150000, '2A': 900000, '15': 30000, '13': 150000, '19': 30000, '20': 120000 });
    expect(a['13']).toBe(1500);
    expect(a['2A']).toBe(4000);
  });

  it('gives a company with no postings a form of zeros for what it tracks and dashes for what it does not', async () => {
    const ret = await getVat201Return(EMPTY, START, END);
    const f = byField(ret.sarsFields);
    for (const field of ['1', '4', '2', '2A', '3', '13', '14', '15', '19', '20']) expect(f[field]).toBe(0);
    for (const field of ['5', '6', '7', '8', '9', '10', '11', '14A']) expect(f[field]).toBeNull();
  });
});
