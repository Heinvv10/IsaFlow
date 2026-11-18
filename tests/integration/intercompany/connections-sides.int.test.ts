/**
 * Intercompany P1: editing one's OWN side through the real route, and the side guard in the database. The customer,
 * supplier, accounts and dimensions must be the company's own (accounts active and postable), types are checked
 * before any cast (400, never 500), the checklist follows the settings, and a revoked connection stops changing.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { dataOf, messageOf } from '../r035-pr2.helpers';
import {
  acct, api, asAppUser, asOwner, cleanup, co, count, dim, outcome, party, plantConnection, plantSide, R, setup, U, wipeConnections,
} from './intercompany.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let id = '';

beforeAll(() => setup(pool), 60000);
afterAll(() => cleanup(pool));
beforeEach(async () => {
  await wipeConnections(pool);
  id = await plantConnection(pool, co.A, co.B);
});

const sideRows = (company: string) => pool.query('SELECT * FROM intercompany_connection_sides WHERE connection_id = $1 AND company_id = $2', [id, company]);
const SIDE = (column: string) => `INSERT INTO intercompany_connection_sides(connection_id, company_id, partner_company_id, ${column}) VALUES ($1, $2, $3, $4)`;

describe('own references only (route)', () => {
  it.each([
    ['a customer of B', () => ({ customerId: party.bCustomer })],
    ['a supplier of B', () => ({ supplierId: party.bSupplier })],
    ["B's loan account", () => ({ loanAccountId: acct.bLoan })],
    ["B's account as A's default expense", () => ({ defaultExpenseAccountId: acct.bLoan })],
    ['a header account as loan account', () => ({ loanAccountId: acct.aHeader })],
    ['an inactive account as default expense', () => ({ defaultExpenseAccountId: acct.aInactive })],
    ['a made-up customer', () => ({ customerId: crypto.randomUUID() })],
  ])('%s is a 400 and nothing is stored', async (_n, body) => {
    expect((await api.edit(U.a, co.A, id, body())).state.statusCode).toBe(400);
    expect((await sideRows(co.A)).rowCount).toBe(0);
  });

  it('A own customer, supplier and postable accounts are accepted, and read back with their names', async () => {
    const res = await api.edit(U.a, co.A, id, {
      customerId: party.aCustomer, supplierId: party.aSupplier, loanAccountId: acct.aLoan, defaultExpenseAccountId: acct.aExpense, autoAccept: true,
    });
    expect(res.state.statusCode).toBe(200);
    expect(dataOf<{ side: Record<string, unknown> }>(res).side).toMatchObject({
      customerId: party.aCustomer, supplierId: party.aSupplier, loanAccountId: acct.aLoan, defaultExpenseAccountId: acct.aExpense, autoAccept: true,
      customer: { label: 'IC A customer' }, supplier: { label: 'IC A supplier' },
    });
  });
});

describe('the side guard (database)', () => {
  it('refuses a foreign reference written straight to the table, in a session where the foreign row is VISIBLE (user in A and B, A session)', async () => {
    await asAppUser(pool, U.ab, co.A, async (q) => {
      expect(await outcome(q, SIDE('customer_id'), [id, co.A, co.B, party.bCustomer])).toBe(R.customerNotOwn);
      expect(await outcome(q, SIDE('supplier_id'), [id, co.A, co.B, party.bSupplier])).toBe(R.supplierNotOwn);
      expect(await outcome(q, SIDE('loan_account_id'), [id, co.A, co.B, acct.bLoan])).toBe(R.loanNotOwn);
      expect(await outcome(q, SIDE('default_expense_account_id'), [id, co.A, co.B, acct.bLoan])).toBe(R.expenseNotOwn);
      expect(await outcome(q, SIDE('default_cc1_id'), [id, co.A, co.B, dim.bCc1])).toBe(R.dimNotOwn);
      expect(await outcome(q, SIDE('default_cc2_id'), [id, co.A, co.B, dim.bCc2])).toBe(R.dimNotOwn);
      expect(await outcome(q, SIDE('default_bu_id'), [id, co.A, co.B, dim.bBu])).toBe(R.dimNotOwn);
    });
  });

  it("own dimensions are accepted; a foreign one is refused on UPDATE too", async () => {
    await asAppUser(pool, U.a, co.A, async (q) => {
      expect(await outcome(q, `INSERT INTO intercompany_connection_sides(connection_id, company_id, partner_company_id, default_cc1_id, default_cc2_id, default_bu_id)
        VALUES ($1, $2, $3, $4, $5, $6)`, [id, co.A, co.B, dim.aCc1, dim.aCc2, dim.aBu])).toBe('ok');
      expect(await outcome(q, 'UPDATE intercompany_connection_sides SET default_cc1_id = $2 WHERE connection_id = $1', [id, dim.bCc1])).toBe(R.dimNotOwn);
      expect(await outcome(q, 'UPDATE intercompany_connection_sides SET customer_id = $2 WHERE connection_id = $1', [id, party.bCustomer])).toBe(R.customerNotOwn);
    });
  });

  it('the pairing is checked in a legitimate session: partner C, partner A and a side for the other company are refused', async () => {
    await asAppUser(pool, U.ac, co.A, async (q) => {
      expect(await outcome(q, 'INSERT INTO intercompany_connection_sides(connection_id, company_id, partner_company_id) VALUES ($1, $2, $3)', [id, co.A, co.C])).toBe(R.sidePairing);
      expect(await outcome(q, 'INSERT INTO intercompany_connection_sides(connection_id, company_id, partner_company_id) VALUES ($1, $2, $2)', [id, co.A]))
        .toBe(R.sidePairing);
      expect(await outcome(q, 'INSERT INTO intercompany_connection_sides(connection_id, company_id, partner_company_id) VALUES ($1, $2, $3)', [id, co.C, co.A])).toBe(R.sidePairing);
    });
  });

  it('a side keeps its connection, company and partner (trigger, as owner)', async () => {
    await plantSide(pool, id, co.A, co.B);
    await asOwner(pool, U.ab, co.A, async (q) => {
      expect(await outcome(q, 'UPDATE intercompany_connection_sides SET company_id = partner_company_id, partner_company_id = company_id WHERE connection_id = $1', [id])).toBe(R.sideKeeps);
      expect(await outcome(q, 'UPDATE intercompany_connection_sides SET partner_company_id = $2 WHERE connection_id = $1', [id, co.C])).toBe(R.sideKeeps);
      expect(await outcome(q, 'UPDATE intercompany_connection_sides SET connection_id = gen_random_uuid() WHERE connection_id = $1', [id]))
        .toBe(R.sideKeeps);
    });
  });

  it('a revoked connection\'s sides cannot be inserted or changed', async () => {
    await plantSide(pool, id, co.A, co.B);
    await asOwner(pool, U.ab, co.A, (q) => q.query("UPDATE intercompany_connections SET status = 'revoked' WHERE id = $1", [id]), true);
    await asAppUser(pool, U.a, co.A, async (q) => {
      expect(await outcome(q, 'UPDATE intercompany_connection_sides SET auto_accept = false WHERE connection_id = $1', [id])).toBe(R.sideRevoked);
    });
    await asAppUser(pool, U.b, co.B, async (q) => {
      expect(await outcome(q, 'INSERT INTO intercompany_connection_sides(connection_id, company_id, partner_company_id) VALUES ($1, $2, $3)', [id, co.B, co.A])).toBe(R.sideRevoked);
    });
    const res = await api.edit(U.a, co.A, id, { autoAccept: false });
    expect(res.state.statusCode).toBe(409);
  });

  it('a revoked side still takes ON DELETE SET NULL: deleting what it points to succeeds and nulls the column; any other change is refused', async () => {
    const own = { customer: crypto.randomUUID(), supplier: crypto.randomUUID(), loan: crypto.randomUUID(), expense: crypto.randomUUID(),
      cc1: crypto.randomUUID(), cc2: crypto.randomUUID(), bu: crypto.randomUUID() };
    const tag = own.customer.slice(0, 6);
    await pool.query('INSERT INTO customers(id, company_id, name) VALUES ($1, $2, $3)', [own.customer, co.A, `IC SN customer ${tag}`]);
    await pool.query('INSERT INTO suppliers(id, company_id, name) VALUES ($1, $2, $3)', [own.supplier, co.A, `IC SN supplier ${tag}`]);
    await pool.query(`INSERT INTO gl_accounts(id, company_id, account_code, account_name, account_type, normal_balance)
      VALUES ($1, $3, $4, 'SN loan', 'liability', 'credit'), ($2, $3, $5, 'SN expense', 'liability', 'credit')`,
    [own.loan, own.expense, co.A, `SNL${tag}`, `SNE${tag}`]);
    await pool.query(`INSERT INTO cost_centres(id, company_id, code, name, cc_type) VALUES ($1, $3, $4, 'SN cc1', 'cc1'), ($2, $3, $5, 'SN cc2', 'cc2')`,
      [own.cc1, own.cc2, co.A, `SN1${tag}`, `SN2${tag}`]);
    await pool.query("INSERT INTO business_units(id, company_id, code, name) VALUES ($1, $2, $3, 'SN bu')", [own.bu, co.A, `SNB${tag}`]);
    await plantSide(pool, id, co.A, co.B, {
      customer_id: own.customer, supplier_id: own.supplier, loan_account_id: own.loan, default_expense_account_id: own.expense,
      default_cc1_id: own.cc1, default_cc2_id: own.cc2, default_bu_id: own.bu,
    });
    await asOwner(pool, U.ab, co.A, (q) => q.query("UPDATE intercompany_connections SET status = 'revoked' WHERE id = $1", [id]), true);

    // Any other change to the revoked side is still refused, nulling a reference included when it comes with one.
    await asAppUser(pool, U.a, co.A, async (q) => {
      expect(await outcome(q, 'UPDATE intercompany_connection_sides SET auto_accept = true WHERE connection_id = $1', [id])).toBe(R.sideRevoked);
      expect(await outcome(q, 'UPDATE intercompany_connection_sides SET customer_id = NULL, auto_accept = true WHERE connection_id = $1', [id])).toBe(R.sideRevoked);
      expect(await outcome(q, 'UPDATE intercompany_connection_sides SET customer_id = $2 WHERE connection_id = $1', [id, party.aCustomer])).toBe(R.sideRevoked);
      expect(await outcome(q, 'UPDATE intercompany_connection_sides SET loan_account_id = $2 WHERE connection_id = $1', [id, acct.aLoan])).toBe(R.sideRevoked);
    });

    const deletes: [string, string, string][] = [
      ['customers', own.customer, 'customer_id'], ['suppliers', own.supplier, 'supplier_id'], ['gl_accounts', own.loan, 'loan_account_id'],
      ['gl_accounts', own.expense, 'default_expense_account_id'], ['cost_centres', own.cc1, 'default_cc1_id'],
      ['cost_centres', own.cc2, 'default_cc2_id'], ['business_units', own.bu, 'default_bu_id'],
    ];
    for (const [table, rowId, column] of deletes) {
      await pool.query(`DELETE FROM ${table} WHERE id = $1`, [rowId]);
      expect((await sideRows(co.A)).rows[0][column], `${column} after deleting from ${table}`).toBeNull();
    }
    const side = (await sideRows(co.A)).rows[0];
    expect(side).toMatchObject({ customer_id: null, supplier_id: null, loan_account_id: null, default_expense_account_id: null,
      default_cc1_id: null, default_cc2_id: null, default_bu_id: null, auto_accept: false });
    await asAppUser(pool, U.a, co.A, async (q) => {
      expect(await outcome(q, 'UPDATE intercompany_connection_sides SET auto_accept = true WHERE connection_id = $1', [id])).toBe(R.sideRevoked);
    });
  });

  it('a customer or supplier is linked to one connection per company: a second link is refused (unique index)', async () => {
    await plantSide(pool, id, co.A, co.B, { customer_id: party.aCustomer, supplier_id: party.aSupplier });
    const g2 = crypto.randomUUID();
    await pool.query("INSERT INTO company_groups(id, name) VALUES ($1, 'IC group G3')", [g2]);
    await pool.query('INSERT INTO company_group_members(group_id, company_id) VALUES ($1, $2), ($1, $3)', [g2, co.A, co.C]);
    try {
      const second = await plantConnection(pool, co.A, co.C, U.ac);
      await asAppUser(pool, U.ac, co.A, async (q) => {
        expect(await outcome(q, SIDE('customer_id'), [second, co.A, co.C, party.aCustomer]))
          .toBe('23505: duplicate key value violates unique constraint "intercompany_sides_customer_uq"');
        expect(await outcome(q, SIDE('supplier_id'), [second, co.A, co.C, party.aSupplier]))
          .toBe('23505: duplicate key value violates unique constraint "intercompany_sides_supplier_uq"');
        expect(await outcome(q, 'INSERT INTO intercompany_connection_sides(connection_id, company_id, partner_company_id) VALUES ($1, $2, $3)', [second, co.A, co.C])).toBe('ok');
      });
      const res = await api.edit(U.ac, co.A, second, { customerId: party.aCustomer });
      expect(res.state.statusCode).toBe(409);
      expect(messageOf(res)).toMatch(/already linked/i);
    } finally {
      await pool.query('DELETE FROM intercompany_connection_sides');
      await pool.query('DELETE FROM intercompany_connections');
      await pool.query('DELETE FROM company_group_members WHERE group_id = $1', [g2]);
      await pool.query('DELETE FROM company_groups WHERE id = $1', [g2]);
    }
  });
});

describe('input types and ranges are a 400, never a 500', () => {
  it.each([
    ['customerId number', { customerId: 5 }],
    ['supplierId not a uuid', { supplierId: 'x' }],
    ['autoAccept as a string', { autoAccept: 'yes' }],
    ['a pair setting (it moved to the connection)', { settlementMode: 'loan' }],
    ['a pair setting: cutoverDate', { cutoverDate: '2026-12-01' }],
    ['unknown key (a company id)', { companyId: co.B }],
    ['empty body', {}],
  ])('%s', async (_n, body) => {
    expect((await api.edit(U.a, co.A, id, body)).state.statusCode).toBe(400);
  });

  it('a non-UUID connection id is 400; an unknown or foreign one is 404', async () => {
    expect((await api.edit(U.a, co.A, 'nope', { autoAccept: false })).state.statusCode).toBe(400);
    expect((await api.edit(U.a, co.A, crypto.randomUUID(), { autoAccept: false })).state.statusCode).toBe(404);
    expect((await api.edit(U.c, co.C, id, { autoAccept: false })).state.statusCode).toBe(404);
  });

  it('a viewer cannot edit (403)', async () => {
    expect((await api.edit(U.va, co.A, id, { autoAccept: false })).state.statusCode).toBe(403);
  });
});

describe('partial updates and the checklist', () => {
  it('a key left out is unchanged and null clears', async () => {
    await api.edit(U.a, co.A, id, { customerId: party.aCustomer, supplierId: party.aSupplier });
    await api.edit(U.a, co.A, id, { loanAccountId: acct.aLoan });
    let side = (await sideRows(co.A)).rows[0];
    expect([side.customer_id, side.supplier_id, side.loan_account_id]).toEqual([party.aCustomer, party.aSupplier, acct.aLoan]);
    await api.edit(U.a, co.A, id, { customerId: null });
    side = (await sideRows(co.A)).rows[0];
    expect([side.customer_id, side.supplier_id]).toEqual([null, party.aSupplier]);
  });

  it('shows each requirement as done or not; the pair mode and cut-over come from the connection; loan mode adds the loan account', async () => {
    type View = { checklist: { items: Array<{ key: string; done: boolean; required: boolean }>; complete: boolean } };
    const first = async () => dataOf<{ items: View[] }>(await api.list(U.a, co.A)).items[0]!;
    expect((await first()).checklist.complete).toBe(false);
    await api.edit(U.a, co.A, id, { customerId: party.aCustomer, supplierId: party.aSupplier });
    expect((await first()).checklist.items.find((i) => i.key === 'cutover')).toMatchObject({ done: false, required: true });
    await api.settings(U.ab, co.A, id, { cutoverDate: '2026-12-01' });
    expect((await first()).checklist.complete).toBe(true);
    await api.settings(U.ab, co.A, id, { settlementMode: 'loan' });
    const loan = await first();
    expect(loan.checklist.complete).toBe(false);
    expect(loan.checklist.items.find((i) => i.key === 'loanAccount')).toMatchObject({ required: true, done: false });
    await api.edit(U.a, co.A, id, { loanAccountId: acct.aLoan });
    expect((await first()).checklist.complete).toBe(true);
    // B's own side is its own: B's checklist is still undone for the customer and supplier
    const asB = dataOf<{ items: View[] }>(await api.list(U.b, co.B)).items[0]!;
    expect(asB.checklist.items.find((i) => i.key === 'customer')).toMatchObject({ done: false });
    expect(asB.checklist.items.find((i) => i.key === 'cutover')).toMatchObject({ done: true });
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

  it('a viewer cannot revoke (403) and the connection stays active', async () => {
    expect((await api.revoke(U.va, co.A, id)).state.statusCode).toBe(403);
    expect((await pool.query('SELECT status FROM intercompany_connections WHERE id = $1', [id])).rows[0].status).toBe('active');
  });

  it('through the table the status can only be changed, never the kind or the parties (grant)', async () => {
    await asAppUser(pool, U.a, co.A, async (q) => {
      expect(await outcome(q, 'UPDATE intercompany_connections SET kind = $2 WHERE id = $1', [id, 'external'])).toBe('42501: permission denied for table intercompany_connections');
      expect(await outcome(q, "UPDATE intercompany_connections SET status = 'pending' WHERE id = $1", [id])).toBe('23514: a connection cannot go from active to pending');
    });
    expect(await count(pool, 'SELECT COUNT(*)::int AS n FROM intercompany_connections')).toBe(1);
  });
});
