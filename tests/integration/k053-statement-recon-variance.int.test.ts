/**
 * K-053 round 8 (M-2) — the supplier statement reconciliation's OWN side of
 * the variance reads the same dated question as the control account.
 *
 * `createReconciliation` compares the supplier's statement balance against
 * "what our ledger carries", and that second figure is what round 7 dated.
 * Nothing reconciled it: reverting the predicate left the whole K-053 suite
 * green. It needs a fixture of its own because the entry point runs a VLM
 * extraction over stored PDF bytes before it ever reaches the balance query —
 * the two boundaries mocked below, and nothing else. The balance query, the
 * variance arithmetic and the persisted header are the real ones.
 *
 * Three supplier invoices carry the three populations: one live, one deleted
 * through the real service (its GL reversal dated TODAY, so the ledger no
 * longer carries it), and one in the pre-branch shape (`deleted_at` set, the
 * approval journal never reversed, so the ledger still does). Only the exact
 * sum of the first and third is right: including the reversed delete or
 * dropping the legacy one both miss it.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import { als } from '@/lib/als';
import { sql, getPoolForTests } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

const STATEMENT_BALANCE = 9999;

vi.mock('@/lib/documentStorage', () => ({
  fetchRawBytes: vi.fn(async () => ({ buffer: Buffer.from('%PDF-1.4 k053'), fileType: 'pdf' })),
}));
vi.mock('@/modules/accounting/services/bank/vlmSupplierStatementService', () => ({
  extractSupplierStatementWithVlm: vi.fn(async () => ({
    statementDate: null, periodStart: null, periodEnd: null,
    closingBalance: STATEMENT_BALANCE, lines: [], warnings: [],
  })),
}));

const { createReconciliation } = await import('@/modules/accounting/services/capture/supplierStatementReconService');
const { postSupplierInvoiceToGL } = await import('@/modules/accounting/services/ap/supplierInvoiceWorkflowService');
const { softDelete } = await import('@/modules/accounting/services/core/softDeleteService');

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const COMPANY = randomUUID();
const USER = randomUUID();
const DOCUMENT = randomUUID();
const TAG = `K053REC-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

function shift(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return fmtDate(d);
}
const TODAY = fmtDate(new Date());
const CLOSED_END = shift(-60);
const OPEN_START = shift(-59);
const OPEN_END = shift(400);
const DOC_DATE = shift(-120);
const DUE_DATE = shift(-100);

const LIVE = 1150;
const DELETED = 2300;
const LEGACY = 4600;

const payable = randomUUID();
const expense = randomUUID();
const vatInput = randomUUID();

let supplier: string;

async function inTx<T>(fn: () => Promise<T>): Promise<T> {
  const client: PoolClient = await getPoolForTests().connect();
  try {
    await client.query('BEGIN');
    const result = await als.run({ client, userId: USER, companyId: COMPANY, claims: {} }, fn);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

async function account(id: string, code: string, name: string, type: string, normal: string, subtype: string) {
  await sql`
    INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type,
      normal_balance, level, is_active, is_system_account, account_subtype)
    VALUES (${id}::UUID, ${COMPANY}::UUID, ${code}, ${name}, ${type}, ${normal}, 3, true, true, ${subtype})`;
}

/**
 * A supplier invoice. `supplier_invoices.balance` — the column the variance
 * sums — is GENERATED as `total_amount - amount_paid`, so it follows from the
 * amounts and cannot be written.
 */
async function supplierInvoice(number: string, gross: number): Promise<string> {
  const sub = Math.round((gross / 1.15) * 100) / 100;
  const rows = (await sql`
    INSERT INTO supplier_invoices (company_id, supplier_id, invoice_number, invoice_date, due_date,
      status, subtotal, tax_amount, total_amount, amount_paid, created_by)
    VALUES (${COMPANY}::UUID, ${supplier}::UUID, ${number}, ${DOC_DATE}::date, ${DUE_DATE}::date,
      'approved', ${sub}, ${gross - sub}, ${gross}, 0, ${USER}::UUID)
    RETURNING id`) as { id: string }[];
  const id = rows[0]!.id;
  await sql`
    INSERT INTO supplier_invoice_items (supplier_invoice_id, description, quantity, unit_price, tax_rate, tax_amount, line_total, gl_account_id)
    VALUES (${id}::UUID, ${'K053 line ' + number}, 1, ${sub}, 15, ${gross - sub}, ${sub}, ${expense}::UUID)`;
  return id;
}

