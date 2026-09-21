/**
 * R-095 round 4 (blind review r1): the chat's overdue figure, a refund on the
 * statement, a NULL-status invoice's badge, and the chat's company source.
 *
 * Customer R (company A), as at today:
 *   INV-X 1000, due 30 days ago, 600 allocated from RCPT-R (800 received)
 *   INV-Y 30, not yet due
 *   INV-Z 999 dated in the future; DRAFT-ND 300 and SOFTDEL-ND 400 not yet due -> none on the statement
 *   CN-R approved 150; REFUND-R -100 (money paid back)
 *   closing = 1030 - 800 - 150 + 100 = 180; not yet due = 30; overdue = 150
 * The old overdue (sum of past-due invoice balances) said 400: more than the
 * customer owes at all.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from '@/lib/neon';
import { fetchStatementData } from '@/modules/accounting/services/ar/statementEmailService';
import { asAtTodayStr } from '@/modules/accounting/services/shared/softDeleteLedgerPresence';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callPortal, cleanupPortalFixture, seedPortalFixture, shift, tokenFor, type PortalFixture } from './r095-portal.fixture';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;
const TODAY = asAtTodayStr();

let f: PortalFixture;
let customerR = '';
const emailR = () => `r-${f.tag}@test.local`;

interface ChatBody { data: { clientContext: { balance: number; overdue: number; openInvoices: number } } }

/** Runs the chat with a live-looking API key and captures the prompt the route sends to the model. */
async function chatCapturingPrompt(token: string, body: Record<string, unknown>) {
  process.env.ANTHROPIC_API_KEY = 'r095-test-key-never-sent';
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 503 }));
  try {
    const result = await callPortal('chat', token, { body });
    const sent = fetchSpy.mock.calls[0]?.[1]?.body;
    const prompt = sent ? (JSON.parse(String(sent)) as { messages: { content: string }[] }).messages[0]!.content : '';
    return { ...result, prompt };
  } finally {
    fetchSpy.mockRestore();
    delete process.env.ANTHROPIC_API_KEY;
  }
}

