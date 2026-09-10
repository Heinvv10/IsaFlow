/**
 * R-059 round 11 — Rematch re-measures AT THE STATEMENT DATE, and is refused
 * once the statement is reconciled.
 *
 * Round 10 made Rematch re-measure the variance from the AP ageing. Two gaps:
 *
 *   PAY  nothing pinned the DATE it measures at. A payment dated after the
 *        statement date settles the bill today, but on the statement date the
 *        bill was owed, so the supplier's closing balance still ties. Replacing
 *        the statement date with today left every statement test green.
 *        Here: bill 500 raised before the statement, statement closing 500 with
 *        its line, then a payment of 500 dated TODAY, then Rematch — variance
 *        stays 0 and isaflow stays 500.
 *
 *   CLOSED  Rematch rewrote the variance of a statement already marked
 *        reconciled, and the row stayed 'reconciled': the variance it was
 *        reconciled at was lost (markReconciled stores none). Here: statement
 *        ties at 300 and is marked reconciled; a backdated bill of 200 is then
 *        captured; Rematch is refused — ReconciliationClosedError from the
 *        service, 409 from the route — and the variance, the balance, the lines
 *        and the status are all exactly as they were reconciled.
 *
 * Only the VLM extraction and the stored PDF bytes are mocked.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { SignJWT } from 'jose';
import { sql } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';

function shift(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return fmtDate(d);
}
const STMT = shift(-10);

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

const { createReconciliation, markReconciled, getReconciliation, rematchLines, ReconciliationClosedError } =
  await import('@/modules/accounting/services/capture/supplierStatementReconService');
const rematchRoute = (await import('../../pages/api/accounting/supplier-statements/[id]/rematch')).default;

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

const COMPANY = randomUUID();
const USER = randomUUID();
const TAG = `R59M${Math.floor(Math.random() * 1e8)}`;
const docs = { PAY: randomUUID(), CLOSED: randomUUID() };
const suppliers = { PAY: '', CLOSED: '' };
let token = '';

async function bill(supplier: string, n: string, gross: number, raised: string, status: string, paid = 0): Promise<string> {
  return ((await sql`
    INSERT INTO supplier_invoices (company_id, supplier_id, invoice_number, invoice_date, due_date,
      status, subtotal, tax_amount, total_amount, amount_paid, created_by)
    VALUES (${COMPANY}::UUID, ${supplier}::UUID, ${TAG + n}, ${raised}::date, ${raised}::date,
      ${status}, ${gross}, 0, ${gross}, ${paid}, ${USER}::UUID)
    RETURNING id`) as { id: string }[])[0]!.id;
}

async function callRematch(id: string): Promise<{ status: number; body: unknown }> {
  const req = request({ 'sb-access-token': token, active_company_id: COMPANY }, 'POST');
  (req as unknown as { query: unknown }).query = { id };
  const result = response();
  await (rematchRoute as unknown as (a: unknown, b: unknown) => Promise<void>)(req, result.res);
  return { status: result.state.statusCode as number, body: result.state.body };
}

describeIfDb('R-059 Rematch measures at the statement date, and a reconciled statement is closed', () => {
  beforeAll(async () => {
    assertDisposable();
    await sql`INSERT INTO companies (id, name, registration_number) VALUES (${COMPANY}::UUID, ${'R059M ' + TAG}, ${TAG})`;
    await sql`INSERT INTO users (id, email, role, is_active) VALUES (${USER}, ${USER + '@test.local'}, 'admin', true)`;
    await sql`INSERT INTO company_users (company_id, user_id, role) VALUES (${COMPANY}::UUID, ${USER}, 'admin')`;
    for (const key of ['PAY', 'CLOSED'] as const) {
      suppliers[key] = ((await sql`
        INSERT INTO suppliers (company_id, name) VALUES (${COMPANY}::UUID, ${key + ' ' + TAG}) RETURNING id
      `) as { id: string }[])[0]!.id;
      await sql`INSERT INTO captured_documents (id, company_id, file_name, file_type, document_type, uploaded_by)
                VALUES (${docs[key]}::UUID, ${COMPANY}::UUID, ${TAG + key + '.pdf'}, 'pdf', 'supplier_statement', ${USER}::UUID)`;
    }
    token = await new SignJWT({ sub: USER, aal: 'aal2' })
      .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h')
      .sign(new TextEncoder().encode(process.env.JWT_SECRET));
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

  it('PAY: a payment dated after the statement date does not move a Rematch', async () => {
    const b = await bill(suppliers.PAY, '-PAY', 500, shift(-40), 'approved');
    nextExtraction = { closingBalance: 500, lines: [{ date: shift(-40), reference: TAG + '-PAY', debit: 500 }] };
    const created = await createReconciliation(COMPANY, suppliers.PAY, docs.PAY, USER);
    expect({ isaflow: created.isaflowBalance, variance: created.variance }).toEqual({ isaflow: 500, variance: 0 });

    // Settled TODAY — after the statement date.
    const [p] = (await sql`
      INSERT INTO supplier_payments (company_id, payment_number, supplier_id, payment_date, total_amount, status, created_by)
      VALUES (${COMPANY}::UUID, ${TAG + '-P'}, ${suppliers.PAY}::UUID, ${fmtDate(new Date())}::date, 500, 'processed', ${USER}::UUID)
      RETURNING id`) as { id: string }[];
    await sql`INSERT INTO payment_allocations (payment_id, invoice_id, amount_allocated) VALUES (${p!.id}::UUID, ${b}::UUID, 500)`;
    await sql`UPDATE supplier_invoices SET amount_paid = 500, status = 'paid' WHERE id = ${b}::UUID AND company_id = ${COMPANY}::UUID`;

    const re = await rematchLines(COMPANY, created.id);
    expect({ isaflow: re.isaflowBalance, variance: re.variance, missing: re.missingInIsaflowCount })
      .toEqual({ isaflow: 500, variance: 0, missing: 0 });
  });

  it('CLOSED: once reconciled, Rematch is refused and nothing moves', async () => {
    await bill(suppliers.CLOSED, '-C1', 300, shift(-40), 'approved');
    nextExtraction = { closingBalance: 300, lines: [{ date: shift(-40), reference: TAG + '-C1', debit: 300 }] };
    const created = await createReconciliation(COMPANY, suppliers.CLOSED, docs.CLOSED, USER);
    await markReconciled(COMPANY, created.id, USER);
    const snapshot = async () => {
      const r = (await getReconciliation(COMPANY, created.id))!;
      return {
        status: r.status, isaflow: r.isaflowBalance, variance: r.variance,
        missing: r.missingInIsaflowCount, inStatement: r.missingInStatementCount,
        lines: r.lines.map(l => [l.reference, l.matchedInvoiceNumber, l.mismatchReason]),
      };
    };
    const before = await snapshot();
    expect(before).toMatchObject({ status: 'reconciled', isaflow: 300, variance: 0 });

    // A bill captured afterwards, dated before the statement.
    await bill(suppliers.CLOSED, '-C2', 200, shift(-30), 'approved');

    await expect(rematchLines(COMPANY, created.id)).rejects.toBeInstanceOf(ReconciliationClosedError);
    const viaRoute = await callRematch(created.id);
    expect(viaRoute.status).toBe(409);

    expect(await snapshot()).toEqual(before);
  });
});
