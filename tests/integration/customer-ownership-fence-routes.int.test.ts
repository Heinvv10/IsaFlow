// tests/integration/customer-ownership-fence-routes.int.test.ts
//
// R-067 round 3. The first two rounds enumerated seven AR document tables; the
// schema has 25 columns holding a customer id. Every write site below took that
// id from a request body with no tenant read on the path, and the column's FK
// to `customers` is tenant-agnostic, so company A could store company B's
// customer under its own company_id.
//
// Driven through the real handlers — `withAuth`, CSRF, write-access and all —
// because two properties only exist there: the refusal must be a 4xx, not a
// 500, and it must come BEFORE the first write (`withAuth` COMMITs a 4xx
// returned after one). Each case asserts by outcome: zero rows carrying B's
// customer afterwards, then the same call with A's own customer succeeds and
// writes it, because a guard has to fail in both directions.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { SignJWT } from 'jose';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { request, response } from './mfa-impersonation-postgres.helpers';
import projects from '../../pages/api/accounting/projects';
import customerActivities from '../../pages/api/accounting/customer-activities';
import customerContacts from '../../pages/api/accounting/customer-contacts';
import customerDeliveryAddresses from '../../pages/api/accounting/customer-delivery-addresses';
import writeOffs from '../../pages/api/accounting/write-offs';
import deliveryNotes from '../../pages/api/accounting/delivery-notes';
import bankRules from '../../pages/api/accounting/bank-rules';
import bankRulesAction from '../../pages/api/accounting/bank-rules-action';
import bankTransactionsAction from '../../pages/api/accounting/bank-transactions-action';
import dunningOverrides from '../../pages/api/accounting/ar/dunning/overrides/index';
import timeEntries from '../../pages/api/accounting/time-entries';
import portalPaymentLink from '../../pages/api/portal/payment-link';
import adjustments from '../../pages/api/accounting/adjustments';
import recurringExecute from '../../pages/api/accounting/recurring-transactions-execute';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL && process.env.JWT_SECRET ? describe : describe.skip;

const A = randomUUID();
const B = randomUUID();
const CUST_A = randomUUID();
const CUST_B = randomUUID();
const USER = randomUUID();
const GL = randomUUID();
const BANK_GL = randomUUID();
const INVOICE = randomUUID();
const RULE = randomUUID();
const ENTRY = randomUUID();
const BANK_TX = randomUUID();
// Recurring templates whose opaque template_data names each customer (row 8).
const TEMPLATE_A = randomUUID();
const TEMPLATE_B = randomUUID();
const TEMPLATE_BAD = randomUUID();

type Handler = (req: never, res: never) => Promise<unknown> | unknown;
interface Case {
  name: string;
  handler: Handler;
  method: string;
  body: (customerId: string) => Record<string, unknown>;
  /** Rows of company A that carry `customerId` in the fenced column. */
  carried: (customerId: string) => Promise<number>;
  refusal: number;
}