describeIfDb('R-095 round 4', () => {
  beforeAll(async () => {
    assertDisposable();
    f = await seedPortalFixture();
    customerR = ((await sql`INSERT INTO customers (company_id, name, email) VALUES (${f.companyA}::UUID, ${'cust-r ' + f.tag}, ${emailR()}) RETURNING id`) as { id: string }[])[0]!.id;
    await sql`INSERT INTO portal_access (client_id, email, password_hash, name) VALUES (${customerR}::UUID, ${emailR()}, 'x', 'R')`;
    const inv = async (suffix: string, status: string, total: number, paid: number, date: number, due: number, deleted = false) =>
      ((await sql`
        INSERT INTO customer_invoices (company_id, client_id, customer_id, invoice_number, invoice_date, due_date, status, subtotal, tax_amount, total_amount, amount_paid, created_by, deleted_at)
        VALUES (${f.companyA}::UUID, ${customerR}::UUID, ${customerR}::UUID, ${f.tag + '-' + suffix}, ${shift(date)}::date, ${shift(due)}::date, ${status}, ${total}, 0, ${total}, ${paid}, ${f.user}::UUID, ${deleted ? new Date() : null})
        RETURNING id`) as { id: string }[])[0]!.id;
    const x = await inv('INV-X', 'approved', 1000, 600, -60, -30);
    await inv('INV-Y', 'approved', 30, 0, -5, 25);
    await inv('INV-Z', 'approved', 999, 0, 5, 35);
    await inv('DRAFT-ND', 'draft', 300, 0, -5, 25);
    await inv('SOFTDEL-ND', 'approved', 400, 0, -5, 25, true);
    const pay = async (suffix: string, total: number, method: string, days: number) =>
      ((await sql`
        INSERT INTO customer_payments (company_id, client_id, payment_number, payment_date, total_amount, payment_method, status, created_by)
        VALUES (${f.companyA}::UUID, ${customerR}::UUID, ${f.tag + '-' + suffix}, ${shift(days)}::date, ${total}, ${method}, 'confirmed', ${f.user}::UUID)
        RETURNING id`) as { id: string }[])[0]!.id;
    const r = await pay('RCPT-R', 800, 'eft', -40);
    await pay('REFUND-R', -100, 'refund', -3);
    await sql`INSERT INTO customer_payment_allocations (payment_id, invoice_id, amount_allocated) VALUES (${r}::UUID, ${x}::UUID, 600)`;
    await sql`
      INSERT INTO credit_notes (company_id, client_id, type, credit_note_number, credit_date, status, subtotal, total_amount, applied_amount, created_by)
      VALUES (${f.companyA}::UUID, ${customerR}::UUID, 'customer', ${f.tag + '-CN-R'}, ${shift(-20)}::date, 'approved', 150, 150, 0, ${f.user}::UUID)`;
  }, 120000);

  afterEach(() => vi.restoreAllMocks());

  afterAll(async () => {
    await sql`DELETE FROM portal_access WHERE client_id = ${customerR}::UUID`;
    await sql`DELETE FROM customer_payment_allocations WHERE payment_id IN (SELECT id FROM customer_payments WHERE client_id = ${customerR}::UUID)`;
    await cleanupPortalFixture(f);
  }, 120000);

  it('chat: overdue is derived from the statement balance, never exceeds it, and is what the model is told', async () => {
    const token = await tokenFor(customerR, f.companyA, emailR());
    const { status, body, prompt } = await chatCapturingPrompt(token, { question: 'what is overdue?', clientId: customerR });
    expect(status).toBe(200);
    const ctx = (body as unknown as ChatBody).data.clientContext;
    const email = await fetchStatementData(f.companyA, customerR, TODAY);
    expect(ctx.balance).toBe(email!.summary.balance);
    expect(ctx.balance).toBe(180);
    expect(ctx.overdue).toBe(150);
    expect(ctx.overdue).toBeLessThanOrEqual(ctx.balance);
    expect(prompt).toContain('Outstanding balance: R180');
    expect(prompt).toContain('Overdue: R150');
  });

  it('chat: customer A of the shared fixture — overdue 200 of 1434.56 (1234.56 of it not yet due)', async () => {
    const { body } = await callPortal('chat', await tokenFor(f.customerA, f.companyA, f.emailA), { body: { question: 'overdue?', clientId: f.customerA } });
    expect((body as unknown as ChatBody).data.clientContext).toMatchObject({ balance: 1434.56, overdue: 200 });
  });

  it("chat: the company comes only from the session — another tenant's companyId in the body changes nothing", async () => {
    const token = await tokenFor(customerR, f.companyA, emailR());
    const plain = await callPortal('chat', token, { body: { question: 'balance', clientId: customerR } });
    const injected = await callPortal('chat', token, { body: { question: 'balance', clientId: customerR, companyId: f.companyB, company_id: f.companyB } });
    expect(injected.status).toBe(200);
    expect((injected.body as unknown as ChatBody).data.clientContext).toEqual((plain.body as unknown as ChatBody).data.clientContext);
  });

  it('statement: a refund is a debit named "Refund" and the balance moves the way the columns say', async () => {
    const { status, body } = await callPortal('statement', await tokenFor(customerR, f.companyA, emailR()), { query: { clientId: customerR } });
    expect(status).toBe(200);
    const rows = (body.data as { transactions: { reference: string; description: string; debit: number; credit: number; balance: number }[]; closingBalance: number });
    const i = rows.transactions.findIndex(t => t.reference === f.tag + '-REFUND-R');
    expect(rows.transactions[i]).toMatchObject({ description: 'Refund', debit: 100, credit: 0 });
    for (const [k, t] of rows.transactions.entries()) {
      const before = k === 0 ? 0 : rows.transactions[k - 1]!.balance;
      expect(t.balance, t.reference).toBeCloseTo(before + t.debit - t.credit, 2);
    }
    expect(rows.closingBalance).toBe(180);
  });

  it('invoice list: a NULL-status invoice carries status null, not the string "null"', async () => {
    const { body } = await callPortal('invoices', await tokenFor(f.customerA, f.companyA, f.emailA), { query: { clientId: f.customerA } });
    const items = (body.data as { items: { invoiceNumber: string; status: string | null }[] }).items;
    expect(items.find(i => i.invoiceNumber === f.tag + '-INV-N')!.status).toBeNull();
  });
});
