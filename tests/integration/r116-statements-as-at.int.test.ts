/**
 * R-116 — the customer balances list (`customer-statements`) and the batch
 * statement detail (`customer-statement-detail`) ignored the `as_at_date` their
 * pages send: a user who picked month-end saw today's balances labelled as
 * month-end, and the batch PDFs printed the picked date on today's figures.
 * Each must state the emailed statement's balance AS AT the date asked.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SignJWT } from 'jose';
import { sql } from '@/lib/neon';
import { fetchStatementData } from '@/modules/accounting/services/ar/statementEmailService';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import { cleanupPortalFixture, seedPortalFixture, shift, type PortalFixture } from './r095-portal.fixture';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

interface Row { client_id: string; total_invoiced: number; total_paid: number; total_credits: number; balance: number }
interface Detail { transactions: { reference: string }[]; summary: { totalInvoiced: number; totalPaid: number; totalCredits: number; balance: number } }

let f: PortalFixture;
let jwt = '';

async function call(path: string, query: Record<string, string>): Promise<{ status: number; body: unknown }> {
  const { default: route } = await import(`../../pages/api/accounting/${path}`);
  const req = request({ 'sb-access-token': jwt, active_company_id: f.companyA }, 'GET');
  (req as unknown as { query: unknown }).query = query;
  const result = response();
  await (route as unknown as (a: unknown, b: unknown) => Promise<void>)(req, result.res);
  return { status: result.state.statusCode as number, body: result.state.body };
}
async function list(asAt?: string): Promise<Row[]> {
  const r = await call('customer-statements', asAt === undefined ? {} : { as_at_date: asAt });
  expect(r.status).toBe(200);
  return (r.body as { data: { customers: Row[] } }).data.customers;
}
async function detail(clientId: string, asAt?: string): Promise<Detail> {
  const r = await call('customer-statement-detail', asAt === undefined ? { client_id: clientId } : { client_id: clientId, as_at_date: asAt });
  expect(r.status).toBe(200);
  return (r.body as { data: Detail }).data;
}
const emailBalance = async (c: string, asAt: string) => (await fetchStatementData(f.companyA, c, asAt))!.summary.balance;

describeIfDb('R-116 statements honour the as-at date they are asked for', () => {
  let paying = '';
  let late = '';

  beforeAll(async () => {
    assertDisposable();
    f = await seedPortalFixture();
    jwt = await new SignJWT({ sub: f.user, aal: 'aal2' })
      .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h')
      .sign(new TextEncoder().encode(process.env.JWT_SECRET));

    const customer = async (label: string) => {
      const [c] = (await sql`INSERT INTO customers (company_id, name, email) VALUES (${f.companyA}::UUID, ${label + ' ' + f.tag}, ${label + '-' + f.tag + '@test.local'}) RETURNING id`) as { id: string }[];
      return c!.id;
    };
    const invoice = (c: string, suffix: string, total: number, days: number) => sql`
      INSERT INTO customer_invoices (company_id, client_id, customer_id, invoice_number, invoice_date, due_date, status, subtotal, tax_amount, total_amount, amount_paid, created_by)
      VALUES (${f.companyA}::UUID, ${c}::UUID, ${c}::UUID, ${f.tag + '-' + suffix}, ${shift(days)}::date, ${shift(days + 30)}::date, 'approved', ${total}, 0, ${total}, 0, ${f.user}::UUID)`;

    // 1000 invoiced 30 days ago, 400 received 10 days ago, a 100 note 5 days ago.
    paying = await customer('paying');
    await invoice(paying, 'P-INV', 1000, -30);
    await sql`
      INSERT INTO customer_payments (company_id, client_id, payment_number, payment_date, total_amount, status, created_by)
      VALUES (${f.companyA}::UUID, ${paying}::UUID, ${f.tag + '-P-RCPT'}, ${shift(-10)}::date, 400, 'confirmed', ${f.user}::UUID)`;
    await sql`
      INSERT INTO credit_notes (company_id, client_id, type, credit_note_number, credit_date, status, subtotal, total_amount, applied_amount, created_by)
      VALUES (${f.companyA}::UUID, ${paying}::UUID, 'customer', ${f.tag + '-P-CN'}, ${shift(-5)}::date, 'approved', 100, 100, 0, ${f.user}::UUID)`;
    // A customer whose only document is dated after the earlier as-at dates.
    late = await customer('late');
    await invoice(late, 'L-INV', 250, -3);
  }, 120000);

  afterAll(async () => { await cleanupPortalFixture(f); }, 120000);

  it('the list states each balance as at the date asked, not as at today', async () => {
    for (const [days, balance] of [[-20, 1000], [-7, 600], [0, 500]] as const) {
      const asAt = shift(days);
      expect(await emailBalance(paying, asAt)).toBe(balance);
      const row = (await list(asAt)).find(r => r.client_id === paying);
      expect(row, asAt).toMatchObject({ balance });
    }
    expect((await list(shift(-20))).find(r => r.client_id === paying)).toMatchObject({
      total_invoiced: 1000, total_paid: 0, total_credits: 0,
    });
  });

  it('a customer with no activity on or before the as-at date has no row', async () => {
    expect((await list(shift(-5))).some(r => r.client_id === late)).toBe(false);
    expect((await list(shift(-3))).find(r => r.client_id === late)).toMatchObject({ balance: 250 });
  });

  it('with no as-at date the list is as at today', async () => {
    expect((await list()).find(r => r.client_id === paying)).toMatchObject({ balance: 500 });
  });

  it('the statement detail behind the batch PDFs is drawn as at the date asked', async () => {
    const d = await detail(paying, shift(-7));
    expect(d.summary).toEqual({ totalInvoiced: 1000, totalPaid: 400, totalCredits: 0, balance: 600 });
    expect(d.transactions.map(t => t.reference)).toEqual([f.tag + '-P-INV', f.tag + '-P-RCPT']);
    expect(d.summary.balance).toBe(await emailBalance(paying, shift(-7)));
    expect((await detail(paying)).summary.balance).toBe(500);
  });

  it('refuses an as-at date that is not a real date, instead of a 500 or today', async () => {
    for (const bad of ['garbage', '2026-02-30']) {
      expect((await call('customer-statements', { as_at_date: bad })).status, bad).toBe(400);
      expect((await call('customer-statement-detail', { client_id: paying, as_at_date: bad })).status, bad).toBe(400);
    }
  });
});
