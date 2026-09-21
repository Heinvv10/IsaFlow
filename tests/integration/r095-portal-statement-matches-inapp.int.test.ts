/**
 * R-095 — the customer portal statement and invoice list were broken: every
 * portal route 500'd (a default import of the `cookie` package, which has none,
 * under Next's webpack), and past that the statement selected a `total` column
 * that doesn't exist and filtered receipts on a status ('posted') the CHECK
 * constraint forbids. fix.md has the reproduction on master.
 *
 * What this file proves, on the fixture in r095-portal.fixture.ts:
 *   - the portal statement IS the in-app emailed statement
 *     (statementEmailService.fetchStatementData) — same rows, same running
 *     balance, same closing balance, to the cent — and agrees with the in-app
 *     Customer Statements detail screen (customer-statement-detail) on every
 *     row and on the closing balance;
 *   - draft, cancelled and pending_approval invoices, a soft-deleted invoice,
 *     a draft receipt and a draft credit note never reach the portal, through
 *     the one shared population rule (shared/documentPopulation);
 *   - the invoice list follows the same rule and its own company predicate;
 *   - the chat quotes the statement's balance;
 *   - `asOf` is validated and honoured.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SignJWT } from 'jose';
import { sql } from '@/lib/neon';
import { fetchStatementData } from '@/modules/accounting/services/ar/statementEmailService';
import { asAtTodayStr } from '@/modules/accounting/services/shared/softDeleteLedgerPresence';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import { EXPECTED_CLOSING, callPortal, cleanupPortalFixture, seedPortalFixture, shift, tokenFor, type PortalFixture } from './r095-portal.fixture';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;
const TODAY = asAtTodayStr();

let f: PortalFixture;
let token = '';

interface Txn { date: string; reference: string; debit: number; credit: number; balance: number; description?: string }

describeIfDb('R-095 portal statement matches the in-app statement', () => {
  beforeAll(async () => {
    assertDisposable();
    delete process.env.ANTHROPIC_API_KEY;
    f = await seedPortalFixture();
    token = await tokenFor(f.customerA, f.companyA, f.emailA);
  }, 120000);

  afterAll(async () => { await cleanupPortalFixture(f); }, 120000);

  it("premise: customer_invoices has no `total` column and 'posted' is not a customer_payments status", async () => {
    await expect(sql`SELECT total FROM customer_invoices LIMIT 1`).rejects.toThrow(/column "total" does not exist/);
    await expect(sql`
      INSERT INTO customer_payments (company_id, client_id, payment_number, payment_date, total_amount, status, created_by)
      VALUES (${f.companyA}::UUID, ${f.customerA}::UUID, ${f.tag + '-BAD'}, ${TODAY}::date, 1, 'posted', ${f.user}::UUID)
    `).rejects.toThrow(/check constraint/);
  });

  it('statement: identical to the emailed statement, row for row and to the cent', async () => {
    const email = await fetchStatementData(f.companyA, f.customerA, TODAY);
    const { status, body } = await callPortal('statement', token, { query: { clientId: f.customerA } });
    expect(status).toBe(200);
    const data = body.data as { openingBalance: number; closingBalance: number; asOfDate: string; transactions: Txn[] };

    expect(data.asOfDate).toBe(TODAY);
    expect(data.openingBalance).toBe(0);
    expect(data.transactions.map(({ date, reference, debit, credit, balance }) => ({ date, reference, debit, credit, balance })))
      .toEqual(email!.transactions.map(({ date, reference, debit, credit, balance }) => ({ date, reference, debit, credit, balance })));
    expect(data.closingBalance).toBe(email!.summary.balance);
    expect(data.closingBalance).toBe(EXPECTED_CLOSING);

    expect(data.transactions.map(t => t.reference.slice(f.tag.length + 1)).sort()).toEqual([
      'CN-APPLIED', 'CN-APPROVED', 'INV-1', 'INV-2', 'INV-3', 'INV-N', 'RCPT-1', 'RCPT-2', 'RCPT-U',
    ]);
    expect(data.transactions.find(t => t.reference.endsWith('-CN-APPLIED'))).toMatchObject({ credit: 200, description: 'Credit Note' });
    expect(data.transactions.find(t => t.reference.endsWith('-RCPT-U'))).toMatchObject({ credit: 250, description: 'Payment' });
  });

  it('statement: agrees with the in-app Customer Statements detail screen on every row and the closing balance', async () => {
    const jwt = await new SignJWT({ sub: f.user, aal: 'aal2' })
      .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h')
      .sign(new TextEncoder().encode(process.env.JWT_SECRET));
    const { default: route } = await import('../../pages/api/accounting/customer-statement-detail');
    const req = request({ 'sb-access-token': jwt, active_company_id: f.companyA }, 'GET');
    (req as unknown as { query: unknown }).query = { client_id: f.customerA };
    const result = response();
    await (route as unknown as (a: unknown, b: unknown) => Promise<void>)(req, result.res);
    expect(result.state.statusCode).toBe(200);
    const screen = (result.state.body as { data: { transactions: Txn[]; summary: { balance: number } } }).data;

    const portal = (await callPortal('statement', token, { query: { clientId: f.customerA } })).body.data as { transactions: Txn[]; closingBalance: number };
    const shape = (t: Txn) => ({ date: t.date, reference: t.reference, debit: t.debit, credit: t.credit, balance: t.balance });
    expect(portal.transactions.map(shape)).toEqual(screen.transactions.map(shape));
    expect(portal.closingBalance).toBe(screen.summary.balance);
  });

  it('statement: asOf is honoured — a date before RCPT-U, INV-3 and both credit notes gives the emailed figure at that date', async () => {
    const asOf = shift(-25);
    const email = await fetchStatementData(f.companyA, f.customerA, asOf);
    const { status, body } = await callPortal('statement', token, { query: { clientId: f.customerA, asOf } });
    expect(status).toBe(200);
    const data = body.data as { closingBalance: number; transactions: Txn[] };
    expect(data.closingBalance).toBe(email!.summary.balance);
    // 1000 + 500 + 200 - 400 - 500; both credit notes (-15, -12) fall after asOf
    expect(data.closingBalance).toBe(800);
  });

  it('statement: asOf that is not a real calendar date is a 400, never a database error', async () => {
    for (const asOf of ['garbage', '2026-02-31', '2026-13-01', '2026-00-10', '0000-01-01', [TODAY, TODAY]]) {
      const { status } = await callPortal('statement', token, { query: { clientId: f.customerA, asOf } });
      expect(status, `asOf=${JSON.stringify(asOf)}`).toBe(400);
    }
    expect((await callPortal('statement', token, { query: { clientId: f.customerA, asOf: '2024-02-29' } })).status).toBe(200);
  });

  it('invoice list: the shared population rule, its own company predicate, and plain dates', async () => {
    const { status, body } = await callPortal('invoices', token, { query: { clientId: f.customerA } });
    expect(status).toBe(200);
    const items = (body.data as { items: { invoiceNumber: string; invoiceDate: string; dueDate: string; total: number; balance: number }[] }).items;
    expect(items.map(i => i.invoiceNumber.slice(f.tag.length + 1)).sort()).toEqual(['INV-1', 'INV-2', 'INV-3', 'INV-N']);
    const inv1 = items.find(i => i.invoiceNumber.endsWith('-INV-1'))!;
    expect(inv1).toMatchObject({ total: 1000, balance: 600, invoiceDate: shift(-60), dueDate: shift(-30) });
  });

  it('chat: quotes the statement closing balance and counts open invoices by the same rule', async () => {
    const { status, body } = await callPortal('chat', token, { body: { question: 'what do I owe?', clientId: f.customerA } });
    expect(status).toBe(200);
    const ctx = (body.data as { clientContext: { balance: number; openInvoices: number } }).clientContext;
    expect(ctx.balance).toBe(EXPECTED_CLOSING);
    expect(ctx.openInvoices).toBe(3); // INV-1 (600 open), INV-3, INV-N
  });
});
