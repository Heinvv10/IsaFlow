/**
 * R-125 — the customer list (pages/api/accounting/customers.ts) and the chart
 * of accounts (chartOfAccountsService.getChartOfAccounts) were served from the
 * in-process cache for CACHE_TTL.REFERENCE_DATA (5 minutes). Only some writers
 * invalidated it: customers has 10 writer files and 2 invalidators, gl_accounts
 * 12 and 5, and no journal poster invalidated the cached `has_transactions`.
 * The cache is per process, so no invalidation reaches another process anyway.
 *
 * Each test writes through a path that is not the list route (direct SQL,
 * standing in for MCP tools, merges, soft-delete, imports, other processes)
 * and asserts the very next list read shows it.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/auth', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  withAuth: (h: unknown) => h,
  withWriteAccess: (h: unknown) => h,
}));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const COMPANY = randomUUID();
const OTHER_COMPANY = randomUUID();
const USER = randomUUID();

let admin: Pool;
type Route = (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>;
let customersRoute: Route;
let coaRoute: Route;

function mockRes() {
  const res = {
    statusCode: 200, body: undefined as unknown, headers: {} as Record<string, unknown>,
    status(c: number) { this.statusCode = c; return this; },
    json(p: unknown) { this.body = p; return this; },
    send(p: unknown) { this.body = p; return this; },
    end(p?: unknown) { this.body = p; return this; },
    setHeader(k: string, v: unknown) { this.headers[k] = v; return this; },
  };
  return res as unknown as NextApiResponse & typeof res;
}

async function get(route: Route, query: Record<string, string>): Promise<Array<Record<string, unknown>>> {
  const res = mockRes();
  await route({ method: 'GET', query, headers: {}, companyId: COMPANY, user: { id: USER } } as unknown as NextApiRequest, res);
  expect(res.statusCode).toBe(200);
  return (res.body as { data: Array<Record<string, unknown>> }).data;
}

const customerIds = async () => (await get(customersRoute, {})).map((c) => String(c.id));
const accounts = (includeInactive = false) =>
  get(coaRoute, includeInactive ? { includeInactive: 'true' } : {});

describeIfDb('R-125 reference lists reflect writes that bypass their routes', () => {
  let customerA: string;
  let accountA: string;

  beforeAll(async () => {
    const dbName = new URL(DATABASE_URL!).pathname.replace(/^\//, '');
    if (dbName === 'isaflow') throw new Error('Refusing to run against production.');
    admin = new Pool({ connectionString: DATABASE_URL, max: 3 });
    for (const [id, name] of [[COMPANY, 'R125 Company'], [OTHER_COMPANY, 'R125 Other']]) {
      await admin.query(`INSERT INTO companies (id,name,is_active) VALUES ($1,$2,true)`, [id, name]);
    }
    customerA = (await admin.query(
      `INSERT INTO customers (company_id,name,is_active) VALUES ($1,'R125 Customer A',true) RETURNING id`, [COMPANY])).rows[0].id;
    accountA = (await admin.query(
      `INSERT INTO gl_accounts (company_id,account_code,account_name,account_type,normal_balance,is_active)
       VALUES ($1,'R125-A','R125 Account A','expense','debit',true) RETURNING id`, [COMPANY])).rows[0].id;
    customersRoute = (await import('../../pages/api/accounting/customers')).default as unknown as Route;
    coaRoute = (await import('../../pages/api/accounting/chart-of-accounts')).default as unknown as Route;
  }, 60000);

  afterAll(async () => {
    if (!admin) return;
    for (const c of [COMPANY, OTHER_COMPANY]) {
      await admin.query('DELETE FROM gl_journal_lines WHERE company_id = $1', [c]);
      await admin.query('DELETE FROM gl_journal_entries WHERE company_id = $1', [c]);
      await admin.query('DELETE FROM gl_accounts WHERE company_id = $1', [c]);
      await admin.query('DELETE FROM customers WHERE company_id = $1', [c]);
      await admin.query('DELETE FROM companies WHERE id = $1', [c]);
    }
    await admin.end();
  });

  it('shows a customer created outside the route on the next list read', async () => {
    expect(await customerIds()).toEqual([customerA]);
    const added = (await admin.query(
      `INSERT INTO customers (company_id,name,is_active) VALUES ($1,'R125 Customer B',true) RETURNING id`, [COMPANY])).rows[0].id;
    // Another tenant's write must not appear: the list stays company-scoped.
    await admin.query(`INSERT INTO customers (company_id,name,is_active) VALUES ($1,'R125 Foreign',true)`, [OTHER_COMPANY]);
    expect((await customerIds()).sort()).toEqual([customerA, added].sort());
  });

  it('drops a customer soft-deleted outside the route on the next list read', async () => {
    expect(await customerIds()).toContain(customerA);
    await admin.query('UPDATE customers SET deleted_at = NOW() WHERE id = $1 AND company_id = $2', [customerA, COMPANY]);
    try {
      expect(await customerIds()).not.toContain(customerA);
    } finally {
      await admin.query('UPDATE customers SET deleted_at = NULL WHERE id = $1 AND company_id = $2', [customerA, COMPANY]);
    }
  });

  it('drops an account deactivated outside the service on the next active-list read', async () => {
    expect((await accounts()).map((a) => a.id)).toEqual([accountA]);
    await admin.query('UPDATE gl_accounts SET is_active = false WHERE id = $1 AND company_id = $2', [accountA, COMPANY]);
    try {
      expect(await accounts()).toEqual([]);
      // Still listed when inactive accounts are asked for.
      expect((await accounts(true)).map((a) => a.id)).toEqual([accountA]);
    } finally {
      await admin.query('UPDATE gl_accounts SET is_active = true WHERE id = $1 AND company_id = $2', [accountA, COMPANY]);
    }
  });

  it('reports hasTransactions once a journal line lands on the account', async () => {
    const before = await accounts();
    expect(before.find((a) => a.id === accountA)?.hasTransactions).toBe(false);
    const je = (await admin.query(
      `INSERT INTO gl_journal_entries (company_id,entry_date,created_by,status,entry_number)
       VALUES ($1,CURRENT_DATE,$2,'draft','R125-JE-1') RETURNING id`, [COMPANY, USER])).rows[0].id;
    await admin.query(
      `INSERT INTO gl_journal_lines (journal_entry_id,gl_account_id,debit,company_id) VALUES ($1,$2,10,$3)`,
      [je, accountA, COMPANY]);
    const after = await accounts();
    expect(after.find((a) => a.id === accountA)?.hasTransactions).toBe(true);
  });
});
