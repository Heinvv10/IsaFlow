/**
 * R-059 rounds 8-9 — statement-line match candidates are the AGEING's
 * population: a NULL-status bill matches its line, a draft does not.
 *
 * The page gates "Mark reconciled" on three figures from the header
 * (`pages/accounting/ap/supplier-statements/[id].tsx`, `canReconcile`):
 * |variance| <= 0.01, missingInIsaflowCount 0 and amountDiffCount 0. The
 * variance comes from the AP ageing. The line matching comes from
 * `loadSupplierInvoices`, which now uses the same shared/documentPopulation.
 *
 * Round 8 kept DRAFTS matchable and claimed the variance would still refuse a
 * draft, because a draft is not owed. That was wrong. The variance refuses a
 * draft only when nothing offsets it (the round-8 review's probe, case P here).
 * Cases:
 *   N  a NULL-status bill of 1000, its line, closing 1000: matched, variance 0,
 *      reconcilable, and markReconciled lands.
 *   D  a DRAFT bill of 300 and its line, closing 300: NOT matched — its line is
 *      missing from IsaFlow — and the page refuses.
 *   P  the offsetting case. An owed, approved bill A of 300 dated before the
 *      statement period (so no line claims it), plus a DRAFT B of 300 matching
 *      the statement's single line, closing 300. Balances tie (variance 0). Under
 *      round 8's rule B silenced the line and the statement reconciled against a
 *      bill nobody owes. Now B's line is missing from IsaFlow and it is refused.
 *   X  a CANCELLED bill of 300 and its line: not matched either (round 10 —
 *      the cancelled half of the rule was unpinned).
 *
 * ROUND 10 — Rematch re-measures the variance. rematchLines re-read the bills
 * but kept the variance struck at creation, so after a draft was approved and
 * the lines re-matched, the counts and the variance described different sets of
 * bills. Both directions are pinned, continuing D and P:
 *   P' approve B, Rematch: B now matches, we owe A + B = 600 against the
 *      supplier's 300, variance −300 — refused. The stale variance was 0, and
 *      the page allowed it.
 *   D' approve the draft, Rematch: it matches and is owed, variance 0 —
 *      reconcilable. The stale variance was a phantom 300.
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
let nextExtraction: {
  closingBalance: number; periodStart?: string; periodEnd?: string;
  lines: { date: string; reference: string; debit: number }[];
} = { closingBalance: 0, lines: [] };

vi.mock('@/lib/documentStorage', () => ({
  fetchRawBytes: vi.fn(async () => ({ buffer: Buffer.from('%PDF-1.4 r059'), fileType: 'pdf' })),
}));
vi.mock('@/modules/accounting/services/bank/vlmSupplierStatementService', () => ({
  extractSupplierStatementWithVlm: vi.fn(async () => ({
    statementDate: STMT, periodStart: nextExtraction.periodStart ?? null, periodEnd: nextExtraction.periodEnd ?? null,
    closingBalance: nextExtraction.closingBalance, lines: nextExtraction.lines, warnings: [],
  })),
}));

const { createReconciliation, markReconciled, getReconciliation, rematchLines } =
  await import('@/modules/accounting/services/capture/supplierStatementReconService');

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

const COMPANY = randomUUID();
const USER = randomUUID();
const TAG = `R59C${Math.floor(Math.random() * 1e8)}`;
const docs = { N: randomUUID(), D: randomUUID(), P: randomUUID(), X: randomUUID() };
const suppliers = { N: '', D: '', P: '', X: '' };
/** Reconciliation ids from the creation tests, re-matched in round 10's. */
const recons = { D: '', P: '' };

/** "Approve" a bill the way the ageing reads it: its status. */
async function approve(invoiceNumber: string): Promise<void> {
  await sql`UPDATE supplier_invoices SET status = 'approved'
            WHERE company_id = ${COMPANY}::UUID AND invoice_number = ${invoiceNumber}`;
}

/** The page's own gate, verbatim in meaning. */
function canReconcile(r: { variance: number; missingInIsaflowCount: number; amountDiffCount: number }): boolean {
  return Math.abs(r.variance) <= 0.01 && r.missingInIsaflowCount === 0 && r.amountDiffCount === 0;
}

