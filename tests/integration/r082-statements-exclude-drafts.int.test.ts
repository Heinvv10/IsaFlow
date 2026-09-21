/**
 * R-082 — customer and supplier statements exclude drafts.
 *
 * Hein decided 2026-09-11: statements must not show draft invoices/bills, and
 * (per R-059's shared rule) must agree with the ageing on a null status. R-059
 * round 6 built `shared/documentPopulation.documentInPopulationExpr(alias)` and
 * deliberately left every statement surface UNROUTED — the customer statement is
 * emailed, so routing it changes what a customer receives, which needed Hein's
 * decision, not a refactor's. That decision is now made; this file routes and
 * pins six surfaces: the customer statement (screen + PDF), customer statement
 * detail, the customer statements balance list, the statement EMAIL body
 * (statementEmailService, what customer-statements-send and
 * statement-bulk-email both call), and the supplier statement
 * (supplierStatementService, what the MCP `inventoryAndAp` tool calls).
 *
 * portalService.getClientStatement's status predicate is routed too (same
 * comment, same shared rule) because it is a genuine customer-statement
 * surface (/api/portal/statement), but it is NOT exercised here: that
 * function's SELECT list references columns that do not exist on
 * customer_invoices/customer_payments (`total`, `reference`) and filters
 * payments on a `status` value ('posted') the column's own CHECK constraint
 * forbids — the route 500s on every call today, a pre-existing defect
 * unrelated to R-082. Fixing it is out of this PR's surgical scope; noted in
 * fix.md as a new finding.
 *
 * Each surface gets the same documents: an APPROVED (issued) one, a DRAFT one
 * (must never appear — this is the fix), a NULL-status one (must still
 * appear, per the shared rule's NULL convention — the surface these routes
 * already used, `!= 'cancelled'` / `NOT IN ('draft','cancelled')`, silently
 * dropped a NULL-status row via SQL's three-valued logic; routing through the
 * shared helper is what admits it), and a CANCELLED one (stays out, unchanged
 * behaviour). Round 3 adds a PENDING_APPROVAL one (Hein's round-2 decision:
 * excluded everywhere, same as draft) and, on the two surfaces that classify
 * rather than filter (statementEmailService, and both MCP tools —
 * R-082 round 2 / round 3 MEDIUM), asserts it shows up in `excludedRows`
 * with reason `invoice_pending_approval`, never silently.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { SignJWT } from 'jose';
import { sql } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

const COMPANY = randomUUID();
const USER = randomUUID();
const TAG = `R82${Math.floor(Math.random() * 1e8)}`;

function shift(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return fmtDate(d);
}
const TODAY = fmtDate(new Date());

let customerId = '';
let supplierId = '';
let token = '';

describeIfDb('R-082 statements exclude drafts', () => {
  beforeAll(async () => {
    assertDisposable();
    await sql`INSERT INTO companies (id, name, registration_number) VALUES (${COMPANY}::UUID, ${'R082 ' + TAG}, ${TAG})`;
    await sql`INSERT INTO users (id, email, role, is_active) VALUES (${USER}, ${USER + '@test.local'}, 'admin', true)`;
    await sql`INSERT INTO company_users (company_id, user_id, role) VALUES (${COMPANY}::UUID, ${USER}, 'admin')`;

    customerId = ((await sql`
      INSERT INTO customers (company_id, name, email) VALUES (${COMPANY}::UUID, ${'cust ' + TAG}, ${'cust-' + TAG + '@test.local'})
      RETURNING id`) as { id: string }[])[0]!.id;
    supplierId = ((await sql`
      INSERT INTO suppliers (company_id, name, email) VALUES (${COMPANY}::UUID, ${'supp ' + TAG}, ${'supp-' + TAG + '@test.local'})
      RETURNING id`) as { id: string }[])[0]!.id;

    // Customer invoices: A (approved, issued), D (draft — must never appear),
    // N (NULL status — must still appear), C (cancelled — stays out, unchanged),
    // P (pending_approval — must never appear, round-3 addition).
    for (const [suffix, status, amount] of [
      ['A', 'approved', 1000], ['D', 'draft', 500], ['N', null, 200], ['C', 'cancelled', 900],
      ['P', 'pending_approval', 333],
    ] as const) {
      await sql`
        INSERT INTO customer_invoices (company_id, client_id, customer_id, invoice_number, invoice_date, due_date,
          status, subtotal, tax_amount, total_amount, amount_paid, created_by)
        VALUES (${COMPANY}::UUID, ${customerId}::UUID, ${customerId}::UUID, ${TAG + '-' + suffix}, ${shift(-30)}::date, ${shift(-15)}::date,
          ${status}, ${amount}, 0, ${amount}, 0, ${USER}::UUID)`;
    }

    // Supplier bills: same shape, mirrored.
    for (const [suffix, status, amount] of [
      ['A', 'approved', 700], ['D', 'draft', 400], ['N', null, 150], ['C', 'cancelled', 600],
      ['P', 'pending_approval', 222],
    ] as const) {
      await sql`
        INSERT INTO supplier_invoices (company_id, supplier_id, invoice_number, invoice_date, due_date,
          status, subtotal, tax_amount, total_amount, amount_paid, created_by)
        VALUES (${COMPANY}::UUID, ${supplierId}::UUID, ${TAG + '-' + suffix}, ${shift(-30)}::date, ${shift(-15)}::date,
          ${status}, ${amount}, 0, ${amount}, 0, ${USER}::UUID)`;
    }

    token = await new SignJWT({ sub: USER, aal: 'aal2' })
      .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h')
      .sign(new TextEncoder().encode(process.env.JWT_SECRET));
  }, 120000);

  afterAll(async () => {
    await sql`DELETE FROM customer_invoices WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM supplier_invoices WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM customers WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM suppliers WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM company_users WHERE user_id = ${USER}`;
    await sql`DELETE FROM companies WHERE id = ${COMPANY}::UUID`;
    await sql`DELETE FROM users WHERE id = ${USER}`;
  }, 120000);

  it('premise: A approved, D draft, N null status, C cancelled, P pending_approval', async () => {
    const rows = (await sql`
      SELECT invoice_number, status FROM customer_invoices
      WHERE company_id = ${COMPANY}::UUID ORDER BY invoice_number
    `) as { invoice_number: string; status: string | null }[];
    expect(rows.map(r => [r.invoice_number, r.status])).toEqual([
      [TAG + '-A', 'approved'], [TAG + '-C', 'cancelled'], [TAG + '-D', 'draft'], [TAG + '-N', null],
      [TAG + '-P', 'pending_approval'],
    ]);
  });

  it('customer-statement route: A and N appear, D and C do not, total 1200', async () => {
    const { default: route } = await import('../../pages/api/accounting/customer-statement');
    const req = request({ 'sb-access-token': token, active_company_id: COMPANY }, 'GET');
    (req as unknown as { query: unknown }).query = { customerId, fromDate: shift(-365), toDate: TODAY };
    const result = response();
    await (route as unknown as (a: unknown, b: unknown) => Promise<void>)(req, result.res);
    expect(result.state.statusCode).toBe(200);
    const body = (result.state.body as { data: { transactions: { reference: string }[]; summary: { totalInvoiced: number } } }).data;
    expect(body.transactions.filter(t => t.reference.endsWith('-A') || t.reference.endsWith('-D') || t.reference.endsWith('-N') || t.reference.endsWith('-C') || t.reference.endsWith('-P')).map(t => t.reference).sort())
      .toEqual([TAG + '-A', TAG + '-N']);
    expect(body.summary.totalInvoiced).toBe(1200);
  });

  it('customer-statement-detail route: A and N appear, D and C do not, total 1200', async () => {
    const { default: route } = await import('../../pages/api/accounting/customer-statement-detail');
    const req = request({ 'sb-access-token': token, active_company_id: COMPANY }, 'GET');
    (req as unknown as { query: unknown }).query = { client_id: customerId };
    const result = response();
    await (route as unknown as (a: unknown, b: unknown) => Promise<void>)(req, result.res);
    expect(result.state.statusCode).toBe(200);
    const body = (result.state.body as { data: { transactions: { reference: string }[]; summary: { totalInvoiced: number } } }).data;
    expect(body.transactions.filter(t => t.reference.endsWith('-A') || t.reference.endsWith('-D') || t.reference.endsWith('-N') || t.reference.endsWith('-C') || t.reference.endsWith('-P')).map(t => t.reference).sort())
      .toEqual([TAG + '-A', TAG + '-N']);
    expect(body.summary.totalInvoiced).toBe(1200);
  });

  it('customer-statements route: this customer\'s balance list shows 1200, not 1700', async () => {
    const { default: route } = await import('../../pages/api/accounting/customer-statements');
    const req = request({ 'sb-access-token': token, active_company_id: COMPANY }, 'GET');
    (req as unknown as { query: unknown }).query = {};
    const result = response();
    await (route as unknown as (a: unknown, b: unknown) => Promise<void>)(req, result.res);
    expect(result.state.statusCode).toBe(200);
    const body = (result.state.body as { data: { customers: { client_id: string; total_invoiced: number }[] } }).data;
    const row = body.customers.find(c => c.client_id === customerId);
    expect(row?.total_invoiced).toBe(1200);
  });

  it('statementEmailService.fetchStatementData: A and N appear, D and C do not, total 1200, P in excludedRows', async () => {
    const { fetchStatementData } = await import('../../src/modules/accounting/services/ar/statementEmailService');
    const data = await fetchStatementData(COMPANY, customerId, TODAY);
    expect(data).not.toBeNull();
    const refs = data!.transactions.filter(t => t.type === 'invoice').map(t => t.reference).sort();
    expect(refs).toEqual([TAG + '-A', TAG + '-N']);
    expect(data!.summary.totalInvoiced).toBe(1200);
    // Round 3: a pending-approval invoice is absent from the statement but
    // MUST be named in excludedRows, with its own reason and amount — not
    // dropped in silence the way the SQL-filtered routes drop it.
    const pa = data!.excluded.find(e => e.documentNumber === TAG + '-P');
    expect(pa).toMatchObject({ reason: 'invoice_pending_approval', amount: 333 });
    expect(pa?.detail).toContain('pending_approval');
    // Round 3 (LOW): the cancelled invoice's OWN detail must say it was
    // issued and voided, not "not yet issued" — that phrase is only true
    // for draft and pending-approval.
    const cancelled = data!.excluded.find(e => e.documentNumber === TAG + '-C');
    expect(cancelled?.detail).toContain('voided');
    expect(cancelled?.detail).not.toContain('not yet issued');
  });

  it('sendStatementEmail: the emailed HTML carries A and N, never D or P', async () => {
    vi.resetModules();
    vi.doMock('@/modules/accounting/services/core/emailService', () => ({
      sendEmail: vi.fn().mockResolvedValue({ success: true, messageId: 'r082-test' }),
    }));
    const emailMod = await import('@/modules/accounting/services/core/emailService');
    const { sendStatementEmail } = await import('../../src/modules/accounting/services/ar/statementEmailService');
    const result = await sendStatementEmail(COMPANY, customerId, TODAY, 'R082 Co');
    expect(result.success).toBe(true);
    const call = (emailMod.sendEmail as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { html: string };
    expect(call.html).toContain(TAG + '-A');
    expect(call.html).toContain(TAG + '-N');
    expect(call.html).not.toContain(TAG + '-D');
    expect(call.html).not.toContain(TAG + '-P');
    vi.doUnmock('@/modules/accounting/services/core/emailService');
    vi.resetModules();
  });

  it('supplierStatementService.fetchSupplierStatementData: A and N appear, D and C do not, total 850, P in excludedRows', async () => {
    const { fetchSupplierStatementData } = await import('../../src/modules/accounting/services/ap/supplierStatementService');
    const data = await fetchSupplierStatementData(COMPANY, supplierId, TODAY);
    expect(data).not.toBeNull();
    const refs = data!.transactions.filter(t => t.type === 'invoice').map(t => t.reference).sort();
    expect(refs).toEqual([TAG + '-A', TAG + '-N']);
    expect(data!.summary.totalInvoiced).toBe(850);
    const pa = data!.excluded.find(e => e.documentNumber === TAG + '-P');
    expect(pa).toMatchObject({ reason: 'invoice_pending_approval', amount: 222 });
    const cancelled = data!.excluded.find(e => e.documentNumber === TAG + '-C');
    expect(cancelled?.detail).toContain('voided');
    expect(cancelled?.detail).not.toContain('not yet issued');
  });

  it('MCP customer_statement tool: excludedRows names P (pending_approval), rows carry only A and N', async () => {
    const { customerStatementTool } = await import('../../src/lib/mcp/tools/domainReports');
    const ctx = { userId: USER, companyId: COMPANY, scopes: ['read:reports'], tokenJti: 't', oauthAppId: null };
    const result = await customerStatementTool.handler({ customer_id: customerId, as_at: TODAY }, ctx);
    const env = JSON.parse(result.content[0]!.text) as {
      rows: { type: string; reference: string }[];
      excludedRows: { documentNumber: string; reason: string; amount: number }[];
    };
    const invoiceRefs = env.rows.filter(r => r.type === 'invoice').map(r => r.reference).sort();
    expect(invoiceRefs).toEqual([TAG + '-A', TAG + '-N']);
    const pa = env.excludedRows.find(e => e.documentNumber === TAG + '-P');
    expect(pa).toMatchObject({ reason: 'invoice_pending_approval', amount: 333 });
  });

  it('MCP supplier_statement tool: excludedRows names P (pending_approval), rows carry only A and N', async () => {
    const { supplierStatementTool } = await import('../../src/lib/mcp/tools/inventoryAndAp');
    const ctx = { userId: USER, companyId: COMPANY, scopes: ['read:reports'], tokenJti: 't', oauthAppId: null };
    const result = await supplierStatementTool.handler({ supplier_id: supplierId, as_at: TODAY }, ctx);
    const env = JSON.parse(result.content[0]!.text) as {
      rows: { type: string; reference: string }[];
      excludedRows: { documentNumber: string; reason: string; amount: number }[];
    };
    const invoiceRefs = env.rows.filter(r => r.type === 'invoice').map(r => r.reference).sort();
    expect(invoiceRefs).toEqual([TAG + '-A', TAG + '-N']);
    const pa = env.excludedRows.find(e => e.documentNumber === TAG + '-P');
    expect(pa).toMatchObject({ reason: 'invoice_pending_approval', amount: 222 });
  });
});
