/**
 * Budgets P5-2b (breaker PROBE 3 and round 3): bank-first provisionals (R-127) and the slip bills that settle them,
 * on the P5-2 bill fixture (`budgetBillFixture.ts`: opex BB-6100 at CC1 FT 1 000 / HT 0 a month). Seeded as the
 * superuser; `dropBillFixture` removes them with the company.
 */
import type { Pool } from 'pg';
import { fromSlip, makeBill, type BillFixture } from './budgetBillFixture';

/** A posted, evidenced provisional on `date`: one opex line per entry, VAT `vat`, bank credit the total. Returns the slip. */
export async function seedSlipProvisional(
  pool: Pool, f: BillFixture, date: string, opex: Array<{ amount: number; cc1: string | null; cc2?: string | null }>, vat = 120,
): Promise<string> {
  const bank = crypto.randomUUID();
  await pool.query(`INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type, account_subtype, normal_balance, level, is_active)
                    VALUES ($1, $2, $3, 'Bank', 'asset', 'bank', 'debit', 3, true)`, [bank, f.co, `BB-1${bank.slice(0, 4)}`]);
  const doc = crypto.randomUUID();
  await pool.query(`INSERT INTO captured_documents (id, company_id, file_name, file_type) VALUES ($1, $2, 'slip.pdf', 'application/pdf')`, [doc, f.co]);
  const je = crypto.randomUUID();
  await pool.query(`INSERT INTO gl_journal_entries (id, company_id, entry_number, entry_date, description, status, source, source_document_id, needs_evidence, created_by)
                    VALUES ($1, $2, $3, $4, 'Bank-first provisional', 'posted', 'auto_bank_recon', $5, false, $6)`, [je, f.co, `JE-PRV-${je.slice(0, 6)}`, date, doc, f.owner]);
  const total = Math.round((opex.reduce((s, l) => s + l.amount, 0) + vat) * 100) / 100;
  type Row = [string, number, number, string | null, string | null, string | null];
  const lines: Row[] = [
    ...opex.map((l): Row => [f.acc.opex, l.amount, 0, l.cc1, l.cc2 ?? null, null]),
    [f.acc.vat, vat, 0, null, null, 'standard'], [bank, 0, total, null, null, null],
  ];
  for (const [acct, dr, cr, cc1, cc2, vatType] of lines) {
    await pool.query(`INSERT INTO gl_journal_lines (journal_entry_id, company_id, gl_account_id, debit, credit, description, cc1_id, cc2_id, vat_type)
                      VALUES ($1, $2, $3, $4, $5, 'prov', $6, $7, $8)`, [je, f.co, acct, dr, cr, cc1, cc2, vatType]);
  }
  await pool.query(`INSERT INTO bank_transactions (company_id, bank_account_id, transaction_date, amount, status, provisional_je_id, description)
                    VALUES ($1, $2, $3, $4, 'matched', $5, 'card')`, [f.co, bank, date, -total, je]);
  return doc;
}

/** An 800 opex bill (VAT 120) dated `date`, raised from the slip `doc`; `cc1` on its line when given. */
export async function makeSlipBill(pool: Pool, f: BillFixture, doc: string, date: string, cc1: string | null = null, status = 'draft'): Promise<string> {
  const bill = await makeBill(pool, f, [{ acct: f.acc.opex, amount: 800, cc1 }], { date, status });
  await fromSlip(pool, bill, doc);
  return bill;
}

/** The bill's lines' CC1, in line order. */
export const billLineCc1 = async (pool: Pool, bill: string) =>
  (await pool.query('SELECT cc1_id::TEXT AS cc1 FROM supplier_invoice_items WHERE supplier_invoice_id = $1 ORDER BY line_total, id', [bill]))
    .rows.map((r) => r.cc1 as string | null);

/** Posted opex movement in the month per CC1 ('' = none). */
export async function postedOpexBySlice(pool: Pool, f: BillFixture, month: string): Promise<Record<string, number>> {
  const rows = (await pool.query(
    `SELECT COALESCE(jl.cc1_id::TEXT, '') AS cc1, SUM(jl.debit - jl.credit)::FLOAT8 AS net
       FROM gl_journal_lines jl JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
      WHERE je.company_id = $1 AND je.status = 'posted' AND jl.gl_account_id = $2 AND to_char(je.entry_date, 'YYYY-MM') = $3
      GROUP BY 1`, [f.co, f.acc.opex, month])).rows as Array<{ cc1: string; net: number }>;
  return Object.fromEntries(rows.filter((r) => r.net !== 0).map((r) => [r.cc1, r.net]));
}

/**
 * A posted provisional still WAITING for its evidence (needs_evidence, bank line 'provisional', predicted supplier
 * `supplierId`), as `attachEvidenceToProvisional` finds one for a capture of `total` near `date`. Returns its id.
 */
export async function seedUnevidencedProvisional(
  pool: Pool, f: BillFixture, date: string, opex: Array<{ amount: number; cc1: string | null }>, supplierId: string, vat = 120,
): Promise<string> {
  const bank = crypto.randomUUID();
  await pool.query(`INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type, account_subtype, normal_balance, level, is_active)
                    VALUES ($1, $2, $3, 'Bank', 'asset', 'bank', 'debit', 3, true)`, [bank, f.co, `BB-1${bank.slice(0, 4)}`]);
  const je = crypto.randomUUID();
  await pool.query(`INSERT INTO gl_journal_entries (id, company_id, entry_number, entry_date, description, status, source, needs_evidence, created_by)
                    VALUES ($1, $2, $3, $4, 'Bank-first provisional', 'posted', 'auto_bank_recon', true, $5)`, [je, f.co, `JE-PRV-${je.slice(0, 6)}`, date, f.owner]);
  const total = Math.round((opex.reduce((s, l) => s + l.amount, 0) + vat) * 100) / 100;
  for (const [acct, dr, cr, cc1, vatType] of [
    ...opex.map((l) => [f.acc.opex, l.amount, 0, l.cc1, null] as const),
    [f.acc.vat, vat, 0, null, 'standard'] as const, [bank, 0, total, null, null] as const,
  ]) {
    await pool.query(`INSERT INTO gl_journal_lines (journal_entry_id, company_id, gl_account_id, debit, credit, description, cc1_id, vat_type)
                      VALUES ($1, $2, $3, $4, $5, 'prov', $6, $7)`, [je, f.co, acct, dr, cr, cc1, vatType]);
  }
  await pool.query(`INSERT INTO bank_transactions (company_id, bank_account_id, transaction_date, amount, status, provisional_je_id, description, predicted_supplier_id)
                    VALUES ($1, $2, $3, $4, 'provisional', $5, 'card', $6)`, [f.co, bank, date, -total, je, supplierId]);
  return je;
}
