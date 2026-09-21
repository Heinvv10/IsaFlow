/**
 * R-115 — the customer balances list (`customer-statements`: Statements,
 * Statement Run, Customer Statements) never read credit notes, so every listed
 * balance was overstated by the customer's live notes. The list is where staff
 * choose whom to chase and whom to send statements to, so each row must state
 * the balance of the statement it opens: the emailed statement as at today.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SignJWT } from 'jose';
import { sql } from '@/lib/neon';
import { fetchStatementData } from '@/modules/accounting/services/ar/statementEmailService';
import { asAtTodayStr } from '@/modules/accounting/services/shared/softDeleteLedgerPresence';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import { cleanupPortalFixture, seedPortalFixture, shift, type PortalFixture } from './r095-portal.fixture';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;
const TODAY = asAtTodayStr();

interface Row { client_id: string; total_invoiced: number; total_paid: number; total_credits: number; balance: number }

let f: PortalFixture;
let jwt = '';

async function list(): Promise<Row[]> {
  const { default: route } = await import('../../pages/api/accounting/customer-statements');
  const req = request({ 'sb-access-token': jwt, active_company_id: f.companyA }, 'GET');
  (req as unknown as { query: unknown }).query = {};
  const result = response();
  await (route as unknown as (a: unknown, b: unknown) => Promise<void>)(req, result.res);
  expect(result.state.statusCode).toBe(200);
  return (result.state.body as { data: { customers: Row[] } }).data.customers;
}

async function customer(label: string): Promise<string> {
  const [c] = (await sql`INSERT INTO customers (company_id, name, email) VALUES (${f.companyA}::UUID, ${label + ' ' + f.tag}, ${label + '-' + f.tag + '@test.local'}) RETURNING id`) as { id: string }[];
  return c!.id;
}
async function invoice(c: string, suffix: string, total: number, days: number, opts: { co?: string; clientIdColumn?: boolean } = {}) {
  const clientId = opts.clientIdColumn === false ? null : c;
  await sql`
    INSERT INTO customer_invoices (company_id, client_id, customer_id, invoice_number, invoice_date, due_date, status, subtotal, tax_amount, total_amount, amount_paid, created_by)
    VALUES (${opts.co ?? f.companyA}::UUID, ${clientId}::UUID, ${c}::UUID, ${f.tag + '-' + suffix}, ${shift(days)}::date, ${shift(days + 30)}::date, 'approved', ${total}, 0, ${total}, 0, ${f.user}::UUID)`;
}
async function receipt(c: string, suffix: string, total: number, days: number, co?: string) {
  await sql`
    INSERT INTO customer_payments (company_id, client_id, payment_number, payment_date, total_amount, status, created_by)
    VALUES (${co ?? f.companyA}::UUID, ${c}::UUID, ${f.tag + '-' + suffix}, ${shift(days)}::date, ${total}, 'confirmed', ${f.user}::UUID)`;
}
async function credit(c: string, suffix: string, status: string, total: number, applied: number, days: number, opts: { co?: string; type?: string } = {}) {
  await sql`
    INSERT INTO credit_notes (company_id, client_id, type, credit_note_number, credit_date, status, subtotal, total_amount, applied_amount, created_by)
    VALUES (${opts.co ?? f.companyA}::UUID, ${c}::UUID, ${opts.type ?? 'customer'}, ${f.tag + '-' + suffix}, ${shift(days)}::date, ${status}, ${total}, ${total}, ${applied}, ${f.user}::UUID)`;
}
const emailBalance = async (c: string) => (await fetchStatementData(f.companyA, c, TODAY))!.summary.balance;

describeIfDb('R-115 customer balances list states each statement balance', () => {
  let noted = '';
  let future = '';
  let gone = '';
  let deposit = '';
  let postOnly = '';
  let legacy = '';
  let creditOnly = '';

  beforeAll(async () => {
    assertDisposable();
    f = await seedPortalFixture();
    // A member of BOTH companies (an accountant, say): row-level security then
    // lets company B's rows through, so only the list's own company predicates
    // keep them out of company A's list.
    await sql`INSERT INTO company_users (company_id, user_id, role) VALUES (${f.companyB}::UUID, ${f.user}, 'admin')`;
    jwt = await new SignJWT({ sub: f.user, aal: 'aal2' })
      .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h')
      .sign(new TextEncoder().encode(process.env.JWT_SECRET));

    noted = await customer('noted');
    await invoice(noted, 'N-INV', 1000, -30);
    await credit(noted, 'N-CN-APPROVED', 'approved', 300, 0, -20);
    await credit(noted, 'N-CN-APPLIED', 'applied', 250, 100, -15);
    await credit(noted, 'N-CN-DRAFT', 'draft', 90, 0, -10);
    await credit(noted, 'N-CN-PART', 'partially_applied', 40, 10, -12);
    // Rows the list must never count for this customer: another company's
    // receipt and note carrying its id, and a supplier-type note.
    await receipt(noted, 'N-RCPT-XCO', 70, -8, f.companyB);
    await credit(noted, 'N-CN-XCO', 'approved', 60, 0, -8, { co: f.companyB });
    await credit(noted, 'N-CN-SUPPLIER', 'approved', 80, 0, -8, { type: 'supplier' });

    future = await customer('future');
    await invoice(future, 'F-INV', 800, -10);
    await invoice(future, 'F-INV-POST', 500, 5);
    await receipt(future, 'F-RCPT-POST', 200, 3);
    await credit(future, 'F-CN-POST', 'approved', 50, 0, 4);

    // Statement activity with no invoice on or before today: a deposit, and a
    // customer whose only invoice is post-dated but who has paid already.
    deposit = await customer('deposit');
    await receipt(deposit, 'D-RCPT', 500, -3);
    postOnly = await customer('postonly');
    await invoice(postOnly, 'P-INV-POST', 900, 6);
    await receipt(postOnly, 'P-RCPT', 300, -1);
    creditOnly = await customer('creditonly');
    await credit(creditOnly, 'C-CN', 'approved', 100, 0, -4);
    // An invoice carrying only customer_id (client_id NULL).
    legacy = await customer('legacy');
    await invoice(legacy, 'L-INV', 350, -7, { clientIdColumn: false });
    // An invoice in company A naming company B's customer: no statement exists.
    await invoice(f.other, 'X-INV', 999, -7);

    gone = await customer('gone');
    await invoice(gone, 'G-INV', 400, -10);
    await sql`UPDATE customers SET deleted_at = NOW() WHERE id = ${gone}::UUID`;
  }, 120000);

  afterAll(async () => { await cleanupPortalFixture(f); }, 120000);

  it('subtracts every live credit note at the statement valuation', async () => {
    // 1000 - 300 (approved, face) - 100 (applied, what it consumed) - 40 (partly
    // applied, face); the draft, the other company's rows and the supplier note do not count
    expect(await emailBalance(noted)).toBe(560);
    expect((await list()).find(r => r.client_id === noted)).toMatchObject({
      total_invoiced: 1000, total_paid: 0, total_credits: 440, balance: 560,
    });
  });

  it('leaves out post-dated documents, as the statement as at today does', async () => {
    expect(await emailBalance(future)).toBe(800);
    expect((await list()).find(r => r.client_id === future)).toMatchObject({
      total_invoiced: 800, total_paid: 0, total_credits: 0, balance: 800,
    });
  });

  it('does not list a soft-deleted customer, or another company\'s customer, who have no statement here', async () => {
    const rows = await list();
    expect(rows.length).toBeGreaterThan(0);
    expect(await fetchStatementData(f.companyA, gone, TODAY)).toBeNull();
    expect(await fetchStatementData(f.companyA, f.other, TODAY)).toBeNull();
    expect(rows.some(r => r.client_id === gone)).toBe(false);
    expect(rows.some(r => r.client_id === f.other)).toBe(false);
  });

  it('lists every customer with a statement, not only those with an invoice on or before today', async () => {
    const rows = await list();
    expect(await emailBalance(deposit)).toBe(-500);
    expect(rows.find(r => r.client_id === deposit)).toMatchObject({ total_invoiced: 0, total_paid: 500, balance: -500 });
    expect(await emailBalance(postOnly)).toBe(-300);
    expect(rows.find(r => r.client_id === postOnly)).toMatchObject({ total_invoiced: 0, total_paid: 300, balance: -300 });
    expect(await emailBalance(creditOnly)).toBe(-100);
    expect(rows.find(r => r.client_id === creditOnly)).toMatchObject({ total_invoiced: 0, total_credits: 100, balance: -100 });
    expect(await emailBalance(legacy)).toBe(350);
    expect(rows.find(r => r.client_id === legacy)).toMatchObject({ total_invoiced: 350, balance: 350 });
  });

  it('every listed balance is the balance of the statement it opens', async () => {
    const rows = await list();
    expect(rows.length).toBeGreaterThanOrEqual(8);
    for (const r of rows) {
      expect(r.balance, r.client_id).toBe(await emailBalance(r.client_id));
      expect(r.balance).toBeCloseTo(r.total_invoiced - r.total_paid - r.total_credits, 2);
    }
  });
});
