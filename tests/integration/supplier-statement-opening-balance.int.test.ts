/**
 * A supplier statement's "Balance brought forward" line is an opening-balance check, not an invoice
 * (Hein, 2026-11-07, D1; found seeding the Demo company, where every statement showed its B/F line as
 * "missing in IsaFlow").
 *
 *   BF        the B/F line is never matched and never counted missing in IsaFlow; it is compared with what
 *             IsaFlow owed the supplier the day before the first dated transaction line, from the same AP
 *             ageing the statement's own variance uses.
 *   LEGACY    a statement stored before the fix (its B/F line marked missing_in_isaflow) fixes itself on
 *             Rematch, through the route, without a re-upload.
 *   LOOKALIKE a bill with the B/F line's amount and date is not claimed by it: it stays "not on statement".
 *   POSITION  a "Balance brought forward" line dated after a transaction (a page carry-forward) is not the
 *             opening balance: it is matched, and counted, like any other line.
 *
 * Only the VLM extraction and the stored PDF bytes are mocked.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { SignJWT } from 'jose';
import { sql } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import { createAndRead } from './supplier-statement-read.helpers';

function shift(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return fmtDate(d);
}
const STMT = shift(-10);

type Line = { date: string; reference?: string; description?: string; debit?: number; credit?: number; runningBalance?: number };
let nextExtraction: { closingBalance: number; lines: Line[] } = { closingBalance: 0, lines: [] };

vi.mock('@/lib/afterCommit', async (original) => ({
  ...(await original<typeof import('@/lib/afterCommit')>()),
  runAfterCommit: () => undefined, // the job is driven by createAndRead
}));
vi.mock('@/modules/accounting/services/capture/supplierStatementExtraction', () => ({
  extractSupplierStatementFromDocument: vi.fn(async () => ({
    statementDate: STMT, periodStart: undefined, periodEnd: undefined,
    closingBalance: nextExtraction.closingBalance, lines: nextExtraction.lines, warnings: [],
  })),
}));

const { getReconciliation } = await import('@/modules/accounting/services/capture/supplierStatementReconService');
const rematchRoute = (await import('../../pages/api/accounting/supplier-statements/[id]/rematch')).default;

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

const COMPANY = randomUUID();
const OTHER = randomUUID();
const USER = randomUUID();
const TAG = `SSOB${Math.floor(Math.random() * 1e8)}`;
const KEYS = ['BF', 'LOOK', 'POS', 'GONE', 'RUN'] as const;
const docs = { BF: randomUUID(), LOOK: randomUUID(), POS: randomUUID(), GONE: randomUUID(), RUN: randomUUID() };
const suppliers = { BF: '', LOOK: '', POS: '', GONE: '', RUN: '' };
let token = '';

async function bill(supplier: string, n: string, gross: number, raised: string): Promise<string> {
  return ((await sql`
    INSERT INTO supplier_invoices (company_id, supplier_id, invoice_number, invoice_date, due_date,
      status, subtotal, tax_amount, total_amount, amount_paid, created_by)
    VALUES (${COMPANY}::UUID, ${supplier}::UUID, ${TAG + n}, ${raised}::date, ${raised}::date,
      'approved', ${gross}, 0, ${gross}, 0, ${USER}::UUID)
    RETURNING id`) as { id: string }[])[0]!.id;
}

async function callRematch(id: string): Promise<{ status: number; body: unknown }> {
  const req = request({ 'sb-access-token': token, active_company_id: COMPANY }, 'POST');
  (req as unknown as { query: unknown }).query = { id };
  const result = response();
  await (rematchRoute as unknown as (a: unknown, b: unknown) => Promise<void>)(req, result.res);
  return { status: result.state.statusCode as number, body: result.state.body };
}

const storedCount = async (id: string) => Number(((await sql`
  SELECT missing_in_isaflow_count AS n FROM supplier_statement_reconciliations
  WHERE id = ${id}::UUID AND company_id = ${COMPANY}::UUID`) as { n: number }[])[0]!.n);

describeIfDb('supplier statement: the balance brought forward is an opening-balance check', () => {
  beforeAll(async () => {
    assertDisposable();
    await sql`INSERT INTO companies (id, name, registration_number) VALUES (${COMPANY}::UUID, ${'SSOB ' + TAG}, ${TAG})`;
    await sql`INSERT INTO users (id, email, role, is_active) VALUES (${USER}, ${USER + '@test.local'}, 'admin', true)`;
    await sql`INSERT INTO company_users (company_id, user_id, role) VALUES (${COMPANY}::UUID, ${USER}, 'admin')`;
    for (const key of KEYS) {
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
    await sql`DELETE FROM supplier_invoices WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM suppliers WHERE company_id IN (${COMPANY}::UUID, ${OTHER}::UUID)`;
    await sql`DELETE FROM companies WHERE id = ${OTHER}::UUID`;
    await sql`DELETE FROM company_users WHERE user_id = ${USER}`;
    await sql`DELETE FROM companies WHERE id = ${COMPANY}::UUID`;
    await sql`DELETE FROM users WHERE id = ${USER}`;
  }, 120000);

  // IsaFlow owes 900 (bill raised at -70) before the first transaction; the supplier carries 1,000 forward.
  // The one transaction, a bill of 500 at -30, ties. Closing: supplier 1,500, IsaFlow 1,400.
  it('BF: never missing, and compared with what IsaFlow owed the day before the first transaction; LEGACY rows fix on Rematch', async () => {
    await bill(suppliers.BF, '-OLD', 900, shift(-70));
    await bill(suppliers.BF, '-NEW', 500, shift(-30));
    nextExtraction = { closingBalance: 1500, lines: [
      { date: shift(-60), reference: 'OPENING BALANCE', description: 'Balance brought forward', debit: 1000 },
      { date: shift(-30), reference: TAG + '-NEW', description: 'Tax invoice', debit: 500 },
    ] };
    const created = await createAndRead(COMPANY, suppliers.BF, docs.BF, USER);
    expect(created.missingInIsaflowCount).toBe(0);
    expect({ isaflow: created.isaflowBalance, variance: created.variance }).toEqual({ isaflow: 1400, variance: 100 });
    const bf = created.lines.find((l) => l.description === 'Balance brought forward')!;
    expect(bf).toMatchObject({ isOpeningBalance: true, mismatchReason: null, matchedSupplierInvoiceId: null });
    expect(created.lines.filter((l) => l.isOpeningBalance)).toHaveLength(1);
    expect(created.openingBalance).toEqual({ asAt: shift(-31), statementAmount: 1000, isaflowBalance: 900, variance: 100 });

    // LEGACY: what the reconciler stored before the fix (here a stale match too). A read already shows a clean
    // opening line; the stored counts heal on Rematch.
    const old = await bill(suppliers.BF, '-STALE', 1, shift(-90));
    await sql`UPDATE supplier_statement_lines SET mismatch_reason = 'missing_in_isaflow', matched_supplier_invoice_id = ${old}::UUID,
              match_confidence = 0.85 WHERE id = ${bf.id}::UUID`;
    const legacyRead = (await getReconciliation(COMPANY, created.id))!;
    expect(legacyRead.lines.find((l) => l.isOpeningBalance)).toMatchObject({
      mismatchReason: null, matchConfidence: null, matchedSupplierInvoiceId: null, matchedInvoiceNumber: null,
    });
    await sql`DELETE FROM supplier_invoices WHERE id = ${old}::UUID AND company_id = ${COMPANY}::UUID`;
    await sql`UPDATE supplier_statement_reconciliations SET missing_in_isaflow_count = 1
              WHERE id = ${created.id}::UUID AND company_id = ${COMPANY}::UUID`;
    expect(await storedCount(created.id)).toBe(1);
    const re = await callRematch(created.id);
    expect(re.status, JSON.stringify(re.body)).toBe(200);
    expect(await storedCount(created.id)).toBe(0);
    const after = (await getReconciliation(COMPANY, created.id))!;
    expect(after.lines.find((l) => l.isOpeningBalance)).toMatchObject({ mismatchReason: null });
    expect(after.openingBalance).toEqual(created.openingBalance);
  });

  it('RUNNING: a B/F line carrying only a running balance is compared at that figure', async () => {
    nextExtraction = { closingBalance: 900, lines: [
      { date: shift(-60), description: 'Balance b/f', runningBalance: 900 },
      { date: shift(-30), reference: TAG + '-RUN', description: 'Payment', credit: 0.01 },
    ] };
    await bill(suppliers.RUN, '-RUNOLD', 900, shift(-70));
    const created = await createAndRead(COMPANY, suppliers.RUN, docs.RUN, USER);
    // Its own supplier owes 900 (bill at -70) on the day before -30.
    expect(created.openingBalance).toMatchObject({ statementAmount: 900, isaflowBalance: 900, variance: 0 });
  });

  // A supplier delete cascades to its statements, so "no supplier row" at read time means the id now names
  // another company's supplier: the ageing then refuses it (not found), which must not fail the read.
  it('GONE: a statement whose supplier is no longer this company\'s still reads, without an opening check', async () => {
    nextExtraction = { closingBalance: 50, lines: [{ date: shift(-60), description: 'Opening balance', debit: 50 }] };
    const created = await createAndRead(COMPANY, suppliers.GONE, docs.GONE, USER);
    expect(created.openingBalance).toMatchObject({ statementAmount: 50 });
    await sql`INSERT INTO companies (id, name, registration_number) VALUES (${OTHER}::UUID, ${'SSOB other ' + TAG}, ${TAG + 'O'})`;
    await sql`UPDATE suppliers SET company_id = ${OTHER}::UUID WHERE id = ${suppliers.GONE}::UUID AND company_id = ${COMPANY}::UUID`;
    const read = await getReconciliation(COMPANY, created.id);
    expect(read).toMatchObject({ openingBalance: null });
    expect(read!.lines.find((l) => l.isOpeningBalance)).toBeTruthy();
  });

  it('LOOKALIKE: a bill with the B/F amount and date is not claimed by the B/F line', async () => {
    const look = await bill(suppliers.LOOK, '-LOOK', 1000, shift(-60));
    nextExtraction = { closingBalance: 1000, lines: [
      { date: shift(-60), description: 'Opening balance', debit: 1000 },
      { date: shift(-30), reference: TAG + '-PAY', description: 'Payment received', credit: 0.01 },
    ] };
    const created = await createAndRead(COMPANY, suppliers.LOOK, docs.LOOK, USER);
    expect(created.lines.find((l) => l.isOpeningBalance)).toMatchObject({ matchedSupplierInvoiceId: null, mismatchReason: null });
    expect(created.missingInvoices.map((m) => m.invoiceId)).toEqual([look]);
    expect(created.openingBalance).toMatchObject({ statementAmount: 1000, isaflowBalance: 1000, variance: 0 });
  });

  it('POSITION: a carry-forward line after a transaction is matched and counted like any line', async () => {
    await bill(suppliers.POS, '-P1', 400, shift(-40));
    nextExtraction = { closingBalance: 1100, lines: [
      { date: shift(-60), description: 'Balance brought forward', debit: 0 },
      { date: shift(-40), reference: TAG + '-P1', description: 'Tax invoice', debit: 400 },
      { date: shift(-35), description: 'Balance brought forward', debit: 700 },
    ] };
    const created = await createAndRead(COMPANY, suppliers.POS, docs.POS, USER);
    expect(created.lines.filter((l) => l.isOpeningBalance).map((l) => l.lineDate)).toEqual([shift(-60)]);
    expect(created.lines.find((l) => l.lineDate === shift(-35))).toMatchObject({
      isOpeningBalance: false, mismatchReason: 'missing_in_isaflow',
    });
    expect(created.missingInIsaflowCount).toBe(1);
  });
});
