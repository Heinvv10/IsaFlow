/**
 * R-059 round 8 (MEDIUM-1) — a supplier statement line matches its bill when
 * the bill's status is NULL, so a statement that ties can be marked reconciled.
 *
 * The page gates "Mark reconciled" on three figures from the header
 * (`pages/accounting/ap/supplier-statements/[id].tsx`, `canReconcile`):
 * |variance| <= 0.01, missingInIsaflowCount 0 and amountDiffCount 0. The
 * variance comes from the AP ageing, which counts a NULL-status bill (round 4).
 * The line matching came from `loadSupplierInvoices`, whose bare NOT IN was
 * NULL for that bill, so the bill's line read "missing in IsaFlow" and the
 * page refused a statement that tied to the cent.
 *
 * Match candidates keep DRAFTS on purpose — a bill held as a draft is worth
 * matching to the supplier's line for it — so the candidate rule is
 * COALESCE(status,'') <> 'cancelled', NOT the ageing's documentPopulation.
 * Both halves of that decision are pinned:
 *   N  a NULL-status bill of 1000, its line, closing 1000: matched, variance 0,
 *      reconcilable, and markReconciled lands.
 *   D  a DRAFT bill of 300, its line, closing 300: MATCHED (so drafts are
 *      candidates), but the variance is 300 because a draft is not owed — the
 *      ageing still stops it being reconciled.
 * Only the VLM extraction and the stored PDF bytes are mocked.
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
const STMT = shift(-10);

/** What the mocked VLM returns for the next createReconciliation call. */
let nextExtraction: { closingBalance: number; lines: { date: string; reference: string; debit: number }[] } =
  { closingBalance: 0, lines: [] };

vi.mock('@/lib/documentStorage', () => ({
  fetchRawBytes: vi.fn(async () => ({ buffer: Buffer.from('%PDF-1.4 r059'), fileType: 'pdf' })),
}));
vi.mock('@/modules/accounting/services/bank/vlmSupplierStatementService', () => ({
  extractSupplierStatementWithVlm: vi.fn(async () => ({
    statementDate: STMT, periodStart: null, periodEnd: null,
    closingBalance: nextExtraction.closingBalance, lines: nextExtraction.lines, warnings: [],
  })),
}));

const { createReconciliation, markReconciled, getReconciliation } =
  await import('@/modules/accounting/services/capture/supplierStatementReconService');

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

const COMPANY = randomUUID();
const USER = randomUUID();
const TAG = `R59C${Math.floor(Math.random() * 1e8)}`;
const docs = { N: randomUUID(), D: randomUUID() };
const suppliers = { N: '', D: '' };

/** The page's own gate, verbatim in meaning. */
function canReconcile(r: { variance: number; missingInIsaflowCount: number; amountDiffCount: number }): boolean {
  return Math.abs(r.variance) <= 0.01 && r.missingInIsaflowCount === 0 && r.amountDiffCount === 0;
}

describeIfDb('R-059 statement lines match NULL-status and draft bills', () => {
  beforeAll(async () => {
    assertDisposable();
    await sql`INSERT INTO companies (id, name, registration_number) VALUES (${COMPANY}::UUID, ${'R059C ' + TAG}, ${TAG})`;
    await sql`INSERT INTO users (id, email, role, is_active) VALUES (${USER}, ${USER + '@test.local'}, 'admin', true)`;
    for (const [key, status, gross] of [['N', null, 1000], ['D', 'draft', 300]] as const) {
      suppliers[key] = ((await sql`
        INSERT INTO suppliers (company_id, name) VALUES (${COMPANY}::UUID, ${key + ' ' + TAG}) RETURNING id
      `) as { id: string }[])[0]!.id;
      await sql`
        INSERT INTO supplier_invoices (company_id, supplier_id, invoice_number, invoice_date, due_date,
          status, subtotal, tax_amount, total_amount, amount_paid, created_by)
        VALUES (${COMPANY}::UUID, ${suppliers[key]}::UUID, ${TAG + '-' + key}, ${shift(-50)}::date,
          ${shift(-20)}::date, ${status}, ${gross}, 0, ${gross}, 0, ${USER}::UUID)`;
      await sql`INSERT INTO captured_documents (id, company_id, file_name, file_type, document_type, uploaded_by)
                VALUES (${docs[key]}::UUID, ${COMPANY}::UUID, ${TAG + key + '.pdf'}, 'pdf', 'supplier_statement', ${USER}::UUID)`;
    }
  }, 120000);

  afterAll(async () => {
    await sql`DELETE FROM supplier_statement_lines WHERE reconciliation_id IN
                (SELECT id FROM supplier_statement_reconciliations WHERE company_id = ${COMPANY}::UUID)`;
    await sql`DELETE FROM supplier_statement_reconciliations WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM captured_documents WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM supplier_invoices WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM suppliers WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM companies WHERE id = ${COMPANY}::UUID`;
    await sql`DELETE FROM users WHERE id = ${USER}`;
  }, 120000);

  it('N: a NULL-status bill matches its line, the statement ties, and it can be marked reconciled', async () => {
    nextExtraction = { closingBalance: 1000, lines: [{ date: shift(-50), reference: TAG + '-N', debit: 1000 }] };
    const recon = await createReconciliation(COMPANY, suppliers.N, docs.N, USER);
    expect({
      variance: recon.variance, missing: recon.missingInIsaflowCount, amountDiff: recon.amountDiffCount,
      matched: recon.lines.map(l => l.matchedInvoiceNumber),
    }).toEqual({ variance: 0, missing: 0, amountDiff: 0, matched: [TAG + '-N'] });
    expect(canReconcile(recon)).toBe(true);

    await markReconciled(COMPANY, recon.id, USER);
    expect((await getReconciliation(COMPANY, recon.id))!.status).toBe('reconciled');
  });

  it('D: a DRAFT bill is still a match candidate, and the ageing still refuses it', async () => {
    nextExtraction = { closingBalance: 300, lines: [{ date: shift(-50), reference: TAG + '-D', debit: 300 }] };
    const recon = await createReconciliation(COMPANY, suppliers.D, docs.D, USER);
    // Matched — drafts are deliberately candidates — but the draft is not
    // owed, so the ageing reads 0 and the 300 is a variance.
    expect({
      missing: recon.missingInIsaflowCount, matched: recon.lines.map(l => l.matchedInvoiceNumber),
      isaflow: recon.isaflowBalance, variance: recon.variance,
    }).toEqual({ missing: 0, matched: [TAG + '-D'], isaflow: 0, variance: 300 });
    expect(canReconcile(recon)).toBe(false);
  });
});