describeIfDb('K-053 the supplier statement variance measures our ledger as it stands today', () => {
  beforeAll(async () => {
    assertDisposable();
    await sql`INSERT INTO companies (id, name, registration_number)
              VALUES (${COMPANY}::UUID, ${'K053REC ' + TAG}, ${TAG})`;
    await sql`INSERT INTO users (id, email, role, is_active)
              VALUES (${USER}, ${USER + '@test.local'}, 'admin', true)`;
    await sql`INSERT INTO company_users (company_id, user_id, role)
              VALUES (${COMPANY}::UUID, ${USER}, 'admin')`;
    await sql`INSERT INTO fiscal_periods (company_id, period_name, period_number, fiscal_year, start_date, end_date, status)
              VALUES (${COMPANY}::UUID, ${'K053REC prior ' + TAG}, 1, 2026, '2020-01-01', ${CLOSED_END}::date, 'open'),
                     (${COMPANY}::UUID, ${'K053REC current ' + TAG}, 2, 2026, ${OPEN_START}::date, ${OPEN_END}::date, 'open')`;
    await account(payable, '2100', 'Trade Creditors', 'liability', 'credit', 'payable');
    await account(expense, '5000', 'Materials', 'expense', 'debit', 'default_expense');
    await account(vatInput, '1300', 'VAT Input', 'asset', 'debit', 'vat_input');

    supplier = ((await sql`INSERT INTO suppliers (company_id, name)
                           VALUES (${COMPANY}::UUID, ${'supp ' + TAG}) RETURNING id`) as { id: string }[])[0]!.id;
    await sql`INSERT INTO captured_documents (id, company_id, file_name, file_type, document_type, uploaded_by)
              VALUES (${DOCUMENT}::UUID, ${COMPANY}::UUID, ${TAG + '.pdf'}, 'pdf', 'supplier_statement', ${USER}::UUID)`;

    const live = await supplierInvoice(TAG + '-LIVE', LIVE);
    const deleted = await supplierInvoice(TAG + '-DELETED', DELETED);
    const legacy = await supplierInvoice(TAG + '-LEGACY', LEGACY);
    for (const id of [live, deleted, legacy]) {
      await inTx(() => postSupplierInvoiceToGL(COMPANY, id, USER));
    }
    await sql`UPDATE fiscal_periods SET status = 'closed'
              WHERE company_id = ${COMPANY}::UUID AND end_date = ${CLOSED_END}::date`;

    await inTx(() => softDelete(COMPANY, 'supplier_invoice', deleted, USER));
    await sql`UPDATE supplier_invoices SET deleted_at = NOW()
              WHERE id = ${legacy}::UUID AND company_id = ${COMPANY}::UUID`;
  }, 180000);

  afterAll(async () => {
    await sql`DELETE FROM supplier_statement_lines WHERE reconciliation_id IN
                (SELECT id FROM supplier_statement_reconciliations WHERE company_id = ${COMPANY}::UUID)`;
    await sql`DELETE FROM supplier_statement_reconciliations WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM captured_documents WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM soft_delete_journal_reversals WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM supplier_invoice_items WHERE supplier_invoice_id IN
                (SELECT id FROM supplier_invoices WHERE company_id = ${COMPANY}::UUID)`;
    await sql`DELETE FROM supplier_invoices WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM gl_journal_lines WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM gl_journal_entries WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM gl_account_balances WHERE gl_account_id IN
                (${payable}::UUID, ${expense}::UUID, ${vatInput}::UUID)`;
    await sql`DELETE FROM gl_accounts WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM fiscal_periods WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM suppliers WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM company_users WHERE user_id = ${USER}`;
    await sql`DELETE FROM companies WHERE id = ${COMPANY}::UUID`;
    await sql`DELETE FROM users WHERE id = ${USER}`;
  }, 120000);

  it('the premise: the delete reversed the approval journal, dated today', async () => {
    const rows = (await sql`
      SELECT e.entry_date
      FROM soft_delete_journal_reversals r
      JOIN gl_journal_entries e ON e.id = r.reversal_journal_entry_id
      WHERE r.company_id = ${COMPANY}::UUID
    `) as { entry_date: unknown }[];
    expect(rows).toHaveLength(1);
    expect(fmtDate(new Date(String(rows[0]!.entry_date)))).toBe(TODAY);
  });

  it('our side of the variance is the balance the creditors control still carries', async () => {
    const recon = await createReconciliation(COMPANY, supplier, DOCUMENT, USER);

    const control = (await sql`
      SELECT COALESCE(SUM(l.credit - l.debit), 0) AS net
      FROM gl_journal_lines l
      JOIN gl_journal_entries e ON e.id = l.journal_entry_id
      WHERE l.company_id = ${COMPANY}::UUID AND l.gl_account_id = ${payable}::UUID
        AND e.status = 'posted' AND e.entry_date <= ${TODAY}::date
    `) as { net: string | number }[];

    expect(recon.isaflowBalance).toBeCloseTo(LIVE + LEGACY, 2);
    expect(recon.isaflowBalance).toBeCloseTo(Number(control[0]!.net), 2);
    expect(recon.variance).toBeCloseTo(STATEMENT_BALANCE - (LIVE + LEGACY), 2);
  });
});
