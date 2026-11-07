/**
 * A customer's default revenue account (migration 965), through the real /api/accounting/customers route (withAuth,
 * CSRF, write access, the request transaction). withAuth COMMITS a 4xx, so the account must be judged before the first
 * write: a refused POST or PUT must leave every customer row, and the customer's change history, exactly as it was.
 * Another company's account and a deactivated one are refused by name; the composite FK refuses another company's
 * account even to a write that skips the app.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { cleanupEntityChanges, members, newCompany } from './entity-changes.helpers';
import { callRoute } from './r035-approval.helpers';
import customersRoute from '../../pages/api/accounting/customers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let admin = '';
let mine = '';
let theirs = '';
const ids = { sales: '', retired: '', foreign: '', customer: '' };

async function account(company: string, code: string, active = true): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO gl_accounts(company_id, account_code, account_name, account_type, normal_balance, is_active)
     VALUES($1, $2, $3, 'revenue', 'credit', $4) RETURNING id`, [company, code, `Sales ${code}`, active]);
  return rows[0].id as string;
}
const customerRow = async (id: string) => (await pool.query('SELECT * FROM customers WHERE id = $1', [id])).rows[0];
const changeCount = async (id: string) =>
  Number((await pool.query('SELECT count(*) FROM entity_changes WHERE entity_id = $1', [id])).rows[0].count);
const customerCount = async (company: string) =>
  Number((await pool.query('SELECT count(*) FROM customers WHERE company_id = $1', [company])).rows[0].count);
const put = (body: Record<string, unknown>) =>
  callRoute(customersRoute as never, tokens[admin]!, mine, 'PUT', body, '/api/accounting/customers');
const post = (body: Record<string, unknown>) =>
  callRoute(customersRoute as never, tokens[admin]!, mine, 'POST', body, '/api/accounting/customers');
const message = (r: { state: { body: unknown } }) => JSON.stringify(r.state.body);

beforeAll(async () => {
  [admin] = await members(pool, tokens, 1);
  mine = await newCompany(pool, [[admin, 'admin']], companies);
  theirs = await newCompany(pool, [], companies);
  ids.sales = await account(mine, '4000');
  ids.retired = await account(mine, '4900', false);
  ids.foreign = await account(theirs, '4000');
  const { rows } = await pool.query("INSERT INTO customers(company_id, name) VALUES($1, 'Acme') RETURNING id", [mine]);
  ids.customer = rows[0].id as string;
});
afterAll(async () => {
  // The FK has no ON DELETE action: the customers go before the accounts they name.
  await pool.query('UPDATE customers SET default_revenue_account_id = NULL WHERE company_id = ANY($1)', [companies]);
  await cleanupEntityChanges(pool, companies, [admin]);
});

describe('a refused default revenue account changes no row', () => {
  it.each([
    ['another company\'s account', () => ids.foreign, 'is not one of this company\'s accounts'],
    ['a deactivated account', () => ids.retired, '4900 Sales 4900 cannot be a customer\'s default revenue account: it is inactive'],
  ])('PUT with %s: 400 naming it; the customer and its history are unchanged', async (_what, id, refusal) => {
    const before = await customerRow(ids.customer);
    const history = await changeCount(ids.customer);
    const result = await put({ id: ids.customer, name: 'Acme Renamed', default_revenue_account_id: id() });
    expect(result.state.statusCode).toBe(400);
    expect(message(result)).toContain(refusal);
    expect(await customerRow(ids.customer)).toEqual(before);
    expect(await changeCount(ids.customer)).toBe(history);
  });

  it.each([
    ['another company\'s account', () => ids.foreign],
    ['a deactivated account', () => ids.retired],
  ])('POST with %s: 400, and no customer is created', async (_what, id) => {
    const count = await customerCount(mine);
    const result = await post({ name: 'Never Made', default_revenue_account_id: id() });
    expect(result.state.statusCode).toBe(400);
    expect(await customerCount(mine)).toBe(count);
  });
});

describe('an accepted account is stored, returned and can be cleared', () => {
  it('PUT stores it; the single GET returns it; a blank clears it', async () => {
    expect((await put({ id: ids.customer, default_revenue_account_id: ids.sales })).state.statusCode).toBe(200);
    expect((await customerRow(ids.customer)).default_revenue_account_id).toBe(ids.sales);
    const got = await callRoute(customersRoute as never, tokens[admin]!, mine, 'GET', undefined, '/api/accounting/customers', { id: ids.customer });
    expect((got.state.body as { data: { default_revenue_account_id: string } }).data.default_revenue_account_id).toBe(ids.sales);
    expect((await put({ id: ids.customer, default_revenue_account_id: '' })).state.statusCode).toBe(200);
    expect((await customerRow(ids.customer)).default_revenue_account_id).toBeNull();
  });
  it('POST creates a customer with it', async () => {
    const result = await post({ name: 'Made With Default', default_revenue_account_id: ids.sales });
    expect(result.state.statusCode).toBe(200);
    const id = (result.state.body as { data: { id: string } }).data.id;
    expect((await customerRow(id)).default_revenue_account_id).toBe(ids.sales);
  });
});

describe('the database fence (composite FK, migration 965)', () => {
  it('refuses another company\'s account on a direct write', async () => {
    await expect(pool.query('UPDATE customers SET default_revenue_account_id = $1 WHERE id = $2', [ids.foreign, ids.customer]))
      .rejects.toMatchObject({ code: '23503' });
  });
});
