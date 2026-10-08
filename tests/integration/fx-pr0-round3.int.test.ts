/**
 * FX PR0 review round 3:
 *
 * - Probe S: a legacy foreign DRAFT bill that already carries a journal, once
 *   the switch is off, is refused by approve with the worded 400 — not the
 *   database gate's raw FX_DOCUMENTS_DISABLED text from the reuse branch.
 * - postJournalEntry refuses ANY journal (whatever its source) that a foreign
 *   document links to while the switch is off — one case per document type —
 *   and only the posting company's documents count.
 * - invoicesPayable throws a ReceiptRefusal, the class the routes answer 400.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { createUser, enableFxDocuments, plantBill } from './r035-approval.helpers';
import { cleanupPr3, noteCompany, plantNote } from './r035-pr3.helpers';
import { plantInvoice } from './r035-pr4.helpers';
import { messageOf, routes } from './r035-pr2.helpers';
import { als } from '@/lib/als';
import { postJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostService';
import { invoicesPayable } from '@/modules/accounting/services/ar/invoicesPayable';
import { ReceiptRefusal } from '@/modules/accounting/services/ar/receiptRefusal';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let owner = '';
const ap = routes(tokens);

beforeAll(async () => { owner = await createUser(pool, tokens); });
afterAll(async () => {
  for (const table of ['customer_invoices', 'supplier_invoices', 'credit_notes']) {
    await pool.query(`UPDATE ${table} SET gl_journal_entry_id = NULL WHERE company_id = ANY($1)`, [companies]);
  }
  await cleanupPr3(pool, companies, [owner]);
});

const company = async () => {
  const c = await noteCompany(pool, [[owner, 'owner']], companies);
  await enableFxDocuments(pool, c);
  return c;
};
const off = (c: string) => pool.query('UPDATE companies SET fx_documents_enabled = false WHERE id = $1', [c]);

/** A balanced DRAFT journal of R1 150 in `c` with the given source. */
async function draftJournal(c: string, source: string): Promise<string> {
  const { rows: [je] } = await pool.query(
    `INSERT INTO gl_journal_entries(company_id, entry_date, description, source, status, created_by)
     VALUES($1, DATE '2026-09-01', 'fx round 3', $2, 'draft', $3) RETURNING id`, [c, source, owner]);
  await pool.query(
    `INSERT INTO gl_journal_lines(journal_entry_id, company_id, gl_account_id, debit, credit)
     SELECT $1, $2, id, CASE WHEN account_subtype = 'receivable' THEN 1150 ELSE 0 END,
            CASE WHEN account_subtype = 'receivable' THEN 0 ELSE 1150 END
     FROM gl_accounts WHERE company_id = $2 AND account_subtype IN ('receivable', 'default_revenue')`, [je.id, c]);
  return je.id as string;
}
const link = (table: string, id: string, je: string) =>
  pool.query(`UPDATE ${table} SET gl_journal_entry_id = $2 WHERE id = $1`, [id, je]);
async function post(c: string, je: string) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await als.run({ client, userId: owner, companyId: c, claims: {} } as never, () => postJournalEntry(c, je, owner));
    await client.query('COMMIT');
    return out;
  } catch (err) { await client.query('ROLLBACK'); throw err; } finally { client.release(); }
}
const statusOf = async (je: string) => (await pool.query('SELECT status FROM gl_journal_entries WHERE id = $1', [je])).rows[0].status;

describe('probe S: a legacy foreign draft bill that already carries a journal', () => {
  it('approve answers the worded 400 before the reuse branch, not the gate text', async () => {
    const c = await company();
    const bill = await plantBill(pool, c, owner, { currencyCode: 'USD', exchangeRate: 18.5 });
    await link('supplier_invoices', bill.id, await draftJournal(c, 'auto_supplier_invoice'));
    await off(c);
    const res = await ap.approveBill(owner, c, bill.id);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(400);
    expect(messageOf(res)).toMatch(/USD bills are not enabled for this company/);
    expect(messageOf(res)).not.toMatch(/FX_DOCUMENTS_DISABLED/);
    expect((await pool.query('SELECT status FROM supplier_invoices WHERE id = $1', [bill.id])).rows[0].status).toBe('draft');
  });
});

