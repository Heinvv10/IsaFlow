/**
 * K-053 round 12 (LOW-1) — the dashboard to-do list chased soft-deleted
 * documents.
 *
 * Soft-delete sets `deleted_at` and leaves `status` alone (`softDeleteRowOps`),
 * and this route filtered on `status IN (…) AND due_date < NOW()` with no
 * `deleted_at` term, so a deleted approved invoice came back as an overdue
 * to-do for its full gross value and a deleted draft was still counted. Its
 * chase siblings — `dunningService`, `dunningCronService`, `smart-reminder` —
 * carry the undated predicate for exactly this reason.
 *
 * A guard fails in both directions, so every shape here has a live twin that
 * must still be reported: a live overdue invoice, a live overdue bill, a live
 * draft. The predicate is UNDATED because this is a workflow queue asked as at
 * NOW; it is not a balance that has to tie to a control account, so the dated
 * `documentInLedgerAsAtFragment` used by ageing and the statements would be the
 * wrong question here.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { SignJWT } from 'jose';
import { sql } from '@/lib/neon';
import todos from '../../pages/api/accounting/dashboard-todos';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const COMPANY = randomUUID();
const USER = randomUUID();
const TAG = `K053TODO-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

const LIVE = 1000;
const DELETED = 1150;

let customer: string;
let supplier: string;
let token = '';

interface Todos {
  overdueInvoices: { invoiceNumber: string; amount: number }[];
  pendingSupplierPayments: { invoiceNumber: string; amount: number }[];
  draftInvoices: number;
}

async function fetchTodos(): Promise<Todos> {
  const req = request({ 'sb-access-token': token, active_company_id: COMPANY }, 'GET');
  const result = response();
  await todos(req, result.res);
  expect(result.state.statusCode).toBe(200);
  return (result.state.body as { data: Todos }).data;
}

describeIfDb('K-053 the dashboard to-do list ignores soft-deleted documents', () => {
  beforeAll(async () => {
    assertDisposable();
    await sql`INSERT INTO companies (id, name, registration_number, created_at)
              VALUES (${COMPANY}::UUID, ${'K053TODO ' + TAG}, ${TAG}, NOW())`;
    await sql`INSERT INTO users (id, email, role, is_active)
              VALUES (${USER}, ${USER + '@test.local'}, 'admin', true)`;
    await sql`INSERT INTO company_users (company_id, user_id, role)
              VALUES (${COMPANY}::UUID, ${USER}, 'admin')`;

    customer = ((await sql`INSERT INTO customers (company_id, name)
                           VALUES (${COMPANY}::UUID, ${'cust ' + TAG}) RETURNING id`) as { id: string }[])[0]!.id;
    supplier = ((await sql`INSERT INTO suppliers (company_id, name)
                           VALUES (${COMPANY}::UUID, ${'supp ' + TAG}) RETURNING id`) as { id: string }[])[0]!.id;

    await sql`
      INSERT INTO customer_invoices
        (company_id, client_id, customer_id, invoice_number, invoice_date, due_date,
         status, total_amount, amount_paid, created_by, deleted_at)
      VALUES
        (${COMPANY}::UUID, ${customer}::UUID, ${customer}::UUID, ${TAG + '-AR-LIVE'},
         NOW() - INTERVAL '120 days', NOW() - INTERVAL '90 days', 'approved', ${LIVE}, 0, ${USER}::UUID, NULL),
        (${COMPANY}::UUID, ${customer}::UUID, ${customer}::UUID, ${TAG + '-AR-DEL'},
         NOW() - INTERVAL '120 days', NOW() - INTERVAL '90 days', 'approved', ${DELETED}, 0, ${USER}::UUID, NOW()),
        (${COMPANY}::UUID, ${customer}::UUID, ${customer}::UUID, ${TAG + '-DRAFT-LIVE'},
         NOW(), NOW() + INTERVAL '30 days', 'draft', ${LIVE}, 0, ${USER}::UUID, NULL),
        (${COMPANY}::UUID, ${customer}::UUID, ${customer}::UUID, ${TAG + '-DRAFT-DEL'},
         NOW(), NOW() + INTERVAL '30 days', 'draft', ${DELETED}, 0, ${USER}::UUID, NOW())`;

    await sql`
      INSERT INTO supplier_invoices
        (company_id, supplier_id, invoice_number, invoice_date, due_date,
         status, total_amount, amount_paid, created_by, deleted_at)
      VALUES
        (${COMPANY}::UUID, ${supplier}::UUID, ${TAG + '-AP-LIVE'},
         NOW() - INTERVAL '120 days', NOW() - INTERVAL '90 days', 'approved', ${LIVE}, 0, ${USER}::UUID, NULL),
        (${COMPANY}::UUID, ${supplier}::UUID, ${TAG + '-AP-DEL'},
         NOW() - INTERVAL '120 days', NOW() - INTERVAL '90 days', 'approved', ${DELETED}, 0, ${USER}::UUID, NOW())`;

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

  it('the premise: the deleted documents keep their status and their due date', async () => {
    const rows = (await sql`
      SELECT invoice_number, status, (deleted_at IS NOT NULL) AS deleted
      FROM customer_invoices
      WHERE company_id = ${COMPANY}::UUID AND invoice_number = ${TAG + '-AR-DEL'}
    `) as { status: string; deleted: boolean }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('approved');
    expect(rows[0]!.deleted).toBe(true);
  });

  it('lists the live overdue invoice and not the deleted one', async () => {
    const data = await fetchTodos();
    expect(data.overdueInvoices.map((i) => i.invoiceNumber)).toEqual([TAG + '-AR-LIVE']);
    expect(data.overdueInvoices[0]!.amount).toBeCloseTo(LIVE, 2);
  });

  it('lists the live overdue bill and not the deleted one', async () => {
    const data = await fetchTodos();
    expect(data.pendingSupplierPayments.map((i) => i.invoiceNumber)).toEqual([TAG + '-AP-LIVE']);
    expect(data.pendingSupplierPayments[0]!.amount).toBeCloseTo(LIVE, 2);
  });

  it('counts the live draft and not the deleted draft', async () => {
    const data = await fetchTodos();
    expect(data.draftInvoices).toBe(1);
  });
});
