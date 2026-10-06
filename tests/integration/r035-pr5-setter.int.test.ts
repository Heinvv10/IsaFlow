/**
 * R-035 PR5, decision (b) (orchestrator, 2026-10-06; Hein's addendum: whoever
 * sets where the money goes is an author): `suppliers.bank_details_set_by` —
 * the last user to change any bank column, or to create the supplier WITH bank
 * details — is DERIVED, live, into the authors of every payment to that
 * supplier and every batch carrying one. So a user who points a supplier's
 * account at themselves BEFORE a colleague creates the payment may not approve
 * it. Set by updateSupplier (the UI route and MCP update_supplier), the supplier
 * take-on (overwrite and new rows) and supplier creation; a write carrying no
 * bank change never touches the column (golden path d creates a supplier with
 * no bank details on a database without migration 867).
 * Known limit (collusion, two people): a later change by someone else to any
 * bank column makes THEM the setter and drops the earlier one.
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

const setterOf = async (supplierId: string) => (await pool.query(
  'SELECT bank_details_set_by AS s FROM suppliers WHERE id = $1', [supplierId])).rows[0].s as string | null;

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
    expect(await setterOf(s)).toBe(u.b);
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
    expect(await setterOf(withBank)).toBe(u.b);
    expect(await setterOf(without)).toBeNull();
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
    expect(await setterOf(s)).toBe(u.c);
    expect(await decideNewPayment(c, bank, s, u.c)).toBe(403);
  });

  it('MCP update_supplier sets the token user', async () => {
    const { c, bank } = await company();
    const s = await plantSupplier(pool, c);
    const registry = new McpRegistry();
    registry.register(updateSupplierTool);
    const res = await inRequest(pool, u.b, c, () => registry.call('update_supplier',
      { supplier_id: s, bank_branch_code: '470010', idempotency_key: crypto.randomUUID() },
      { userId: u.b, companyId: c, scopes: ['write:contacts'], tokenJti: 'r035-pr5', oauthAppId: null }));
    expect(res.isError, JSON.stringify(res)).toBeFalsy();
    expect(await setterOf(s)).toBe(u.b);
    expect(await decideNewPayment(c, bank, s, u.b)).toBe(403);
  });

  it('an edit that changes no bank column sets nobody', async () => {
    const { c } = await company();
    const s = await plantSupplier(pool, c);
    await inRequest(pool, u.b, c, () => updateSupplier(c, s, { notes: 'n', bankName: 'R035 Bank', subjectToDrcVat: true }, u.b));
    expect(await setterOf(s)).toBeNull();
  });

  it('known limit (collusion): a later change by C to another bank column makes C the setter, and C is refused', async () => {
    const { c, bank } = await company();
    const s = await plantSupplier(pool, c);
    await inRequest(pool, u.b, c, () => updateSupplier(c, s, { bankAccountNumber: '62777777777' }, u.b));
    await inRequest(pool, u.c, c, () => updateSupplier(c, s, { bankAccountType: 'savings' }, u.c));
    expect(await setterOf(s)).toBe(u.c);
    const p = await plantPayment(pool, c, u.a, bank, { supplierId: s });
    const req = dataOf<{ id: string }>(await r.raise(u.a, c, 'supplier_payment', p.id)).id;
    expect((await r.decide(pool, u.c, c, req)).state.statusCode).toBe(403);
    expect((await r.decide(pool, u.b, c, req)).state.statusCode).toBe(200);
  });
});