describeIfDb('R-067 r3 — every route that stores a body customer id refuses a foreign one', () => {
  let pool: Pool;
  let token = '';

  const count = async (text: string, params: unknown[]): Promise<number> =>
    Number((await pool.query(text, params)).rows[0].n);
  const inA = (table: string, column: string) => (customerId: string) =>
    count(`SELECT count(*) AS n FROM ${table} WHERE company_id = $1 AND ${column} = $2`, [A, customerId]);
  const onRow = (table: string, column: string, id: string) => (customerId: string) =>
    count(`SELECT count(*) AS n FROM ${table} WHERE company_id = $1 AND id = $2 AND ${column} = $3`,
      [A, id, customerId]);

  async function call(handler: Handler, method: string, body: Record<string, unknown>) {
    const req = request({ 'sb-access-token': token, active_company_id: A }, method) as never as
      { body: unknown; query: Record<string, string>; url: string };
    req.body = body;
    req.query = {};
    req.url = '/api/accounting/r067-fence-fixture';
    const out = response();
    await handler(req as never, out.res as never);
    return out.state;
  }

  const CASES: Case[] = [
    { name: 'projects POST', handler: projects, method: 'POST', refusal: 400,
      body: (c) => ({ name: 'Fence project', clientId: c }), carried: (c) => inA('projects', 'client_id')(c) },
    { name: 'customer-activities POST', handler: customerActivities, method: 'POST', refusal: 400,
      body: (c) => ({ customerId: c, activity_type: 'note', description: 'Fence note' }),
      carried: (c) => inA('customer_activities', 'customer_id')(c) },
    { name: 'customer-contacts POST (primary — clears the old primary first)', handler: customerContacts,
      method: 'POST', refusal: 400,
      body: (c) => ({ customerId: c, fullName: 'Fence Contact', isPrimary: true }),
      carried: (c) => inA('customer_contacts', 'customer_id')(c) },
    { name: 'customer-delivery-addresses POST (default — clears the old default first)',
      handler: customerDeliveryAddresses, method: 'POST', refusal: 400,
      body: (c) => ({ customerId: c, addressName: 'Fence HQ', isDefault: true }),
      carried: (c) => inA('customer_delivery_addresses', 'customer_id')(c) },
    { name: 'write-offs POST', handler: writeOffs, method: 'POST', refusal: 400,
      body: (c) => ({ invoiceId: INVOICE, clientId: c, amount: 10, reason: 'Fence' }),
      carried: (c) => inA('customer_write_offs', 'client_id')(c) },
    { name: 'delivery-notes POST', handler: deliveryNotes, method: 'POST', refusal: 400,
      body: (c) => ({ customer_id: c, lines: [{ description: 'Fence item', quantity: 1 }] }),
      carried: (c) => inA('delivery_notes', 'customer_id')(c) },
    { name: 'bank-rules POST', handler: bankRules, method: 'POST', refusal: 400,
      body: (c) => ({ ruleName: 'Fence rule', matchField: 'description', matchType: 'contains',
        matchPattern: 'FENCE-R3', clientId: c }),
      carried: (c) => inA('bank_categorisation_rules', 'client_id')(c) },
    { name: 'dunning overrides POST', handler: dunningOverrides, method: 'POST', refusal: 404,
      body: (c) => ({ customerId: c, suppress_dunning: true }),
      carried: (c) => inA('customer_dunning_overrides', 'customer_id')(c) },
    { name: 'time-entries POST', handler: timeEntries, method: 'POST', refusal: 400,
      body: (c) => ({ taskDescription: 'Fence work', hours: 1, customerId: c }),
      carried: (c) => count(
        `SELECT count(*) AS n FROM time_entries WHERE company_id = $1 AND customer_id = $2 AND id <> $3`,
        [A, c, ENTRY]) },
    { name: 'portal payment-link POST', handler: portalPaymentLink, method: 'POST', refusal: 400,
      body: (c) => ({ invoiceId: INVOICE, clientId: c, amount: 10 }),
      carried: (c) => count(
        'SELECT count(*) AS n FROM portal_payment_links WHERE invoice_id = $1 AND client_id = $2', [INVOICE, c]) },
    { name: 'adjustments POST (customer)', handler: adjustments, method: 'POST', refusal: 400,
      body: (c) => ({ entityType: 'customer', entityId: c, adjustmentType: 'debit', amount: 50, reason: 'Fence' }),
      carried: (c) => count(
        "SELECT count(*) AS n FROM accounting_adjustments WHERE company_id = $1 AND entity_type = 'customer' AND entity_id = $2",
        [A, c]) },
    { name: 'recurring-transactions-execute POST (template naming the customer)', handler: recurringExecute,
      method: 'POST', refusal: 400,
      body: (c) => ({ templateId: c === CUST_A ? TEMPLATE_A : TEMPLATE_B }),
      carried: (c) => count(
        'SELECT count(*) AS n FROM customer_invoices WHERE company_id = $1 AND client_id = $2 AND id <> $3',
        [A, c, INVOICE]) },
    // Update arms: the row already belongs to A; the body re-points its customer.
    { name: 'bank-rules-action update', handler: bankRulesAction, method: 'POST', refusal: 400,
      body: (c) => ({ action: 'update', id: RULE, clientId: c }),
      carried: (c) => onRow('bank_categorisation_rules', 'client_id', RULE)(c) },
    { name: 'time-entries PUT', handler: timeEntries, method: 'PUT', refusal: 400,
      body: (c) => ({ id: ENTRY, customerId: c }),
      carried: (c) => onRow('time_entries', 'customer_id', ENTRY)(c) },
    { name: 'bank-transactions-action save_selection', handler: bankTransactionsAction, method: 'POST',
      refusal: 400,
      body: (c) => ({ action: 'save_selection', bankTransactionId: BANK_TX, selectionType: 'customer',
        selectionEntityId: c }),
      carried: (c) => onRow('bank_transactions', 'suggested_client_id', BANK_TX)(c) },
  ];

  beforeAll(async () => {
    assertNotProductionDb('This test inserts and deletes customer fixtures for two throwaway companies.');
    pool = new Pool({ connectionString: DATABASE_URL, max: 2 });
    await pool.query('INSERT INTO companies (id, name, is_active) VALUES ($1, $2, true), ($3, $4, true)',
      [A, 'R067 r3 Co A', B, 'R067 r3 Co B']);
    await pool.query("INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'admin', true)",
      [USER, `r067r3-${USER}@isaflow.test`]);
    await pool.query("INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, 'admin')", [A, USER]);
    await pool.query('INSERT INTO customers (id, company_id, name) VALUES ($1, $2, $3), ($4, $5, $6)',
      [CUST_A, A, 'R3 Customer A', CUST_B, B, 'R3 Customer B']);
    for (const [id, code, name, type, subtype, normal] of [
      [GL, '6100', 'R3 Expense', 'expense', 'default_expense', 'debit'],
      [BANK_GL, '1000', 'R3 Bank', 'asset', 'bank', 'debit'],
    ] as const) {
      await pool.query(
        `INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type, account_subtype,
           normal_balance, is_active, is_system_account) VALUES ($1, $2, $3, $4, $5, $6, $7, true, false)`,
        [id, A, code, name, type, subtype, normal]);
    }
    await pool.query(
      `INSERT INTO customer_invoices (id, company_id, invoice_number, customer_id, client_id, invoice_date,
         subtotal, tax_amount, total_amount, amount_paid, status, created_by)
       VALUES ($1, $2, 'INV-R3-1', $3, $3, CURRENT_DATE, 100, 15, 115, 0, 'approved', $4)`,
      [INVOICE, A, CUST_A, USER]);
    await pool.query(
      `INSERT INTO bank_categorisation_rules (id, company_id, rule_name, match_field, match_type,
         match_pattern, gl_account_id, created_by)
       VALUES ($1, $2, 'R3 seeded rule', 'description', 'contains', 'R3-SEED', $3, $4)`,
      [RULE, A, GL, USER]);
    await pool.query(
      `INSERT INTO time_entries (id, company_id, user_id, task_description, hours, status, entry_date)
       VALUES ($1, $2, $3, 'R3 seeded entry', 1, 'draft', CURRENT_DATE)`, [ENTRY, A, USER]);
    await pool.query(
      `INSERT INTO bank_transactions (id, company_id, bank_account_id, transaction_date, amount, description, status)
       VALUES ($1, $2, $3, CURRENT_DATE, 115, 'R3 receipt', 'imported')`, [BANK_TX, A, BANK_GL]);
    for (const [id, clientId] of [[TEMPLATE_A, CUST_A], [TEMPLATE_B, CUST_B], [TEMPLATE_BAD, 'not-a-uuid']]) {
      await pool.query(
        `INSERT INTO recurring_transaction_templates (id, company_id, name, entity_type, template_data, frequency,
           next_run_date, created_by)
         VALUES ($1, $2, 'R3 template', 'customer_invoice', $3::jsonb, 'monthly', CURRENT_DATE, $4)`,
        [id, A, JSON.stringify({ clientId, subtotal: 100, vatAmount: 15, totalAmount: 115 }), USER]);
    }
    token = await new SignJWT({ sub: USER, aal: 'aal2' })
      .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h')
      .sign(new TextEncoder().encode(process.env.JWT_SECRET));
  });

  afterAll(async () => {
    if (!pool) return;
    try {
      await pool.query('DELETE FROM portal_payment_links WHERE invoice_id = $1', [INVOICE]);
      await pool.query(
        'DELETE FROM delivery_note_lines WHERE delivery_note_id IN (SELECT id FROM delivery_notes WHERE company_id = ANY($1::uuid[]))',
        [[A, B]]);
      for (const t of ['recurring_transaction_templates', 'accounting_adjustments', 'delivery_notes', 'customer_write_offs', 'customer_dunning_overrides', 'customer_activities',
        'customer_contacts', 'customer_delivery_addresses', 'projects', 'time_entries', 'bank_transactions',
        'bank_categorisation_rules', 'customer_invoices', 'company_document_numbers', 'gl_accounts',
        'company_users', 'customers']) {
        await pool.query(`DELETE FROM ${t} WHERE company_id = ANY($1::uuid[])`, [[A, B]]);
      }
      await pool.query('DELETE FROM companies WHERE id = ANY($1::uuid[])', [[A, B]]);
      await pool.query('DELETE FROM users WHERE id = $1', [USER]);
    } finally {
      await pool.end();
    }
  });

  it.each(CASES)('$name refuses company B\'s customer and stores nothing', async (c) => {
    const state = await call(c.handler, c.method, c.body(CUST_B));
    expect(state.statusCode).toBe(c.refusal);
    expect(await c.carried(CUST_B)).toBe(0);
  });

  it.each(CASES)('$name still stores company A\'s own customer', async (c) => {
    const state = await call(c.handler, c.method, c.body(CUST_A));
    expect(state.statusCode, JSON.stringify(state.body)).toBeLessThan(300);
    expect(await c.carried(CUST_A)).toBe(1);
  });

  it('recurring execute answers 400 for a template whose clientId is not a UUID, and writes nothing', async () => {
    const before = await count('SELECT count(*) AS n FROM customer_invoices WHERE company_id = $1', [A]);
    const state = await call(recurringExecute, 'POST', { templateId: TEMPLATE_BAD });
    expect(state.statusCode).toBe(400);
    expect(await count('SELECT count(*) AS n FROM customer_invoices WHERE company_id = $1', [A])).toBe(before);
    expect(await count(
      'SELECT count(*) AS n FROM recurring_transaction_templates WHERE id = $1 AND next_run_date = CURRENT_DATE',
      [TEMPLATE_BAD])).toBe(1);
  });

  it('the refused delivery note burnt no document number', async () => {
    // Compared before/after the refusal itself, not against a fixed value: an
    // invoice minted earlier in the run seeds every default counter row
    // (ensureDocumentNumbers), so the absolute next_number depends on test order.
    const counter = async () => (await pool.query(
      "SELECT next_number FROM company_document_numbers WHERE company_id = $1 AND document_type = 'delivery_note'",
      [A])).rows.map((r) => Number(r.next_number));
    const before = await counter();
    const state = await call(deliveryNotes, 'POST',
      { customer_id: CUST_B, lines: [{ description: 'Fence item', quantity: 1 }] });
    expect(await counter()).toEqual(before);
    expect(state.statusCode).toBe(400);
  });
});
