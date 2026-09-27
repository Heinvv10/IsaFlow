/**
 * R-035 review LOW-2: approval rules now match customer invoices on
 * functional_total, so the draft edit must never leave it describing another
 * currency. The route already refuses a currency/rate change without items (it
 * recomputes totals only from items). The remaining lever: change currencyCode
 * WITH items but WITHOUT a rate — totals were recomputed at the OLD rate, so a
 * ZAR invoice (rate 1) re-labelled USD kept functional_total = the USD figure,
 * about an eighteenth of its rand value, under every threshold.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import customerInvoicesDetail from '../../pages/api/accounting/customer-invoices-detail';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, cleanup, createUser, newCompany } from './r035-approval.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let owner = '';

beforeAll(async () => { owner = await createUser(pool, tokens); });
afterAll(() => cleanup(pool, companies, [owner]));

const URL = '/api/accounting/customer-invoices-detail';
const put = (company: string, body: unknown) => callRoute(customerInvoicesDetail, tokens[owner]!, company, 'PUT', body, URL);
const items = [{ description: 'Consulting', quantity: 1, unitPrice: 1000 }];

async function plantDraft(): Promise<{ company: string; id: string }> {
  const company = await newCompany(pool, [[owner, 'owner']], companies);
  const customer = crypto.randomUUID();
  const id = crypto.randomUUID();
  await pool.query('INSERT INTO customers(id,company_id,name) VALUES($1,$2,$3)', [customer, company, 'r035 ci']);
  await pool.query(
    `INSERT INTO customer_invoices(id,company_id,invoice_number,customer_id,status,subtotal,tax_rate,tax_amount,
       total_amount,functional_total,currency_code,exchange_rate,created_by)
     VALUES($1,$2,$3,$4,'draft',1000,15,150,1150,1150,'ZAR',1,$5)`, [id, company, `CI-${id.slice(0, 6)}`, customer, owner]);
  return { company, id };
}
const stored = async (id: string) => (await pool.query(
  'SELECT total_amount, functional_total, currency_code, exchange_rate FROM customer_invoices WHERE id = $1', [id])).rows[0];

describe('the draft edit keeps functional_total in rand', () => {
  it('refuses a currency change that brings no exchange rate — 400, nothing written', async () => {
    const { company, id } = await plantDraft();
    const res = await put(company, { id, items, currencyCode: 'USD' });
    expect(res.state.statusCode).toBe(400);
    const row = await stored(id);
    expect(row.currency_code).toBe('ZAR');
    expect(Number(row.functional_total)).toBe(1150);
  });

  it('recomputes functional_total at the new rate when the currency changes with one', async () => {
    const { company, id } = await plantDraft();
    const res = await put(company, { id, items, currencyCode: 'USD', exchangeRate: 18.5 });
    expect(res.state.statusCode).toBe(200);
    const row = await stored(id);
    expect(row.currency_code).toBe('USD');
    expect(Number(row.functional_total)).toBe(21275);
  });

  it('still refuses a rate change without items (the existing guard)', async () => {
    const { company, id } = await plantDraft();
    expect((await put(company, { id, exchangeRate: 18.5 })).state.statusCode).toBe(400);
  });

  it('accepts re-sending the SAME currency without a rate', async () => {
    const { company, id } = await plantDraft();
    expect((await put(company, { id, items, currencyCode: 'zar' })).state.statusCode).toBe(200);
  });
});
