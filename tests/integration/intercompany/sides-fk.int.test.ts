/**
 * Intercompany (999z): a side's references (customer, supplier, accounts, centres, unit) are ON DELETE SET NULL. The
 * foreign key's own UPDATE of the side runs one trigger level down and must pass whatever the connection's state, so a
 * hard delete (the soft-delete purge, a migration rollback) is never blocked by a revoked connection. The same UPDATE
 * written by a user does not pass.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { purgeExpiredDeletes } from '../../../src/modules/accounting/services/core/softDeleteService';
import { asAppUser, asOwner, cleanup, co, outcome, plantConnection, plantSide, R, setup, U, wipeConnections } from './intercompany.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let id = '';

beforeAll(() => setup(pool), 60000);
afterAll(() => cleanup(pool));
beforeEach(async () => {
  await wipeConnections(pool);
  id = await plantConnection(pool, co.A, co.B);
});

const side = async () => (await pool.query('SELECT * FROM intercompany_connection_sides WHERE connection_id = $1 AND company_id = $2', [id, co.A])).rows[0];
const revoke = () => asOwner(pool, U.ab, co.A, (q) => q.query("UPDATE intercompany_connections SET status = 'revoked' WHERE id = $1", [id]), true);

/** A fresh customer, supplier, two accounts, a centre of each kind and a unit of company A, all named by A's side. */
async function referencedSide() {
  const ids = { customer: crypto.randomUUID(), supplier: crypto.randomUUID(), loan: crypto.randomUUID(), expense: crypto.randomUUID(), cc1: crypto.randomUUID(), cc2: crypto.randomUUID(), bu: crypto.randomUUID() };
  const tag = ids.customer.slice(0, 6);
  await pool.query('INSERT INTO customers(id, company_id, name) VALUES ($1, $2, $3)', [ids.customer, co.A, `FK ${tag}`]);
  await pool.query('INSERT INTO suppliers(id, company_id, name) VALUES ($1, $2, $3)', [ids.supplier, co.A, `FK ${tag}`]);
  for (const [k, code] of [['loan', 'FKL'], ['expense', 'FKE']] as const) {
    await pool.query(`INSERT INTO gl_accounts(id, company_id, account_code, account_name, account_type, normal_balance) VALUES ($1, $2, $3, $3, 'liability', 'credit')`, [ids[k], co.A, `${code}${tag}`]);
  }
  await pool.query(`INSERT INTO cost_centres(id, company_id, code, name, cc_type) VALUES ($1, $3, $4, 'fk1', 'cc1'), ($2, $3, $5, 'fk2', 'cc2')`, [ids.cc1, ids.cc2, co.A, `F1${tag}`, `F2${tag}`]);
  await pool.query(`INSERT INTO business_units(id, company_id, code, name) VALUES ($1, $2, $3, 'fk')`, [ids.bu, co.A, `FB${tag}`]);
  await plantSide(pool, id, co.A, co.B, {
    customer_id: ids.customer, supplier_id: ids.supplier, loan_account_id: ids.loan, default_expense_account_id: ids.expense,
    default_cc1_id: ids.cc1, default_cc2_id: ids.cc2, default_bu_id: ids.bu,
  });
  return ids;
}

const HARD_DELETES: Array<[string, string, keyof Awaited<ReturnType<typeof referencedSide>>, string]> = [
  ['customer', 'customers', 'customer', 'customer_id'], ['supplier', 'suppliers', 'supplier', 'supplier_id'],
  ['loan account', 'gl_accounts', 'loan', 'loan_account_id'], ['default expense account', 'gl_accounts', 'expense', 'default_expense_account_id'],
  ['cost centre 1', 'cost_centres', 'cc1', 'default_cc1_id'], ['cost centre 2', 'cost_centres', 'cc2', 'default_cc2_id'], ['business unit', 'business_units', 'bu', 'default_bu_id'],
];

describe.each([['an active', false], ['a revoked', true]])('hard-deleting what %s connection\'s side names', (_n, revoked) => {
  it.each(HARD_DELETES)('%s: the delete goes through and only that reference is cleared', async (_label, table, key, column) => {
    const ids = await referencedSide();
    if (revoked) await revoke();
    await pool.query(`DELETE FROM ${table} WHERE id = $1`, [ids[key]]);
    const row = await side();
    expect(row[column]).toBeNull();
    for (const [, , otherKey, otherColumn] of HARD_DELETES.filter((h) => h[3] !== column)) {
      expect(row[otherColumn], otherColumn).toBe(ids[otherKey]);
    }
  });

  it('the soft-delete purge (purgeExpiredDeletes) removes a customer a side still names', async () => {
    const ids = await referencedSide();
    if (revoked) await revoke();
    await pool.query("UPDATE customers SET deleted_at = now() - interval '1 day' WHERE id = $1", [ids.customer]);
    await purgeExpiredDeletes(co.A);
    expect((await pool.query('SELECT 1 FROM customers WHERE id = $1', [ids.customer])).rowCount).toBe(0);
    expect((await side()).customer_id).toBeNull();
  });

  it('an app_user session deleting the row (a writer of the company) passes too', async () => {
    const ids = await referencedSide();
    if (revoked) await revoke();
    await asAppUser(pool, U.a, co.A, (q) => q.query('DELETE FROM customers WHERE id = $1', [ids.customer]), true);
    expect((await side()).customer_id).toBeNull();
  });
});

describe('the same UPDATE written by a user is not a foreign key action', () => {
  it('on a revoked connection it is refused, and on an active one a viewer is refused; a change of anything else with it is refused', async () => {
    const ids = await referencedSide();
    await asAppUser(pool, U.va, co.A, async (q) => {
      expect(await outcome(q, 'UPDATE intercompany_connection_sides SET customer_id = NULL WHERE connection_id = $1', [id])).toBe(R.sideWriteRole);
    });
    await asAppUser(pool, U.a, co.A, async (q) => {
      expect(await outcome(q, 'UPDATE intercompany_connection_sides SET customer_id = NULL, auto_accept = true WHERE connection_id = $1', [id])).toBe('ok');
    }, true);
    await revoke();
    await asAppUser(pool, U.a, co.A, async (q) => {
      expect(await outcome(q, 'UPDATE intercompany_connection_sides SET customer_id = NULL WHERE connection_id = $1', [id])).toBe(R.sideRevoked);
    });
    await asOwner(pool, U.ab, co.A, async (q) => {
      expect(await outcome(q, 'UPDATE intercompany_connection_sides SET supplier_id = NULL WHERE connection_id = $1', [id])).toBe(R.sideRevoked);
    });
    expect((await side()).supplier_id).toBe(ids.supplier);
  });
});
