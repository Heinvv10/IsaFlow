/**
 * Intercompany P1: editing one's OWN side through the real route. The customer, supplier and accounts must be the
 * company's own (and the accounts active and postable), the types are checked before any cast (400, never 500),
 * the checklist follows the settings, and a revoked connection stops changing.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { dataOf, messageOf } from '../r035-pr2.helpers';
import { acct, api, asAppUser, cleanup, co, count, outcome, pairOf, party, plantConnection, setup, U, wipeConnections } from './intercompany.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let id = '';

beforeAll(() => setup(pool), 60000);
afterAll(() => cleanup(pool));
beforeEach(async () => {
  await wipeConnections(pool);
  id = await plantConnection(pool, 'group', co.A, co.B);
});

const sideRows = (company: string) => pool.query('SELECT * FROM intercompany_connection_sides WHERE connection_id = $1 AND company_id = $2', [id, company]);

describe('own references only', () => {
  it.each([
    ['a customer of B', () => ({ customerId: party.bCustomer })],
    ['a supplier of B', () => ({ supplierId: party.bSupplier })],
    ["B's loan account", () => ({ loanAccountId: acct.bLoan })],
    ["B's account as A's default expense", () => ({ defaultExpenseAccountId: acct.bLoan })],
    ['a header account as loan account', () => ({ loanAccountId: acct.aHeader })],
    ['an inactive account as default expense', () => ({ defaultExpenseAccountId: acct.aInactive })],
    ['a made-up customer', () => ({ customerId: crypto.randomUUID() })],
  ])('%s is a 400 and nothing is stored', async (_n, body) => {
    const res = await api.edit(U.a, co.A, id, body());
    expect(res.state.statusCode).toBe(400);
    expect((await sideRows(co.A)).rowCount).toBe(0);
  });

  it('A own customer, supplier and postable accounts are accepted, and read back with their names', async () => {
    const res = await api.edit(U.a, co.A, id, {
      customerId: party.aCustomer, supplierId: party.aSupplier, settlementMode: 'loan', loanAccountId: acct.aLoan,
      defaultExpenseAccountId: acct.aExpense, cutoverDate: '2026-12-01', interestRatePct: 10.5,
    });
    expect(res.state.statusCode).toBe(200);
    const side = dataOf<{ side: Record<string, unknown>; checklist: { complete: boolean } }>(res);
    expect(side.side).toMatchObject({
      customerId: party.aCustomer, supplierId: party.aSupplier, settlementMode: 'loan', loanAccountId: acct.aLoan,
      defaultExpenseAccountId: acct.aExpense, cutoverDate: '2026-12-01', interestRatePct: 10.5, autoAccept: false,
      customer: { label: 'IC A customer' }, supplier: { label: 'IC A supplier' },
    });
    expect(side.checklist.complete).toBe(true);
  });

  it('the database also refuses a foreign reference written straight to the table (23503)', async () => {
    await asAppUser(pool, U.a, co.A, async (q) => {
      for (const column of ['customer_id', 'supplier_id', 'loan_account_id', 'default_expense_account_id']) {
        const foreign = { customer_id: party.bCustomer, supplier_id: party.bSupplier, loan_account_id: acct.bLoan, default_expense_account_id: acct.bLoan }[column];
        expect(await outcome(q, `INSERT INTO intercompany_connection_sides(connection_id, company_id, partner_company_id, ${column}) VALUES ($1, $2, $3, $4)`,
          [id, co.A, co.B, foreign])).toMatch(/^23503/);
      }
    });
  });
});

describe('input types and ranges are a 400, never a 500', () => {
  it.each([
    ['customerId number', { customerId: 5 }],
    ['supplierId not a uuid', { supplierId: 'x' }],
    ['unknown settlement mode', { settlementMode: 'barter' }],
    ['autoAccept as a string', { autoAccept: 'yes' }],
    ['cutoverDate impossible', { cutoverDate: '2026-02-30' }],
    ['interest 100.5', { interestRatePct: 100.5 }],
    ['interest negative', { interestRatePct: -1 }],
    ['interest as a string', { interestRatePct: '5' }],
    ['unknown key (a company id)', { companyId: co.B }],
    ['empty body', {}],
  ])('%s', async (_n, body) => {
    expect((await api.edit(U.a, co.A, id, body)).state.statusCode).toBe(400);
  });

  it('a non-UUID connection id is 400; an unknown or foreign one is 404', async () => {
    expect((await api.edit(U.a, co.A, 'nope', { cutoverDate: null })).state.statusCode).toBe(400);
    expect((await api.edit(U.a, co.A, crypto.randomUUID(), { cutoverDate: '2026-12-01' })).state.statusCode).toBe(404);
    expect((await api.edit(U.c, co.C, id, { cutoverDate: '2026-12-01' })).state.statusCode).toBe(404);
  });

  it('interest at the bounds (0 and 100) and null are accepted; the database CHECK holds as well', async () => {
    for (const v of [0, 100, null]) expect((await api.edit(U.a, co.A, id, { interestRatePct: v })).state.statusCode).toBe(200);
    await asAppUser(pool, U.a, co.A, async (q) => {
      expect(await outcome(q, 'UPDATE intercompany_connection_sides SET interest_rate_pct = 100.0001 WHERE connection_id = $1', [id])).toMatch(/^23514/);
    });
  });

  it('a viewer cannot edit (403)', async () => {
    expect((await api.edit(U.va, co.A, id, { cutoverDate: '2026-12-01' })).state.statusCode).toBe(403);
  });
});

describe('partial updates and the checklist', () => {
  it('a key left out is unchanged and null clears', async () => {
    await api.edit(U.a, co.A, id, { customerId: party.aCustomer, cutoverDate: '2026-12-01' });
    await api.edit(U.a, co.A, id, { supplierId: party.aSupplier });
    let side = (await sideRows(co.A)).rows[0];
    expect([side.customer_id, side.supplier_id]).toEqual([party.aCustomer, party.aSupplier]);
    await api.edit(U.a, co.A, id, { customerId: null });
    side = (await sideRows(co.A)).rows[0];
    expect([side.customer_id, side.supplier_id]).toEqual([null, party.aSupplier]);
  });

  it('shows each requirement as done or not, and loan mode adds the loan account', async () => {
    let view = dataOf<{ items: Array<{ checklist: { items: Array<{ key: string; done: boolean; required: boolean }>; complete: boolean } }> }>(await api.list(U.a, co.A)).items[0]!;
    expect(view.checklist.complete).toBe(false);
    await api.edit(U.a, co.A, id, { customerId: party.aCustomer, supplierId: party.aSupplier, cutoverDate: '2026-12-01' });
    view = dataOf<typeof view extends infer V ? { items: V[] } : never>(await api.list(U.a, co.A)).items[0]!;
    expect(view.checklist.complete).toBe(true);
    await api.edit(U.a, co.A, id, { settlementMode: 'loan' });
    view = dataOf<{ items: typeof view[] }>(await api.list(U.a, co.A)).items[0]!;
    expect(view.checklist.complete).toBe(false);
    expect(view.checklist.items.find((i) => i.key === 'loanAccount')).toMatchObject({ required: true, done: false });
  });
});

describe('revoking', () => {
  it('either party may revoke; the second revoke is 409; the stamp is the revoking user', async () => {
    expect((await api.revoke(U.a, co.A, id)).state.statusCode).toBe(200);
    expect((await api.revoke(U.b, co.B, id)).state.statusCode).toBe(409);
    const row = (await pool.query('SELECT status, revoked_by, revoked_at FROM intercompany_connections WHERE id = $1', [id])).rows[0];
    expect(row).toMatchObject({ status: 'revoked', revoked_by: U.a });
    expect(row.revoked_at).toBeInstanceOf(Date);
  });

  it('a revoked connection can no longer have its side edited (409)', async () => {
    await api.revoke(U.b, co.B, id);
    const res = await api.edit(U.a, co.A, id, { cutoverDate: '2026-12-01' });
    expect(res.state.statusCode).toBe(409);
    expect(messageOf(res)).toMatch(/revoked/i);
    expect(await count(pool, 'SELECT COUNT(*)::int AS n FROM intercompany_connection_sides WHERE connection_id = $1', [id])).toBe(0);
  });

  it('a viewer cannot revoke (403) and the connection stays active', async () => {
    expect((await api.revoke(U.va, co.A, id)).state.statusCode).toBe(403);
    expect((await pool.query('SELECT status FROM intercompany_connections WHERE id = $1', [id])).rows[0].status).toBe('active');
  });

  it('the status moves only by the legal steps, and only status ever changes (database)', async () => {
    await asAppUser(pool, U.a, co.A, async (q) => {
      expect(await outcome(q, "UPDATE intercompany_connections SET status = 'pending' WHERE id = $1", [id])).toMatch(/^23514/);
      expect(await outcome(q, 'UPDATE intercompany_connections SET kind = $2 WHERE id = $1', [id, 'external'])).toMatch(/^42501/);
    });
    await api.revoke(U.a, co.A, id);
    const external = await plantConnection(pool, 'external', co.A, co.C);
    // plantConnection makes the LOW company the inviter; the other one accepts.
    const [inviter, invitee] = pairOf(co.A, co.C);
    await asAppUser(pool, U.ac, inviter, async (q) => {
      expect(await outcome(q, "UPDATE intercompany_connections SET status = 'active' WHERE id = $1", [external]))
        .toMatch(/^42501: an invitation is accepted by the other company/);
    });
    await asAppUser(pool, U.ac, invitee, async (q) => {
      expect(await outcome(q, "UPDATE intercompany_connections SET status = 'active' WHERE id = $1", [external])).toBe('ok');
    });
  });
});