describeIfDb('R-059 statement lines match the ageing\'s population: NULL in, drafts out', () => {
  beforeAll(async () => {
    assertDisposable();
    await sql`INSERT INTO companies (id, name, registration_number) VALUES (${COMPANY}::UUID, ${'R059C ' + TAG}, ${TAG})`;
    await sql`INSERT INTO users (id, email, role, is_active) VALUES (${USER}, ${USER + '@test.local'}, 'admin', true)`;
    for (const [key, status, gross] of [['N', null, 1000], ['D', 'draft', 300], ['X', 'cancelled', 300]] as const) {
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

    // P: an owed bill A outside the statement period, and a draft B the line names.
    suppliers.P = ((await sql`
      INSERT INTO suppliers (company_id, name) VALUES (${COMPANY}::UUID, ${'P ' + TAG}) RETURNING id
    `) as { id: string }[])[0]!.id;
    for (const [n, status, raised] of [['-PA', 'approved', shift(-60)], ['-PB', 'draft', shift(-20)]] as const) {
      await sql`
        INSERT INTO supplier_invoices (company_id, supplier_id, invoice_number, invoice_date, due_date,
          status, subtotal, tax_amount, total_amount, amount_paid, created_by)
        VALUES (${COMPANY}::UUID, ${suppliers.P}::UUID, ${TAG + n}, ${raised}::date,
          ${raised}::date, ${status}, 300, 0, 300, 0, ${USER}::UUID)`;
    }
    await sql`INSERT INTO captured_documents (id, company_id, file_name, file_type, document_type, uploaded_by)
              VALUES (${docs.P}::UUID, ${COMPANY}::UUID, ${TAG + 'P.pdf'}, 'pdf', 'supplier_statement', ${USER}::UUID)`;
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

  it('D: a DRAFT bill is not a match candidate — its line is missing from IsaFlow', async () => {
    nextExtraction = { closingBalance: 300, lines: [{ date: shift(-50), reference: TAG + '-D', debit: 300 }] };
    const recon = await createReconciliation(COMPANY, suppliers.D, docs.D, USER);
    recons.D = recon.id;
    expect({
      missing: recon.missingInIsaflowCount, matched: recon.lines.map(l => l.matchedInvoiceNumber),
      isaflow: recon.isaflowBalance, variance: recon.variance,
    }).toEqual({ missing: 1, matched: [null], isaflow: 0, variance: 300 });
    expect(canReconcile(recon)).toBe(false);
  });

  it('P: an owed bill offsetting a draft cannot reconcile the statement against the draft', async () => {
    // Round 8's rule: B matched the line (missing 0) and A made the balances
    // tie (variance 0), so canReconcile was TRUE and markReconciled landed on a
    // statement whose only invoice we have never approved.
    nextExtraction = {
      closingBalance: 300, periodStart: shift(-30), periodEnd: STMT,
      lines: [{ date: shift(-20), reference: TAG + '-PB', debit: 300 }],
    };
    const recon = await createReconciliation(COMPANY, suppliers.P, docs.P, USER);
    recons.P = recon.id;
    expect({
      isaflow: recon.isaflowBalance, variance: recon.variance,
      missing: recon.missingInIsaflowCount, matched: recon.lines.map(l => l.matchedInvoiceNumber),
    }).toEqual({ isaflow: 300, variance: 0, missing: 1, matched: [null] });
    expect(canReconcile(recon)).toBe(false);
  });

  it('X: a CANCELLED bill is not a match candidate', async () => {
    nextExtraction = { closingBalance: 300, lines: [{ date: shift(-50), reference: TAG + '-X', debit: 300 }] };
    const recon = await createReconciliation(COMPANY, suppliers.X, docs.X, USER);
    expect({ missing: recon.missingInIsaflowCount, matched: recon.lines.map(l => l.matchedInvoiceNumber) })
      .toEqual({ missing: 1, matched: [null] });
    expect(canReconcile(recon)).toBe(false);
  });

  it("P': approve the draft and Rematch — we now owe 600 against 300, and it is refused", async () => {
    await approve(TAG + '-PB');
    const recon = await rematchLines(COMPANY, recons.P);
    expect({
      isaflow: recon.isaflowBalance, variance: recon.variance,
      missing: recon.missingInIsaflowCount, matched: recon.lines.map(l => l.matchedInvoiceNumber),
    }).toEqual({ isaflow: 600, variance: -300, missing: 0, matched: [TAG + '-PB'] });
    expect(canReconcile(recon)).toBe(false);
  });

  it("D': approve the draft and Rematch — it matches, is owed, and the statement ties", async () => {
    await approve(TAG + '-D');
    const recon = await rematchLines(COMPANY, recons.D);
    expect({
      isaflow: recon.isaflowBalance, variance: recon.variance,
      missing: recon.missingInIsaflowCount, matched: recon.lines.map(l => l.matchedInvoiceNumber),
    }).toEqual({ isaflow: 300, variance: 0, missing: 0, matched: [TAG + '-D'] });
    expect(canReconcile(recon)).toBe(true);
  });
});
