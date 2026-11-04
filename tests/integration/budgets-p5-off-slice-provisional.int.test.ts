/**
 * Budgets P5-2b, breaker PROBE 3 (Hein's ruling, 2026-11-04): a bill that settles a bank-first provisional (R-127)
 * and whose line names NO cost centre / BU inherits the provisional's dimensions on the same account (its one line
 * there; of several, the one matching the amount; else nothing is guessed). The posted bill then lands where the
 * provisional did, the reclass nets to zero per slice, and no off-slice refusal follows. The inherited dimensions
 * are stored on the bill's line. Approve and Post to GL both. Real PostgreSQL as app_user through the action route.
 * Fixture: opex BB-6100 at CC1 FT 1 000 / HT 0 a month (FY2027). Fixture route: isaflow_schema_fixture. Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import actionRoute from '../../pages/api/accounting/supplier-invoices-action';
import bulkRoute from '../../pages/api/accounting/supplier-invoices-bulk-action';
import remainingRoute from '../../pages/api/accounting/budgets/remaining';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import {
  billState, callRoute, dropBillFixture, eventsFor, fromSlip, makeBill, seedBillFixture, setPolicy, type BillFixture,
} from './helpers/budgetBillFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
let f: BillFixture;

beforeAll(async () => { f = await seedBillFixture(pool, 'off-slice-prov'); }, 60_000);
afterAll(async () => {
  try {
    await pool.query('DELETE FROM rate_limit_counters WHERE key = ANY($1::TEXT[])',
      [[f.owner, f.manager].flatMap((u) => [`supplier-invoice-action:${u}`, `supplier-invoice-bulk:${u}`, `budget-remaining:${u}`])]);
    await dropBillFixture(pool, f);
  } finally { await pool.end(); }
}, 60_000);

const approve = (invoiceId: string, extra: Record<string, unknown> = {}) =>
  callRoute(actionRoute as never, f, f.manager, '/api/accounting/supplier-invoices-action', { action: 'approve', invoiceId, ...extra });

/** A posted, evidenced bank-first provisional on `date`: one opex line per entry, VAT 120, bank credit the total. */
async function provisional(date: string, opex: Array<{ amount: number; cc1: string | null }>): Promise<string> {
  const bank = crypto.randomUUID();
  await pool.query(`INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type, account_subtype, normal_balance, level, is_active)
                    VALUES ($1, $2, $3, 'Bank', 'asset', 'bank', 'debit', 3, true)`, [bank, f.co, `BB-1${bank.slice(0, 4)}`]);
  const doc = crypto.randomUUID();
  await pool.query(`INSERT INTO captured_documents (id, company_id, file_name, file_type) VALUES ($1, $2, 'slip.pdf', 'application/pdf')`, [doc, f.co]);
  const je = crypto.randomUUID();
  await pool.query(`INSERT INTO gl_journal_entries (id, company_id, entry_number, entry_date, description, status, source, source_document_id, needs_evidence, created_by)
                    VALUES ($1, $2, $3, $4, 'Bank-first provisional', 'posted', 'auto_bank_recon', $5, false, $6)`, [je, f.co, `JE-PRV-${je.slice(0, 6)}`, date, doc, f.owner]);
  const total = opex.reduce((s, l) => s + l.amount, 0) + 120;
  const lines: Array<[string, number, number, string | null, string | null]> = [
    ...opex.map((l): [string, number, number, string | null, string | null] => [f.acc.opex, l.amount, 0, l.cc1, null]),
    [f.acc.vat, 120, 0, null, 'standard'], [bank, 0, total, null, null],
  ];
  for (const [acct, dr, cr, cc, vat] of lines) {
    await pool.query(`INSERT INTO gl_journal_lines (journal_entry_id, company_id, gl_account_id, debit, credit, description, cc1_id, vat_type)
                      VALUES ($1, $2, $3, $4, $5, 'prov', $6, $7)`, [je, f.co, acct, dr, cr, cc, vat]);
  }
  await pool.query(`INSERT INTO bank_transactions (company_id, bank_account_id, transaction_date, amount, status, provisional_je_id, description)
                    VALUES ($1, $2, $3, $4, 'matched', $5, 'card')`, [f.co, bank, date, -total, je]);
  return doc;
}
/** An 800 opex bill (VAT 120) dated `date`, raised from the slip `doc`; `cc1` on its line when given. */
async function slipBill(doc: string, date: string, cc1: string | null = null, status = 'draft'): Promise<string> {
  const bill = await makeBill(pool, f, [{ acct: f.acc.opex, amount: 800, cc1 }], { date, status });
  await fromSlip(pool, bill, doc);
  return bill;
}
const lineCc1 = async (bill: string) =>
  (await pool.query('SELECT cc1_id::TEXT AS cc1 FROM supplier_invoice_items WHERE supplier_invoice_id = $1', [bill])).rows.map((r) => r.cc1 as string | null);
