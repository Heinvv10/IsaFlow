/**
 * K-053 round 2: the surfaces that CHASE a customer or state a balance to a
 * counterparty. Aging and the subledger snapshot are covered elsewhere; these
 * four read the same two tables and had the same omission, so a soft-deleted
 * document was still emailed on a statement and still dunned.
 *
 *  - statementEmailService.fetchStatementData — the AR statement we email.
 *  - dunningService.loadInvoiceCtx — the per-invoice chase context.
 *  - supplierStatementService.fetchSupplierStatementData — the AP statement.
 *  - pages/api/accounting/smart-reminder — the overdue figure put in a reminder.
 *
 * dunningCronService carries the identical one-line predicate but is NOT driven
 * here: runDunningCron scans every company with auto_send_enabled and can send
 * mail, so exercising it against a shared fixture database is not safe.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { SignJWT } from 'jose';
import { sql } from '@/lib/neon';
import { fetchStatementData } from '@/modules/accounting/services/ar/statementEmailService';
import { loadInvoiceCtx } from '@/modules/accounting/services/ar/dunningService';
import { fetchSupplierStatementData } from '@/modules/accounting/services/ap/supplierStatementService';
import smartReminder from '../../pages/api/accounting/smart-reminder';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const COMPANY = randomUUID();
const USER = randomUUID();
const TAG = `K053CHASE-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const AS_AT = '2026-06-30';

const LIVE = 1000;
const DELETED = 750;

let customer: string;
let supplier: string;
let liveInvoice: string;
let deletedInvoice: string;
let token = '';

describeIfDb('K-053 soft-deleted documents are not chased and not stated', () => {
  beforeAll(async () => {
    assertDisposable();
    await sql`INSERT INTO companies (id, name, registration_number, created_at)
              VALUES (${COMPANY}::UUID, ${'K053C ' + TAG}, ${TAG}, NOW())`;
    await sql`INSERT INTO users (id, email, role, is_active)
              VALUES (${USER}, ${USER + '@test.local'}, 'admin', true)`;
    await sql`INSERT INTO company_users (company_id, user_id, role)
              VALUES (${COMPANY}::UUID, ${USER}, 'admin')`;

    customer = ((await sql`INSERT INTO customers (company_id, name, email)
                           VALUES (${COMPANY}::UUID, ${'K053 cust ' + TAG}, ${TAG + '@test.local'})
                           RETURNING id`) as { id: string }[])[0]!.id;
    supplier = ((await sql`INSERT INTO suppliers (company_id, name)
                           VALUES (${COMPANY}::UUID, ${'K053 supp ' + TAG})
                           RETURNING id`) as { id: string }[])[0]!.id;

    const invoices = (await sql`
      INSERT INTO customer_invoices
        (company_id, client_id, customer_id, invoice_number, invoice_date, due_date,
         status, total_amount, amount_paid, created_by, deleted_at)
      VALUES
        (${COMPANY}::UUID, ${customer}::UUID, ${customer}::UUID, ${TAG + '-AR-LIVE'}, '2026-01-15', '2026-02-15', 'overdue', ${LIVE}, 0, ${USER}::UUID, NULL),
        (${COMPANY}::UUID, ${customer}::UUID, ${customer}::UUID, ${TAG + '-AR-DEL'},  '2026-01-15', '2026-02-15', 'overdue', ${DELETED}, 0, ${USER}::UUID, NOW())
      RETURNING id, invoice_number
    `) as { id: string; invoice_number: string }[];
    liveInvoice = invoices.find((r) => r.invoice_number.endsWith('-AR-LIVE'))!.id;
    deletedInvoice = invoices.find((r) => r.invoice_number.endsWith('-AR-DEL'))!.id;

    await sql`
      INSERT INTO supplier_invoices
        (company_id, supplier_id, invoice_number, invoice_date, due_date,
         status, total_amount, amount_paid, created_by, deleted_at)
      VALUES
        (${COMPANY}::UUID, ${supplier}::UUID, ${TAG + '-AP-LIVE'}, '2026-01-15', '2026-02-15', 'approved', ${LIVE}, 0, ${USER}::UUID, NULL),
        (${COMPANY}::UUID, ${supplier}::UUID, ${TAG + '-AP-DEL'},  '2026-01-15', '2026-02-15', 'approved', ${DELETED}, 0, ${USER}::UUID, NOW())`;

    token = await new SignJWT({ sub: USER, aal: 'aal2' })
      .setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(process.env.JWT_SECRET));
  }, 60000);

  afterAll(async () => {
    await sql`DELETE FROM customer_invoices WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM supplier_invoices WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM customers WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM suppliers WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM company_users WHERE user_id = ${USER}`;
    await sql`DELETE FROM companies WHERE id = ${COMPANY}::UUID`;
    await sql`DELETE FROM users WHERE id = ${USER}`;
  }, 60000);

  it('the emailed AR statement carries the live invoice only', async () => {
    const payload = await fetchStatementData(COMPANY, customer, AS_AT);
    expect(payload).not.toBeNull();
    expect(payload!.transactions.map((t) => t.reference)).toEqual([TAG + '-AR-LIVE']);
    expect(payload!.summary.totalInvoiced).toBeCloseTo(LIVE, 2);
    expect(payload!.summary.balance).toBeCloseTo(LIVE, 2);
    // A deleted invoice is not an "excluded" row either — it is not a candidate.
    expect(payload!.excluded.map((e) => e.documentNumber)).not.toContain(TAG + '-AR-DEL');
    expect(payload!.universeTotal).toBe(1);
  });

  it('dunning has no context for a deleted invoice and still has one for the live invoice', async () => {
    expect(await loadInvoiceCtx(COMPANY, deletedInvoice)).toBeNull();
    const live = await loadInvoiceCtx(COMPANY, liveInvoice);
    expect(live).not.toBeNull();
    expect(live!.outstanding).toBeCloseTo(LIVE, 2);
  });

  it('the AP statement carries the live bill only', async () => {
    const payload = await fetchSupplierStatementData(COMPANY, supplier, AS_AT);
    expect(payload).not.toBeNull();
    expect(payload!.transactions.map((t) => t.reference)).toEqual([TAG + '-AP-LIVE']);
    expect(payload!.summary.totalInvoiced).toBeCloseTo(LIVE, 2);
    expect(payload!.summary.balance).toBeCloseTo(LIVE, 2);
  });

  it('the smart reminder quotes the live overdue balance only', async () => {
    const req = request({ 'sb-access-token': token, active_company_id: COMPANY }, 'POST');
    (req as unknown as { body: unknown }).body = { customerId: customer, reminderNumber: 1 };
    const result = response();
    await smartReminder(req, result.res);
    expect(result.state.statusCode).toBe(200);
    const data = (result.state.body as { data: { debtor: { outstanding: number; invoiceCount: number } } }).data;
    expect(data.debtor.outstanding).toBeCloseTo(LIVE, 2);
    expect(data.debtor.invoiceCount).toBe(1);
  });
});
