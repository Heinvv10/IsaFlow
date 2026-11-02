/**
 * Master plan wave 3, PR S (spec rule 10): invoice create is wallet-metered (`withFlowMeter('invoice.create')`), so
 * autosave never calls it; it calls only the draft PUT on customer-invoices-detail, which must not be metered. Through
 * the real routes, for a company on the PAYG plan:
 *
 * - control: one create debits the wallet `invoice.create`'s cost, so metering is live for this company;
 * - ten draft PUTs (each a real change, as autosave sends) leave the balance and the flow ledger as they were;
 * - a PUT on an approved invoice is a 400 that changes no row: autosave after an approval writes nothing.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import customerInvoicesCreate from '../../pages/api/accounting/customer-invoices-create';
import customerInvoicesDetail from '../../pages/api/accounting/customer-invoices-detail';
import { getFlowCost } from '@/modules/billing/services/flowOperationCatalog';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser } from './r035-approval.helpers';
import { messageOf } from './r035-pr2.helpers';
import { cleanupPr4, invoiceCompany, plantInvoice } from './r035-pr4.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let owner = '';
let company = '';
let createdPlan: string | null = null;
const COST = getFlowCost('invoice.create');
const BALANCE = 100;

const put = (body: unknown) => callRoute(customerInvoicesDetail, tokens[owner]!, company, 'PUT', body, '/api/accounting/customer-invoices-detail');
const wallet = async () => (await pool.query('SELECT balance_flows, month_flows_used FROM flow_wallet WHERE company_id = $1', [company])).rows[0];
const ledger = async () => (await pool.query(
  'SELECT type, flows, operation_code FROM flow_ledger WHERE company_id = $1 ORDER BY created_at, id', [company])).rows;
const editBody = (id: string, description: string) => ({
  id, invoiceDate: '2026-09-01', taxRate: 15, currencyCode: 'ZAR', exchangeRate: 1,
  items: [{ description, quantity: 2, unitPrice: 300, taxRate: 15, discount: 0 }],
});

beforeAll(async () => {
  owner = await createUser(pool, tokens);
  company = await invoiceCompany(pool, [[owner, 'owner']], companies);
  // getCompanyPlan meters exactly the plan coded 'payg'; another suite on this database may already have made it.
  createdPlan = (await pool.query(
    `INSERT INTO plans (code, name) VALUES ('payg', 'Autosave PAYG') ON CONFLICT (code) DO NOTHING RETURNING id`)).rows[0]?.id ?? null;
  await pool.query(`INSERT INTO subscriptions (company_id, plan_id, status) SELECT $1, id, 'active' FROM plans WHERE code = 'payg'`, [company]);
  await pool.query(`INSERT INTO flow_wallet (company_id, balance_flows) VALUES ($1, $2)
    ON CONFLICT (company_id) DO UPDATE SET balance_flows = EXCLUDED.balance_flows, month_flows_used = 0`, [company, BALANCE]);
}, 60_000);

afterAll(async () => {
  // flow_ledger refuses DELETE (append-only), and a company delete cascades into it: clear this company's rows first.
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL session_replication_role = replica');
    await c.query('DELETE FROM flow_ledger WHERE company_id = ANY($1)', [companies]);
    await c.query('COMMIT');
  } finally {
    c.release();
  }
  await pool.query('DELETE FROM flow_wallet WHERE company_id = ANY($1)', [companies]);
  await pool.query('DELETE FROM subscriptions WHERE company_id = ANY($1)', [companies]);
  if (createdPlan) await pool.query('DELETE FROM plans WHERE id = $1', [createdPlan]);
  await cleanupPr4(pool, companies, [owner]);
});

describe('autosave is not metered', () => {
  it('control: a create on this PAYG company debits invoice.create', async () => {
    const customer = crypto.randomUUID();
    await pool.query('INSERT INTO customers(id, company_id, name) VALUES($1, $2, $3)', [customer, company, 'autosave meter']);
    const res = await callRoute(customerInvoicesCreate, tokens[owner]!, company, 'POST', {
      clientId: customer, invoiceDate: '2026-09-01', items: [{ description: 'Metered', quantity: 1, unitPrice: 100 }],
    }, '/api/accounting/customer-invoices-create');
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(201);
    expect(await wallet()).toMatchObject({ balance_flows: BALANCE - COST });
    expect(await ledger()).toEqual([{ type: 'debit', flows: -COST, operation_code: 'invoice.create' }]);
  });

  it('ten draft PUTs leave the balance and the ledger as they were', async () => {
    const inv = await plantInvoice(pool, company, owner);
    const before = { wallet: await wallet(), ledger: await ledger() };
    for (let i = 1; i <= 10; i++) {
      const res = await put(editBody(inv.id, `Autosave edit ${i}`));
      expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    }
    expect(await wallet()).toEqual(before.wallet);
    expect(await ledger()).toEqual(before.ledger);
    const { rows } = await pool.query('SELECT description FROM customer_invoice_items WHERE invoice_id = $1', [inv.id]);
    expect(rows).toEqual([{ description: 'Autosave edit 10' }]); // the PUTs were real edits, not refusals
  });

  it('a PUT on an approved invoice is a 400 and changes no row', async () => {
    const inv = await plantInvoice(pool, company, owner, { status: 'approved' });
    const snapshot = async () => ({
      invoice: (await pool.query('SELECT * FROM customer_invoices WHERE id = $1', [inv.id])).rows[0],
      items: (await pool.query('SELECT * FROM customer_invoice_items WHERE invoice_id = $1 ORDER BY description', [inv.id])).rows,
    });
    const before = await snapshot();
    const res = await put(editBody(inv.id, 'Too late'));
    expect(res.state.statusCode).toBe(400);
    expect(messageOf(res)).toMatch(/Only draft invoices can be edited/);
    expect(await snapshot()).toEqual(before);
  });
});
