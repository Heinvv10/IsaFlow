/**
 * R-112 / R-113 — the two in-app customer statements stated a different balance
 * from the emailed statement (statementEmailService.fetchStatementData), which
 * R-095 established as the correct document.
 *
 *   R-112 customer-statement-detail (Customer Statements detail screen, and the
 *         batch PDFs built from it) credited a partly allocated receipt at its
 *         ALLOCATED figure, so the unallocated remainder vanished.
 *   R-113 customer-statement (customers/statement screen, its PDF and the HTML
 *         print) had the same receipt defect, counted 'approved' credit notes
 *         only, and defaulted to a one-year window with no opening balance, so
 *         older activity dropped out of the balance.
 *
 * Every figure below is checked against the emailed statement, not just a
 * literal, so the screens cannot drift from the email again unnoticed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SignJWT } from 'jose';
import { sql } from '@/lib/neon';
import { fetchStatementData } from '@/modules/accounting/services/ar/statementEmailService';
import { asAtTodayStr } from '@/modules/accounting/services/shared/softDeleteLedgerPresence';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import { EXPECTED_CLOSING, cleanupPortalFixture, seedPortalFixture, shift, type PortalFixture } from './r095-portal.fixture';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;
const TODAY = asAtTodayStr();

interface Txn { type: string; reference: string; debit: number; credit: number; balance: number }
interface Summary { totalInvoiced: number; totalPaid: number; totalCredits: number; openingBalance?: number; balance: number }
type Handler = (a: unknown, b: unknown) => Promise<void>;

let f: PortalFixture;
let jwt = '';

async function callRoute(route: 'customer-statement' | 'customer-statement-detail', query: Record<string, string>) {
  const mod = route === 'customer-statement'
    ? await import('../../pages/api/accounting/customer-statement')
    : await import('../../pages/api/accounting/customer-statement-detail');
  const req = request({ 'sb-access-token': jwt, active_company_id: f.companyA }, 'GET');
  (req as unknown as { query: unknown }).query = query;
  const result = response();
  // format=pdf answers with res.send(html), which the shared helper lacks.
  Object.assign(result.state, { send(body: unknown) { result.state.body = body; return result.state; } });
  await (mod.default as unknown as Handler)(req, result.res);
  return result.state;
}

async function detail(clientId: string) {
  const state = await callRoute('customer-statement-detail', { client_id: clientId });
  expect(state.statusCode).toBe(200);
  return (state.body as { data: { transactions: Txn[]; summary: Summary } }).data;
}

async function statement(customerId: string, extra: Record<string, string> = {}) {
  const state = await callRoute('customer-statement', { customerId, ...extra });
  expect(state.statusCode).toBe(200);
  return (state.body as { data: { transactions: Txn[]; summary: Summary } }).data;
}

/** A fresh customer in company A with the given documents; returns its id. */
async function customerWith(label: string, docs: {
  invoices?: [string, number, number][];                  // suffix, total, day offset
  receipts?: [string, number, number, string, number?][]; // suffix, total, day, status, allocated to the first invoice
  credits?: [string, string, number, number, number][];   // suffix, status, total, applied, day
}): Promise<string> {
  const [c] = (await sql`INSERT INTO customers (company_id, name, email) VALUES (${f.companyA}::UUID, ${label + ' ' + f.tag}, ${label + '-' + f.tag + '@test.local'}) RETURNING id`) as { id: string }[];
  const invoiceIds: string[] = [];
  for (const [suffix, total, days] of docs.invoices ?? []) {
    const [inv] = (await sql`
      INSERT INTO customer_invoices (company_id, client_id, customer_id, invoice_number, invoice_date, due_date, status, subtotal, tax_amount, total_amount, amount_paid, created_by)
      VALUES (${f.companyA}::UUID, ${c!.id}::UUID, ${c!.id}::UUID, ${f.tag + '-' + label + '-' + suffix}, ${shift(days)}::date, ${shift(days + 30)}::date, 'approved', ${total}, 0, ${total}, 0, ${f.user}::UUID)
      RETURNING id`) as { id: string }[];
    invoiceIds.push(inv!.id);
  }
  for (const [suffix, total, days, status, allocated] of docs.receipts ?? []) {
    const [r] = (await sql`
      INSERT INTO customer_payments (company_id, client_id, payment_number, payment_date, total_amount, status, created_by)
      VALUES (${f.companyA}::UUID, ${c!.id}::UUID, ${f.tag + '-' + label + '-' + suffix}, ${shift(days)}::date, ${total}, ${status}, ${f.user}::UUID)
      RETURNING id`) as { id: string }[];
    if (allocated) {
      await sql`INSERT INTO customer_payment_allocations (payment_id, invoice_id, amount_allocated) VALUES (${r!.id}::UUID, ${invoiceIds[0]!}::UUID, ${allocated})`;
    }
  }
  for (const [suffix, status, total, applied, days] of docs.credits ?? []) {
    await sql`
      INSERT INTO credit_notes (company_id, client_id, type, credit_note_number, credit_date, status, subtotal, total_amount, applied_amount, created_by)
      VALUES (${f.companyA}::UUID, ${c!.id}::UUID, 'customer', ${f.tag + '-' + label + '-' + suffix}, ${shift(days)}::date, ${status}, ${total}, ${total}, ${applied}, ${f.user}::UUID)`;
  }
  return c!.id;
}

