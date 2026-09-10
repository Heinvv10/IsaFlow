/**
 * K-053 adjacent cases. The summary aging services are covered by
 * k053-aging-includes-soft-deleted.int.test.ts; the surfaces below share the
 * same omission and are what a user actually drills into.
 *
 *  - getARAgingDetail / getAPAgingDetail: the drill-down must agree with the
 *    summary it drills into, or the deleted document reappears one click down.
 *  - reports-supplier-ledger: the supplier NAME lookup filters deleted_at but
 *    the invoice leg did not, so a deleted bill stayed in the statement and in
 *    its running balance. Driven through the real route, not the SQL.
 *  - A second company proves the filter is not a tenant-wide predicate change.
 *  - A live invoice must still age — the filter must not remove everything.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { SignJWT } from 'jose';
import { sql } from '@/lib/neon';
import { getARAgingDetail } from '@/modules/accounting/services/ar/arAgingService';
import { getAPAgingDetail, getAPAging } from '@/modules/accounting/services/ap/apAgingService';
import supplierLedger from '../../pages/api/accounting/reports-supplier-ledger';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const COMPANY_A = randomUUID();
const COMPANY_B = randomUUID();
const USER = randomUUID();
const TAG = `K053ADJ-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const AS_AT = '2026-06-30';

const LIVE = 1000;
const DELETED = 750;
const OTHER_TENANT = 400;

let customerA: string;
let supplierA: string;
let supplierB: string;
let token = '';

describeIfDb('K-053 soft-deleted documents stay out of the drill-downs and the supplier ledger', () => {
  beforeAll(async () => {
    assertDisposable();
    await sql`INSERT INTO companies (id, name, registration_number, created_at)
              VALUES (${COMPANY_A}::UUID, ${'K053A ' + TAG}, ${TAG + '-A'}, NOW()),
                     (${COMPANY_B}::UUID, ${'K053B ' + TAG}, ${TAG + '-B'}, NOW())`;
    await sql`INSERT INTO users (id, email, role, is_active)
              VALUES (${USER}, ${USER + '@test.local'}, 'viewer', true)`;
    await sql`INSERT INTO company_users (company_id, user_id, role)
              VALUES (${COMPANY_A}::UUID, ${USER}, 'admin')`;

    customerA = ((await sql`INSERT INTO customers (company_id, name) VALUES (${COMPANY_A}::UUID, ${'K053 cust ' + TAG}) RETURNING id`) as { id: string }[])[0]!.id;
    supplierA = ((await sql`INSERT INTO suppliers (company_id, name) VALUES (${COMPANY_A}::UUID, ${'K053 supp ' + TAG}) RETURNING id`) as { id: string }[])[0]!.id;
    supplierB = ((await sql`INSERT INTO suppliers (company_id, name) VALUES (${COMPANY_B}::UUID, ${'K053 suppB ' + TAG}) RETURNING id`) as { id: string }[])[0]!.id;

    await sql`
      INSERT INTO customer_invoices
        (company_id, client_id, customer_id, invoice_number, invoice_date, due_date,
         status, total_amount, amount_paid, created_by, deleted_at)
      VALUES
        (${COMPANY_A}::UUID, ${customerA}::UUID, ${customerA}::UUID, ${TAG + '-AR-LIVE'}, '2026-01-15', '2026-02-15', 'approved', ${LIVE}, 0, ${USER}::UUID, NULL),
        (${COMPANY_A}::UUID, ${customerA}::UUID, ${customerA}::UUID, ${TAG + '-AR-DEL'},  '2026-01-15', '2026-02-15', 'approved', ${DELETED}, 0, ${USER}::UUID, NOW())`;

    await sql`
      INSERT INTO supplier_invoices
        (company_id, supplier_id, invoice_number, invoice_date, due_date,
         status, total_amount, amount_paid, created_by, deleted_at)
      VALUES
        (${COMPANY_A}::UUID, ${supplierA}::UUID, ${TAG + '-AP-LIVE'}, '2026-01-15', '2026-02-15', 'approved', ${LIVE}, 0, ${USER}::UUID, NULL),
        (${COMPANY_A}::UUID, ${supplierA}::UUID, ${TAG + '-AP-DEL'},  '2026-01-15', '2026-02-15', 'approved', ${DELETED}, 0, ${USER}::UUID, NOW()),
        (${COMPANY_B}::UUID, ${supplierB}::UUID, ${TAG + '-AP-B'},    '2026-01-15', '2026-02-15', 'approved', ${OTHER_TENANT}, 0, ${USER}::UUID, NULL)`;

    token = await new SignJWT({ sub: USER, aal: 'aal2' })
      .setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(process.env.JWT_SECRET));
  }, 60000);

  afterAll(async () => {
    await sql`DELETE FROM customer_invoices WHERE company_id IN (${COMPANY_A}::UUID, ${COMPANY_B}::UUID)`;
    await sql`DELETE FROM supplier_invoices WHERE company_id IN (${COMPANY_A}::UUID, ${COMPANY_B}::UUID)`;
    await sql`DELETE FROM customers WHERE company_id IN (${COMPANY_A}::UUID, ${COMPANY_B}::UUID)`;
    await sql`DELETE FROM suppliers WHERE company_id IN (${COMPANY_A}::UUID, ${COMPANY_B}::UUID)`;
    await sql`DELETE FROM company_users WHERE user_id = ${USER}`;
    await sql`DELETE FROM companies WHERE id IN (${COMPANY_A}::UUID, ${COMPANY_B}::UUID)`;
    await sql`DELETE FROM users WHERE id = ${USER}`;
  }, 60000);

  it('AR aging detail lists the live invoice and not the deleted one', async () => {
    const detail = await getARAgingDetail(COMPANY_A, customerA, AS_AT);
    expect(detail.invoices.map((i) => i.balance)).toEqual([LIVE]);
    expect(detail.buckets!.total).toBeCloseTo(LIVE, 2);
  });

  it('AP aging detail lists the live bill and not the deleted one', async () => {
    const detail = await getAPAgingDetail(COMPANY_A, supplierA, AS_AT);
    expect(detail.invoices.map((i) => i.balance)).toEqual([LIVE]);
    expect(detail.buckets!.total).toBeCloseTo(LIVE, 2);
  });

  it('the supplier ledger omits the deleted bill from its rows and its closing balance', async () => {
    const req = request({ 'sb-access-token': token, active_company_id: COMPANY_A }, 'GET');
    req.query = { supplierId: supplierA };
    const result = response();
    await supplierLedger(req, result.res);
    expect(result.state.statusCode).toBe(200);
    const data = (result.state.body as { data: { transactions: { reference: string }[]; closing_balance: number } }).data;
    expect(data.transactions.map((t) => t.reference)).toEqual([TAG + '-AP-LIVE']);
    expect(data.closing_balance).toBeCloseTo(LIVE, 2);
  });

  it('a second company keeps its own live bill and sees nothing of company A', async () => {
    const buckets = await getAPAging(COMPANY_B, AS_AT);
    expect(buckets.map((b) => b.entityId)).toEqual([supplierB]);
    expect(buckets[0]!.total).toBeCloseTo(OTHER_TENANT, 2);
  });
});
