/**
 * The change-only check of a customer's default revenue account (migration 966) holds the customer row from the check
 * to the write. T1 resends the stored account A, deactivated since, so it is not judged again; while T1 is between its
 * check and its write, T2 sets account B through the real route. Without the lock T2 commits B at once and T1 then
 * writes the inactive A back over it. With it, T2 waits for T1 and its B is what stays.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { als } from '@/lib/als';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { cleanupEntityChanges, members, newCompany } from './entity-changes.helpers';
import { callRoute } from './r035-approval.helpers';
import customersRoute from '../../pages/api/accounting/customers';
import { customerRevenueAccountForUpdate } from '../../src/modules/accounting/services/core/contactRevenueAccount';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let admin = '';
let company = '';

async function account(code: string): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO gl_accounts(company_id, account_code, account_name, account_type, normal_balance)
     VALUES($1, $2, $3, 'revenue', 'credit') RETURNING id`, [company, code, `Sales ${code}`]);
  return rows[0].id as string;
}

beforeAll(async () => {
  [admin] = await members(pool, tokens, 1);
  company = await newCompany(pool, [[admin, 'admin']], companies);
});
afterAll(async () => {
  await pool.query('UPDATE customers SET default_revenue_account_id = NULL WHERE company_id = ANY($1)', [companies]);
  await cleanupEntityChanges(pool, companies, [admin]);
});

describe('a resent stale default cannot overwrite a concurrent change', () => {
  it('T2 waits for T1 between its check and its write, and T2\'s account is what stays', async () => {
    const a = await account('4100');
    const b = await account('4200');
    const { rows } = await pool.query(
      "INSERT INTO customers(company_id, name, default_revenue_account_id) VALUES($1, 'Race', $2) RETURNING id", [company, a]);
    const customer = rows[0].id as string;
    await pool.query('UPDATE gl_accounts SET is_active = false WHERE id = $1', [a]);

    const t1 = await pool.connect();
    let t2Done = false;
    let committed = false;
    try {
      await t1.query('BEGIN');
      // T1's check: A is the stored value, so it is not judged again (and the row is now held).
      const kept = await als.run({ client: t1, userId: admin, companyId: company, claims: {} } as never,
        () => customerRevenueAccountForUpdate(company, customer, a));
      expect(kept).toBe(a);

      const t2 = callRoute(customersRoute as never, tokens[admin]!, company, 'PUT', { id: customer, default_revenue_account_id: b },
        '/api/accounting/customers').then((r) => { t2Done = true; return r; });
      await new Promise((r) => { setTimeout(r, 750); });
      expect(t2Done).toBe(false); // T2 is waiting on T1's row lock

      // T1's write: what updateCustomer's UPDATE does with the value its check let through.
      await t1.query('UPDATE customers SET default_revenue_account_id = $1 WHERE id = $2', [a, customer]);
      await t1.query('COMMIT');
      committed = true;
      const answer = await t2;
      expect(answer.state.statusCode).toBe(200);
    } finally {
      if (!committed) await t1.query('ROLLBACK');
      t1.release();
    }
    const { rows: after } = await pool.query('SELECT default_revenue_account_id FROM customers WHERE id = $1', [customer]);
    expect(after[0].default_revenue_account_id).toBe(b);
  });
});