async function emailBalance(customerId: string): Promise<number> {
  return (await fetchStatementData(f.companyA, customerId, TODAY))!.summary.balance;
}

describeIfDb('R-112 / R-113 in-app customer statements state the emailed balance', () => {
  beforeAll(async () => {
    assertDisposable();
    f = await seedPortalFixture();
    jwt = await new SignJWT({ sub: f.user, aal: 'aal2' })
      .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h')
      .sign(new TextEncoder().encode(process.env.JWT_SECRET));
  }, 120000);

  afterAll(async () => { await cleanupPortalFixture(f); }, 120000);

  it('R-112 + R-113: a partly allocated receipt (R1,000, R600 allocated) is credited in full on both screens', async () => {
    const c = await customerWith('part', {
      invoices: [['INV', 1500, -20]],
      receipts: [['RCPT', 1000, -10, 'confirmed', 600]],
    });
    expect(await emailBalance(c)).toBe(500);
    for (const data of [await detail(c), await statement(c)]) {
      expect(data.transactions.find(t => t.type === 'payment')).toMatchObject({ credit: 1000 });
      expect(data.summary).toMatchObject({ totalInvoiced: 1500, totalPaid: 1000, balance: 500 });
      expect(data.transactions.at(-1)!.balance).toBe(500);
    }
  });

  it('R-113: every live credit note counts, valued as the email values it (applied at applied_amount, partly applied at face)', async () => {
    const c = await customerWith('cn', {
      invoices: [['INV', 1000, -30]],
      credits: [['APPLIED', 'applied', 300, 200, -20], ['PART', 'partially_applied', 150, 50, -15], ['DRAFT', 'draft', 90, 0, -10]],
    });
    // 1000 - 200 (applied: what it consumed) - 150 (partly applied: face value); the draft is not live
    expect(await emailBalance(c)).toBe(650);
    const data = await statement(c);
    expect(data.summary).toMatchObject({ totalCredits: 350, balance: 650 });
    expect(data.transactions.filter(t => t.type === 'credit_note').map(t => t.credit).sort()).toEqual([150, 200]);
    const screen = await detail(c);
    expect(screen.summary).toMatchObject({ totalCredits: 350, balance: 650 });
    expect(screen.transactions.filter(t => t.type === 'credit_note').map(t => t.credit).sort()).toEqual([150, 200]);
  });

  it('R-113: the R-095 fixture customer states the emailed closing balance on the default statement', async () => {
    expect(await emailBalance(f.customerA)).toBe(EXPECTED_CLOSING);
    expect((await statement(f.customerA)).summary.balance).toBe(EXPECTED_CLOSING);
    expect((await detail(f.customerA)).summary.balance).toBe(EXPECTED_CLOSING);
  });

  it('R-113: activity before the default one-year window is brought forward, not dropped', async () => {
    const c = await customerWith('old', {
      invoices: [['INV', 1000, -400]],
      receipts: [['RCPT', 400, -30, 'confirmed'], ['OLD-DRAFT', 999, -390, 'draft']],
      credits: [['OLD-CN', 'applied', 300, 200, -380]],
    });
    // 1000 - 200 (old applied note) - 400 (recent receipt); the draft receipt settles nothing
    expect(await emailBalance(c)).toBe(400);

    const data = await statement(c);
    expect(data.summary).toMatchObject({ openingBalance: 800, totalInvoiced: 0, totalPaid: 400, totalCredits: 0, balance: 400 });
    expect(data.transactions[0]).toMatchObject({ type: 'opening_balance', debit: 800, credit: 0, balance: 800 });
    expect(data.transactions.at(-1)).toMatchObject({ type: 'payment', balance: 400 });

    // A window that covers the whole history has nothing to bring forward.
    const full = await statement(c, { fromDate: shift(-500), toDate: TODAY });
    expect(full.summary).toMatchObject({ openingBalance: 0, totalInvoiced: 1000, balance: 400 });
    expect(full.transactions.some(t => t.type === 'opening_balance')).toBe(false);
  });

  it('R-113: the printable statement carries the brought-forward line and the true balance', async () => {
    const c = await customerWith('print', {
      invoices: [['INV', 1000, -400]],
      receipts: [['RCPT', 400, -30, 'confirmed']],
    });
    const state = await callRoute('customer-statement', { customerId: c, format: 'pdf' });
    expect(state.statusCode).toBe(200);
    const html = String(state.body);
    expect(html).toContain('Balance brought forward');
    expect(html).not.toContain('opening_balance');
    expect(html).toMatch(/Balance Due<\/div><div class="value"[^>]*>R\s?600[.,]00/);
  });

  it('R-113: the brought-forward figure uses the same rules as the window — boundary day, dead credit notes, soft-deleted invoices', async () => {
    const from = shift(-100);
    const c = await customerWith('edge', {
      invoices: [['INV-OLD', 1000, -200], ['INV-EDGE', 70, -100], ['INV-DEL', 555, -150]],
      credits: [['CN-DRAFT', 'draft', 40, 0, -180], ['CN-CANCELLED', 'cancelled', 60, 0, -170], ['CN-EDGE', 'approved', 30, 0, -100]],
    });
    await sql`UPDATE customer_invoices SET deleted_at = NOW() WHERE invoice_number = ${f.tag + '-edge-INV-DEL'}`;
    // 1000 + 70 - 30; the deleted invoice and the dead notes never count
    expect(await emailBalance(c)).toBe(1040);

    const data = await statement(c, { fromDate: from });
    // A document dated ON fromDate is in the window, never also in the opening.
    expect(data.summary).toMatchObject({ openingBalance: 1000, totalInvoiced: 70, totalCredits: 30, balance: 1040 });
    expect(data.transactions.map(t => t.type)).toEqual(['opening_balance', 'invoice', 'credit_note']);
  });

  it('R-112: the detail screen leaves out post-dated documents, as the email as at today does', async () => {
    const c = await customerWith('future', {
      invoices: [['INV', 1000, -10], ['INV-FUTURE', 700, 5]],
      receipts: [['RCPT-FUTURE', 300, 3, 'confirmed']],
      credits: [['CN-FUTURE', 'approved', 50, 0, 4]],
    });
    expect(await emailBalance(c)).toBe(1000);
    const data = await detail(c);
    expect(data.summary).toMatchObject({ totalInvoiced: 1000, totalPaid: 0, totalCredits: 0, balance: 1000 });
    expect(data.transactions).toHaveLength(1);
  });

  it('R-112: a soft-deleted customer has no statement on the detail screen, as on the email', async () => {
    const c = await customerWith('gone', { invoices: [['INV', 100, -10]] });
    await sql`UPDATE customers SET deleted_at = NOW() WHERE id = ${c}::UUID`;
    expect(await fetchStatementData(f.companyA, c, TODAY)).toBeNull();
    expect((await callRoute('customer-statement-detail', { client_id: c })).statusCode).toBe(404);
  });

  it('R-113: balances are summed in cents, not floats', async () => {
    const c = await customerWith('cents', {
      invoices: [['INV-1', 100.1, -10], ['INV-2', 200.2, -9]],
    });
    expect(await emailBalance(c)).toBe(300.3);
    for (const data of [await statement(c), await detail(c)]) {
      expect(data.summary.balance).toBe(300.3);
      expect(data.transactions.at(-1)!.balance).toBe(300.3);
    }
  });

  it('R-113: a window that is not a real date range is a 400, never a database error', async () => {
    const c = await customerWith('dates', {});
    for (const q of [{ fromDate: 'garbage' }, { toDate: '2026-02-31' }, { fromDate: TODAY, toDate: shift(-1) }]) {
      expect((await callRoute('customer-statement', { customerId: c, ...q })).statusCode, JSON.stringify(q)).toBe(400);
    }
  });
});