/** Posted opex movement in the month per CC1 ('' = none). */
async function opexBySlice(month: string): Promise<Record<string, number>> {
  const rows = (await pool.query(
    `SELECT COALESCE(jl.cc1_id::TEXT, '') AS cc1, SUM(jl.debit - jl.credit)::FLOAT8 AS net
       FROM gl_journal_lines jl JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
      WHERE je.company_id = $1 AND je.status = 'posted' AND jl.gl_account_id = $2 AND to_char(je.entry_date, 'YYYY-MM') = $3
      GROUP BY 1`, [f.co, f.acc.opex, month])).rows as Array<{ cc1: string; net: number }>;
  return Object.fromEntries(rows.filter((r) => r.net !== 0).map((r) => [r.cc1, r.net]));
}

describe('a slip bill with no centre inherits the provisional\'s', () => {
  it('approve, block: approved and settled, the line stored on FT, the bill posted on FT, the month nets 800 on FT and nothing unassigned', async () => {
    await setPolicy(pool, f, 'block');
    const doc = await provisional('2026-09-10', [{ amount: 800, cc1: f.cc.FT }]);
    const bill = await slipBill(doc, '2026-09-12');
    const r = await approve(bill);
    expect(r.statusCode, JSON.stringify(r.body)).toBe(200);
    expect((await billState(pool, bill)).status).toBe('paid'); // the provisional settles it
    expect(await lineCc1(bill)).toEqual([f.cc.FT]);
    expect(await opexBySlice('2026-09')).toEqual({ [f.cc.FT]: 800 });
    expect((await eventsFor(pool, bill)).map((e) => e.outcome)).toEqual(['pass']);
  });

  it('Post to GL (bulk route) of an approved bill with no journal, block: posted on FT', async () => {
    await setPolicy(pool, f, 'block');
    const doc = await provisional('2026-10-10', [{ amount: 800, cc1: f.cc.FT }]);
    const bill = await slipBill(doc, '2026-10-12', null, 'approved');
    const r = await callRoute(bulkRoute as never, f, f.manager, '/api/accounting/supplier-invoices-bulk-action', { action: 'post_gl', invoiceIds: [bill] });
    expect(r.statusCode, JSON.stringify(r.body)).toBe(200);
    expect((r.body.data as { results: Array<{ ok: boolean }> }).results, JSON.stringify(r.body)).toEqual([expect.objectContaining({ ok: true })]);
    expect((await billState(pool, bill)).gl_journal_entry_id).not.toBeNull();
    expect(await lineCc1(bill)).toEqual([f.cc.FT]);
    expect(await opexBySlice('2026-10')).toEqual({ [f.cc.FT]: 800 });
  });

  it('the preview agrees (nothing written): the bill line on FT, nothing flagged; the line itself still names none', async () => {
    await setPolicy(pool, f, 'block');
    const doc = await provisional('2027-01-10', [{ amount: 800, cc1: f.cc.FT }]);
    const bill = await slipBill(doc, '2027-01-12');
    const r = await callRoute(remainingRoute as never, f, f.manager, '/api/accounting/budgets/remaining', { supplierInvoiceId: bill });
    expect(r.statusCode, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toMatchObject({ overCount: 0 });
    expect((r.body.data as { lines: Array<{ cc1Id: string | null; offSlice: boolean }> }).lines.every((l) => l.cc1Id === f.cc.FT && !l.offSlice)).toBe(true);
    expect(await lineCc1(bill)).toEqual([null]);
  });

  it('a line that already names a centre keeps it (HT), warn', async () => {
    await setPolicy(pool, f, 'warn');
    const doc = await provisional('2026-11-10', [{ amount: 800, cc1: f.cc.FT }]);
    const bill = await slipBill(doc, '2026-11-12', f.cc.HT);
    expect((await approve(bill, { budgetReason: 'moved to HT' })).statusCode).toBe(200);
    expect(await lineCc1(bill)).toEqual([f.cc.HT]);
    expect(await opexBySlice('2026-11')).toEqual({ [f.cc.HT]: 800 }); // posted where the line says; the reclass took FT's
  });

  it('two provisional lines on the account, neither matching the amount: nothing guessed, refused off-slice in block', async () => {
    await setPolicy(pool, f, 'block');
    const doc = await provisional('2026-12-10', [{ amount: 400, cc1: f.cc.FT }, { amount: 400, cc1: f.cc.HT }]);
    const bill = await slipBill(doc, '2026-12-12');
    const r = await approve(bill);
    expect(r.statusCode).toBe(409);
    expect(r.body.error?.message).toContain('BB-6100 Opex · no cost centre 1 · 2026-12: not in a budgeted slice');
    expect(await lineCc1(bill)).toEqual([null]);
    expect((await billState(pool, bill)).status).toBe('draft');
  });
});
