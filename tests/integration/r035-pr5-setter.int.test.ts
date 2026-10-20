/**
 * R-035 PR5, decision (b) (orchestrator, 2026-10-06; Hein's addendum: whoever
 * sets where the money goes is an author), made APPEND-ONLY in round 1 (blind
 * MEDIUM 2): `suppliers.bank_details_setters` — everyone who changed a bank
 * column since the account itself was last re-pointed, and whoever created the
 * supplier WITH bank details — is DERIVED, live, into the authors of every
 * payment to that supplier and every batch carrying one. So a user who points a
 * supplier's account at themselves BEFORE a colleague creates the payment may
 * not approve it, even after an innocent colleague corrects another bank
 * column. Set by updateSupplier (the UI route and MCP update_supplier), the
 * supplier take-on and supplier creation; a write carrying no bank change never
 * touches the column (golden path d creates a supplier with no bank details on
 * a database without migration 867). The change is judged against the row as
 * LOCKED, so an edit that waited on a concurrent bank change is not mistaken
 * for one. Known limit: re-pointing the account (number or branch code) again
 * restarts the list at that editor.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import suppliersList from '../../pages/api/accounting/suppliers-list';
import migrationSuppliers from '../../pages/api/accounting/migration/suppliers';
import { McpRegistry } from '../../src/lib/mcp/registry';
import { updateSupplierTool } from '../../src/lib/mcp/tools/writeContacts';
import { updateSupplier } from '@/modules/accounting/services/core/supplierWriteService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser, plantRule } from './r035-approval.helpers';
import { dataOf } from './r035-pr2.helpers';
import {
  authorsOf, cleanupPr5, enforcePay, inRequest, payCompany, payRoutes, plantBatch, plantPayment, plantSupplier,
} from './r035-pr5.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
const u = { a: '', b: '', c: '', d: '' };
const r = payRoutes(tokens);

beforeAll(async () => {
  for (const k of Object.keys(u) as (keyof typeof u)[]) u[k] = await createUser(pool, tokens);
});
afterAll(async () => {
  await pool.query('DELETE FROM migration_sessions WHERE company_id = ANY($1)', [companies]);
  await pool.query('DELETE FROM mcp_tool_calls WHERE company_id = ANY($1)', [companies]);
  await cleanupPr5(pool, companies, Object.values(u));
});

/** A admin creates payments and requests; B, C and D are owners; an owner rule governs both types, enforced. */
async function company() {
  const { company: c, bank } = await payCompany(pool, [[u.a, 'admin'], [u.b, 'owner'], [u.c, 'owner'], [u.d, 'owner']], companies);
  for (const type of ['supplier_payment', 'payment_batch'] as const) {
    await plantRule(pool, c, 'owner', { documentType: type });
    await enforcePay(pool, c, type, u.b);
  }
  return { c, bank };
}

/** The supplier's bank-details setters, sorted; [] for none. */
const settersOf = async (supplierId: string) => ((await pool.query(
  'SELECT bank_details_setters AS s FROM suppliers WHERE id = $1', [supplierId])).rows[0].s as string[]).sort();

/** A creates a payment to `supplierId` NOW and raises it; `user` decides. Returns the decide status. */
async function decideNewPayment(c: string, bank: string, supplierId: string, user: string): Promise<number> {
  const p = await plantPayment(pool, c, u.a, bank, { supplierId });
  const req = dataOf<{ id: string }>(await r.raise(u.a, c, 'supplier_payment', p.id)).id;
  return (await r.decide(pool, user, c, req)).state.statusCode;
}