describe('postJournalEntry refuses a journal any foreign document links to', () => {
  it('a bill foreign only in its legacy `currency` column', async () => {
    const c = await company();
    const bill = await plantBill(pool, c, owner);
    await pool.query("UPDATE supplier_invoices SET currency = 'USD' WHERE id = $1", [bill.id]);
    const je = await draftJournal(c, 'auto_supplier_invoice');
    await link('supplier_invoices', bill.id, je);
    await off(c);
    await expect(post(c, je)).rejects.toThrow(/USD bills are not enabled/);
    expect(await statusOf(je)).toBe('draft');
  });

  it('a USD credit note', async () => {
    const c = await company();
    const note = await plantNote(pool, c, owner, 'customer');
    await pool.query("UPDATE credit_notes SET currency = 'USD' WHERE id = $1", [note.id]);
    const je = await draftJournal(c, 'auto_credit_note');
    await link('credit_notes', note.id, je);
    await off(c);
    await expect(post(c, je)).rejects.toThrow(/USD credit notes are not enabled/);
    expect(await statusOf(je)).toBe('draft');
  });

  it('probe B3: a MANUAL-source journal linked to a USD invoice', async () => {
    const c = await company();
    const invoice = await plantInvoice(pool, c, owner, { currencyCode: 'USD', exchangeRate: 18.5, status: 'approved' });
    const je = await draftJournal(c, 'manual');
    await link('customer_invoices', invoice.id, je);
    await off(c);
    await expect(post(c, je)).rejects.toThrow(/USD invoices are not enabled/);
    expect(await statusOf(je)).toBe('draft');
  });

  it("only the posting company's documents count: another company's USD invoice naming this journal does not block it", async () => {
    const a = await company();
    const b = await company();
    const je = await draftJournal(a, 'auto_invoice');
    const foreign = await plantInvoice(pool, b, owner, { currencyCode: 'USD', exchangeRate: 18.5, status: 'approved' });
    await link('customer_invoices', foreign.id, je);
    await off(a);
    await off(b);
    await post(a, je);
    expect(await statusOf(je)).toBe('posted');
  });

  it('a bill foreign ONLY in currency_code (legacy `currency` still ZAR)', async () => {
    const c = await company();
    const bill = await plantBill(pool, c, owner, { currencyCode: 'USD', exchangeRate: 18.5 });
    const je = await draftJournal(c, 'auto_supplier_invoice');
    await link('supplier_invoices', bill.id, je);
    await off(c);
    await expect(post(c, je)).rejects.toThrow(/USD bills are not enabled/);
    expect(await statusOf(je)).toBe('draft');
  });

  it("company scope holds on the bill and credit-note legs too", async () => {
    const a = await company();
    const b = await company();
    const je = await draftJournal(a, 'manual');
    const bill = await plantBill(pool, b, owner, { currencyCode: 'USD', exchangeRate: 18.5 });
    const note = await plantNote(pool, b, owner, 'customer');
    await pool.query("UPDATE credit_notes SET currency = 'USD' WHERE id = $1", [note.id]);
    await link('supplier_invoices', bill.id, je);
    await link('credit_notes', note.id, je);
    await off(a);
    await off(b);
    await post(a, je);
    expect(await statusOf(je)).toBe('posted');
  });

  it('every linked document is checked, not only the first: a ZAR invoice and a USD bill on one journal', async () => {
    const c = await company();
    const zar = await plantInvoice(pool, c, owner, { status: 'approved' });
    const usd = await plantBill(pool, c, owner, { currencyCode: 'USD', exchangeRate: 18.5 });
    const je = await draftJournal(c, 'manual');
    await link('customer_invoices', zar.id, je);
    await link('supplier_invoices', usd.id, je);
    await off(c);
    await expect(post(c, je)).rejects.toThrow(/USD bills are not enabled/);
    expect(await statusOf(je)).toBe('draft');
  });

  it('a ZAR document linked to the journal posts as before', async () => {
    const c = await company();
    const invoice = await plantInvoice(pool, c, owner, { status: 'approved' });
    const je = await draftJournal(c, 'manual');
    await link('customer_invoices', invoice.id, je);
    await off(c);
    await post(c, je);
    expect(await statusOf(je)).toBe('posted');
  });
});

describe('invoicesPayable', () => {
  it('throws a ReceiptRefusal (the class the routes answer 400) naming the invoice and the currency', async () => {
    const c = await company();
    await off(c);
    const attempt = invoicesPayable(c, [{ invoice_number: 'INV-FX3', currency_code: 'USD' }]);
    await expect(attempt).rejects.toBeInstanceOf(ReceiptRefusal);
    await expect(invoicesPayable(c, [{ invoice_number: 'INV-FX3', currency_code: 'USD' }]))
      .rejects.toThrow(/Invoice INV-FX3 cannot take this receipt: USD invoices are not enabled/);
    await expect(invoicesPayable(c, [{ invoice_number: 'INV-ZAR', currency_code: ' ' }])).resolves.toHaveLength(1);
  });
});
