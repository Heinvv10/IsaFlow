/**
 * R-059 round 2 (LOW-6) — the supplier statement reconciliation measures our
 * side at the STATEMENT DATE.
 *
 * `createReconciliation` compared the supplier's closing balance, struck at the
 * statement date, with today's si.balance over every non-paid, non-cancelled
 * bill — drafts included. A payment made after the statement date read as a
 * variance, and so did a bill raised after it. Our side is now the AP ageing
 * for this supplier as at the statement date.
 *
 * Statement dated STMT with a closing balance of 1000:
 *   A 1000 raised STMT−40, paid in full STMT+30 — status 'paid' today; owed at STMT
 *   B  500 raised STMT+40                      — after the statement
 *   C  300 draft raised STMT−30                — never owed
 * Ours at STMT: 1000, variance 0. Before the fix: B + C = 800, variance 200.
 *
 * The VLM extraction and the stored PDF bytes are the only boundaries mocked.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { sql } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

function shift(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return fmtDate(d);
}
const STMT = shift(-60);
const CLOSING = 1000;

vi.mock('@/lib/documentStorage', () => ({
  fetchRawBytes: vi.fn(async () => ({ buffer: Buffer.from('%PDF-1.4 r059'), fileType: 'pdf' })),
}));
vi.mock('@/modules/accounting/services/bank/vlmSupplierStatementService', () => ({
  extractSupplierStatementWithVlm: vi.fn(async () => ({
    statementDate: STMT, periodStart: null, periodEnd: null,
    closingBalance: CLOSING, lines: [], warnings: [],
  })),
}));

const { createReconciliation } = await import('@/modules/accounting/services/capture/supplierStatementReconService');

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

const COMPANY = randomUUID();
const USER = randomUUID();
const DOCUMENT = randomUUID();
const TAG = `R059REC-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const PAYTAG = `R59R-${Math.floor(Math.random() * 1e9)}`;

let supplier = '';

async function bill(n: string, gross: number, raised: string, status: string, paid: number): Promise<string> {
  return ((await sql`
    INSERT INTO supplier_invoices (company_id, supplier_id, invoice_number, invoice_date, due_date,
      status, subtotal, tax_amount, total_amount, amount_paid, created_by)
    VALUES (${COMPANY}::UUID, ${supplier}::UUID, ${TAG + n}, ${raised}::date, ${raised}::date,
      ${status}, ${gross}, 0, ${gross}, ${paid}, ${USER}::UUID)
    RETURNING id`) as { id: string }[])[0]!.id;
}

describeIfDb('R-059 the supplier statement variance is measured at the statement date', () => {
  beforeAll(async () => {
    assertDisposable();
    await sql`INSERT INTO companies (id, name, registration_number) VALUES (${COMPANY}::UUID, ${'R059REC ' + TAG}, ${TAG})`;
    await sql`INSERT INTO users (id, email, role, is_active) VALUES (${USER}, ${USER + '@test.local'}, 'admin', true)`;
    await sql`INSERT INTO company_users (company_id, user_id, role) VALUES (${COMPANY}::UUID, ${USER}, 'admin')`;
    supplier = ((await sql`INSERT INTO suppliers (company_id, name) VALUES (${COMPANY}::UUID, ${'supp ' + TAG}) RETURNING id`) as { id: string }[])[0]!.id;
    await sql`INSERT INTO captured_documents (id, company_id, file_name, file_type, document_type, uploaded_by)
              VALUES (${DOCUMENT}::UUID, ${COMPANY}::UUID, ${TAG + '.pdf'}, 'pdf', 'supplier_statement', ${USER}::UUID)`;

    const a = await bill('-A', 1000, shift(-100), 'paid', 1000);
    await bill('-B', 500, shift(-20), 'approved', 0);
    await bill('-C', 300, shift(-90), 'draft', 0);
    const [sp] = (await sql`
      INSERT INTO supplier_payments (company_id, payment_number, supplier_id, payment_date, total_amount, status, created_by)
      VALUES (${COMPANY}::UUID, ${PAYTAG}, ${supplier}::UUID, ${shift(-30)}::date, 1000, 'processed', ${USER}::UUID)
      RETURNING id`) as { id: string }[];
    await sql`INSERT INTO payment_allocations (payment_id, invoice_id, amount_allocated)
              VALUES (${sp!.id}::UUID, ${a}::UUID, 1000)`;
  }, 120000);

  afterAll(async () => {
    await sql`DELETE FROM supplier_statement_lines WHERE reconciliation_id IN
                (SELECT id FROM supplier_statement_reconciliations WHERE company_id = ${COMPANY}::UUID)`;
    await sql`DELETE FROM supplier_statement_reconciliations WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM captured_documents WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM payment_allocations WHERE payment_id IN (SELECT id FROM supplier_payments WHERE company_id = ${COMPANY}::UUID)`;
    await sql`DELETE FROM supplier_payments WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM supplier_invoices WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM suppliers WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM company_users WHERE user_id = ${USER}`;
    await sql`DELETE FROM companies WHERE id = ${COMPANY}::UUID`;
    await sql`DELETE FROM users WHERE id = ${USER}`;
  }, 120000);

  it('our side is what we owed the supplier on the statement date', async () => {
    const recon = await createReconciliation(COMPANY, supplier, DOCUMENT, USER);
    expect(recon.statementDate).toBe(STMT);
    expect(recon.isaflowBalance).toBeCloseTo(1000, 2);
    expect(recon.variance).toBeCloseTo(0, 2);
  });
});
