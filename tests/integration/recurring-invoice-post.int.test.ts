/**
 * Recurring-invoice POST validation, against real Postgres.
 *
 *  - tax_rate is NUMERIC(5,2): a rate with more than 2 decimals is refused, so the
 *    stored header and the stored rate agree (the run refuses a template where they don't).
 *  - nextRunDate / endDate must be real YYYY-MM-DD dates and the End Date may not
 *    precede the next run. POST used to accept anything the SQL cast took, which
 *    is where legacy rows with End Date < next run came from.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import recurringInvoices from '../../pages/api/accounting/recurring-invoices';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser, newCompany } from './r035-approval.helpers';
import { cleanupPr4 } from './r035-pr4.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let user = '';

beforeAll(async () => { user = await createUser(pool, tokens); });
afterAll(() => cleanupPr4(pool, companies, [user]));

async function fixture(): Promise<{ c: string; customer: string }> {
  const c = await newCompany(pool, [[user, 'admin']], companies);
  const customer = crypto.randomUUID();
  await pool.query("INSERT INTO customers(id,company_id,name) VALUES($1,$2,'POST fixture')", [customer, c]);
  return { c, customer };
}

describe('POST recurring-invoices: tax rate and date validation', () => {
  const post = (c: string, customer: string, taxRate: unknown) => callRoute(recurringInvoices, tokens[user]!, c, 'POST', {
    templateName: 'POST scale', clientId: customer, frequency: 'monthly', nextRunDate: '2031-01-01', taxRate,
    lineItems: [{ description: 'Big', quantity: 1, unitPrice: 10000 }],
  }, '/api/accounting/recurring-invoices');
  const postDates = (c: string, customer: string, dates: Record<string, unknown>) => callRoute(recurringInvoices, tokens[user]!, c, 'POST', {
    templateName: 'POST dates', clientId: customer, frequency: 'monthly', ...dates,
    lineItems: [{ description: 'Big', quantity: 1, unitPrice: 100 }],
  }, '/api/accounting/recurring-invoices');
  const count = async (c: string) => Number((await pool.query(
    'SELECT count(*) AS n FROM recurring_invoices WHERE company_id = $1', [c])).rows[0].n);

  it('refuses a rate with more than 2 decimals and creates nothing', async () => {
    const { c, customer } = await fixture();
    const res = await post(c, customer, 7.555);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(400);
    expect(JSON.stringify(res.state.body)).toMatch(/2 decimal/);
    expect(await count(c)).toBe(0);
  });

  it('stores a 2-decimal rate and a header that agrees with it', async () => {
    const { c, customer } = await fixture();
    const res = await post(c, customer, 7.55);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    const r = (await pool.query('SELECT tax_rate::float AS r, tax_amount::float AS t FROM recurring_invoices WHERE company_id = $1', [c])).rows[0];
    expect(r).toEqual({ r: 7.55, t: 755 });
  });
  it.each([
    ['an End Date before the next run date', { nextRunDate: '2031-01-02', endDate: '2031-01-01' }],
    ['a timestamp nextRunDate', { nextRunDate: '2031-01-01T00:00:00Z' }],
    ['a malformed endDate', { nextRunDate: '2031-01-01', endDate: '2031-02-30' }],
    ['no nextRunDate', {}],
  ])('POST refuses %s and creates nothing', async (_name, dates) => {
    const { c, customer } = await fixture();
    const res = await postDates(c, customer, dates);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(400);
    expect(await count(c)).toBe(0);
  });

  it.each([
    ['an End Date equal to the next run date', { nextRunDate: '2031-01-01', endDate: '2031-01-01' }],
    ['no End Date (what new.tsx sends when blank)', { nextRunDate: '2031-01-01' }],
    ["an empty End Date", { nextRunDate: '2031-01-01', endDate: '' }],
  ])('POST accepts %s', async (_name, dates) => {
    const { c, customer } = await fixture();
    const res = await postDates(c, customer, dates);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    expect(await count(c)).toBe(1);
  });
});