describe('the bank-details setter is an author of payments created after the change', () => {
  it('B points the account at their own, A creates the payment, B is refused (403); D approves', async () => {
    const { c, bank } = await company();
    const s = await plantSupplier(pool, c);
    await inRequest(pool, u.b, c, () => updateSupplier(c, s, { bankAccountNumber: '62777777777' }, u.b));
    expect(await settersOf(s)).toEqual([u.b]);
    const p = await plantPayment(pool, c, u.a, bank, { supplierId: s });
    const req = dataOf<{ id: string }>(await r.raise(u.a, c, 'supplier_payment', p.id)).id;
    expect((await r.decide(pool, u.b, c, req)).state.statusCode).toBe(403);
    expect((await r.decide(pool, u.d, c, req)).state.statusCode).toBe(200);
  });

  it("a batch carries its members' payees' setters", async () => {
    const { c, bank } = await company();
    const b = await plantBatch(pool, c, u.a, bank);
    await inRequest(pool, u.c, c, () => updateSupplier(c, b.members[1]!.supplierId, { bankName: 'Other Bank' }, u.c));
    expect(await authorsOf(pool, c, 'payment_batch', b.id)).toContain(u.c);
  });

  it('creating a supplier WITH bank details makes the creator the setter; without them, nobody', async () => {
    const { c, bank } = await company();
    const create = (body: Record<string, unknown>) => callRoute(suppliersList, tokens[u.b]!, c, 'POST', body, '/api/accounting/suppliers-list');
    const withBank = dataOf<{ id: string }>(await create({ name: 'R035 with bank', bank_account_number: '62888888888' })).id;
    const without = dataOf<{ id: string }>(await create({ name: 'R035 no bank', email: 'x@y.z' })).id;
    expect(await settersOf(withBank)).toEqual([u.b]);
    expect(await settersOf(without)).toEqual([]);
    expect(await decideNewPayment(c, bank, withBank, u.b)).toBe(403);
    expect(await decideNewPayment(c, bank, without, u.b)).toBe(200);
  });

  // Only the overwrite: the take-on's NEW-supplier INSERT names suppliers.billing_address, which does not exist
  // (pre-existing on master), so no new supplier imports today; its setter call is in place for when it does.
  it('the supplier take-on: an overwrite that changes bank details sets the importer', async () => {
    const { c, bank } = await company();
    const s = await plantSupplier(pool, c);
    const name = (await pool.query('SELECT name FROM suppliers WHERE id = $1', [s])).rows[0].name;
    const session = (await pool.query('INSERT INTO migration_sessions(company_id, started_by) VALUES($1,$2) RETURNING id', [c, u.c])).rows[0].id;
    const res = await callRoute(migrationSuppliers, tokens[u.c]!, c, 'POST', {
      sessionId: session, duplicateStrategy: 'overwrite',
      suppliers: [{ name, bankAccountNumber: '62111111111' }],
    }, '/api/accounting/migration/suppliers');
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    expect(await settersOf(s)).toEqual([u.c]);
    expect(await decideNewPayment(c, bank, s, u.c)).toBe(403);
  });

  it('MCP update_supplier sets the token user', async () => {
    const { c, bank } = await company();
    const s = await plantSupplier(pool, c);
    const registry = new McpRegistry();
    registry.register(updateSupplierTool);
    const res = await inRequest(pool, u.b, c, () => registry.call('update_supplier',
      { supplier_id: s, bank_branch_code: '470010', idempotency_key: crypto.randomUUID() },
      { userId: u.b, companyId: c, scopes: ['write:contacts'], companyRole: 'owner', tokenJti: 'r035-pr5', oauthAppId: null }));
    expect(res.isError, JSON.stringify(res)).toBeFalsy();
    expect(await settersOf(s)).toEqual([u.b]);
    expect(await decideNewPayment(c, bank, s, u.b)).toBe(403);
  });

  it('an edit that changes no bank column sets nobody', async () => {
    const { c } = await company();
    const s = await plantSupplier(pool, c);
    await inRequest(pool, u.b, c, () => updateSupplier(c, s, { notes: 'n', bankName: 'R035 Bank', subjectToDrcVat: true }, u.b));
    expect(await settersOf(s)).toEqual([]);
  });

  it('append-only (round 1 MEDIUM 2): B re-points the account, an innocent C fixes its type, and B is still refused', async () => {
    const { c, bank } = await company();
    const s = await plantSupplier(pool, c);
    await inRequest(pool, u.b, c, () => updateSupplier(c, s, { bankAccountNumber: '62777777777' }, u.b));
    await inRequest(pool, u.c, c, () => updateSupplier(c, s, { bankAccountType: 'savings' }, u.c));
    expect(await settersOf(s)).toEqual([u.b, u.c].sort());
    const p = await plantPayment(pool, c, u.a, bank, { supplierId: s });
    const req = dataOf<{ id: string }>(await r.raise(u.a, c, 'supplier_payment', p.id)).id;
    expect((await r.decide(pool, u.b, c, req)).state.statusCode).toBe(403);
    expect((await r.decide(pool, u.c, c, req)).state.statusCode).toBe(403);
    expect((await r.decide(pool, u.d, c, req)).state.statusCode).toBe(200);
  });

  it('a new account NUMBER restarts the list at its editor — a documented limit', async () => {
    const { c } = await company();
    const s = await plantSupplier(pool, c);
    await inRequest(pool, u.b, c, () => updateSupplier(c, s, { bankName: 'Other Bank' }, u.b));
    await inRequest(pool, u.c, c, () => updateSupplier(c, s, { bankAccountNumber: '62888888888' }, u.c));
    expect(await settersOf(s)).toEqual([u.c]);
  });

  it('round 2 MEDIUM: B redirects the account number, an innocent C "corrects" the branch to the universal code, and B stays an author', async () => {
    const { c, bank } = await company();
    const s = await plantSupplier(pool, c);
    await inRequest(pool, u.b, c, () => updateSupplier(c, s, { bankAccountNumber: '62777777777' }, u.b));
    await inRequest(pool, u.c, c, () => updateSupplier(c, s, { bankBranchCode: '632005' }, u.c));
    expect(await settersOf(s)).toEqual([u.b, u.c].sort());
    const p = await plantPayment(pool, c, u.a, bank, { supplierId: s });
    const req = dataOf<{ id: string }>(await r.raise(u.a, c, 'supplier_payment', p.id)).id;
    expect((await r.decide(pool, u.b, c, req)).state.statusCode).toBe(403);
  });

  it('an edit that waited on a concurrent bank change, and changed no bank column itself, sets nobody', async () => {
    const { c } = await company();
    const s = await plantSupplier(pool, c);
    const held = await pool.connect();
    await held.query('BEGIN');
    await held.query("UPDATE suppliers SET bank_account_number = '62555555555' WHERE id = $1", [s]);
    const waiting = inRequest(pool, u.c, c, () => updateSupplier(c, s, { notes: 'just a note' }, u.c));
    await new Promise((resolve) => setTimeout(resolve, 500));
    await held.query('COMMIT');
    held.release();
    await waiting;
    expect(await settersOf(s)).toEqual([]);
  });
});
