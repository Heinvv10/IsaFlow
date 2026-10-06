/**
 * R-035 PR5: who may NOT approve paying a supplier (Hein, 2026-10-06: whoever
 * sets the amount or the destination of the money is an author). A payment's
 * authors are its creator, the authors of every bill it pays (DERIVED from
 * payment_allocations), whoever merged its supplier and whoever changed its
 * payee's bank details while it was unpaid (STAMPED by those edits). A batch's
 * are its creator, its stamped editors and every member's authors. The
 * requester and every author are refused at decide; a member nobody authored
 * approves; the sole approver may still approve their own request (Q2).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import supplierMerge from '../../pages/api/accounting/supplier-merge';
import migrationSuppliers from '../../pages/api/accounting/migration/suppliers';
import { updateSupplier } from '@/modules/accounting/services/core/supplierWriteService';
import { mergeEntities } from '@/modules/accounting/services/core/duplicateMergeService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser, plantRule } from './r035-approval.helpers';
import { dataOf, messageOf } from './r035-pr2.helpers';
import {
  authorsOf, cleanupPr5, enforcePay, inRequest, payCompany, payRoutes, plantBatch, plantPayment, plantSupplier, type PayType,
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
  await cleanupPr5(pool, companies, Object.values(u));
});

/** A admin requests; B, C and D are owners; an owner rule governs both types under enforcement. */
async function company() {
  const { company: c, bank } = await payCompany(pool, [[u.a, 'admin'], [u.b, 'owner'], [u.c, 'owner'], [u.d, 'owner']], companies);
  for (const type of ['supplier_payment', 'payment_batch'] as const) {
    await plantRule(pool, c, 'owner', { documentType: type });
    await enforcePay(pool, c, type, u.b);
  }
  return { c, bank };
}

const raise = async (c: string, type: PayType, id: string) => dataOf<{ id: string }>(await r.raise(u.a, c, type, id)).id;
const decided = async (c: string, user: string, requestId: string) => (await r.decide(pool, user, c, requestId)).state.statusCode;

describe('derived authors', () => {
  it("a payment's authors are its creator and its bills' authors; a batch's add every member's", async () => {
    const { c, bank } = await company();
    const p = await plantPayment(pool, c, u.b, bank, { billBy: u.c });
    expect((await authorsOf(pool, c, 'supplier_payment', p.id))!.sort()).toEqual([u.b, u.c].sort());
    const b = await plantBatch(pool, c, u.d, bank);
    await pool.query('UPDATE supplier_invoices SET created_by = $2 WHERE id = $1', [b.members[1]!.billId, u.c]);
    expect((await authorsOf(pool, c, 'payment_batch', b.id))!.sort()).toEqual([u.c, u.d].sort());
  });

  it("the bill's capturer is refused as the payment's approver; a member who wrote nothing approves", async () => {
    const { c, bank } = await company();
    const p = await plantPayment(pool, c, u.a, bank, { billBy: u.c });
    const req = await raise(c, 'supplier_payment', p.id);
    expect(await decided(c, u.c, req)).toBe(403);
    expect(await decided(c, u.b, req)).toBe(200);
  });

  it("a member's bill author is refused as the batch's approver", async () => {
    const { c, bank } = await company();
    const b = await plantBatch(pool, c, u.a, bank);
    await pool.query('UPDATE supplier_invoices SET created_by = $2 WHERE id = $1', [b.members[0]!.billId, u.c]);
    const req = await raise(c, 'payment_batch', b.id);
    const res = await r.decide(pool, u.c, c, req);
    expect(res.state.statusCode).toBe(403);
    expect(messageOf(res)).toMatch(/you created the batch, merged a supplier it pays/);
    expect(await decided(c, u.b, req)).toBe(200);
  });
});

describe('stamped editors', () => {
  it('an approval taken before a bank-detail edit is STALE at process, and the editor may not approve it again', async () => {
    const { c, bank } = await company();
    const p = await plantPayment(pool, c, u.a, bank);
    await r.approvedBy(pool, u.a, u.b, c, 'supplier_payment', p.id);
    expect((await r.payment(u.a, c, 'approve', p.id)).state.statusCode).toBe(200);
    await inRequest(pool, u.c, c, () => updateSupplier(c, p.supplierId, { bankAccountNumber: '62999999999' }, u.c));
    const stale = await r.payment(u.a, c, 'process', p.id);
    expect(stale.state.statusCode).toBe(409);
    const req = await raise(c, 'supplier_payment', p.id);
    expect(await decided(c, u.c, req)).toBe(403);
    expect(await decided(c, u.d, req)).toBe(200);
    expect((await r.payment(u.a, c, 'process', p.id)).state.statusCode).toBe(200);
  });

  it('a bank-detail edit stamps every unpaid payment and batch to the supplier, never a paid one; a non-bank edit stamps none', async () => {
    // Stamping does not depend on enforcement; without it a paid payment can be planted directly.
    const { company: c, bank } = await payCompany(pool, [[u.a, 'admin'], [u.c, 'owner'], [u.d, 'owner']], companies);
    const s = await plantSupplier(pool, c);
    const draft = await plantPayment(pool, c, u.a, bank, { supplierId: s });
    const paid = await plantPayment(pool, c, u.a, bank, { supplierId: s, status: 'processed' });
    const b = await plantBatch(pool, c, u.a, bank);
    await pool.query('UPDATE supplier_payments SET supplier_id = $2 WHERE id = $1', [b.members[0]!.id, s]);
    const stamps = async () => (await pool.query(
      `SELECT (SELECT content_authors FROM supplier_payments WHERE id = $1) AS draft,
              (SELECT content_authors FROM supplier_payments WHERE id = $2) AS paid,
              (SELECT content_authors FROM supplier_payment_batches WHERE id = $3) AS batch`, [draft.id, paid.id, b.id])).rows[0];
    await inRequest(pool, u.d, c, () => updateSupplier(c, s, { notes: 'just a note', bankName: 'R035 Bank' }, u.d));
    expect(await stamps()).toEqual({ draft: [], paid: [], batch: [] });
    await inRequest(pool, u.c, c, () => updateSupplier(c, s, { bankBranchCode: '198765' }, u.c));
    expect(await stamps()).toEqual({ draft: [u.c], paid: [], batch: [u.c] });
  });

  it('the supplier take-on overwrite that changes bank details stamps its importer', async () => {
    const { c, bank } = await company();
    const p = await plantPayment(pool, c, u.a, bank);
    const name = (await pool.query('SELECT name FROM suppliers WHERE id = $1', [p.supplierId])).rows[0].name;
    const session = (await pool.query(
      'INSERT INTO migration_sessions(company_id, started_by) VALUES($1,$2) RETURNING id', [c, u.c])).rows[0].id;
    const res = await callRoute(migrationSuppliers, tokens[u.c]!, c, 'POST', {
      sessionId: session, duplicateStrategy: 'overwrite', suppliers: [{ name, bankAccountNumber: '62111111111' }],
    }, '/api/accounting/migration/suppliers');
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    expect((await pool.query('SELECT content_authors FROM supplier_payments WHERE id = $1', [p.id])).rows[0].content_authors).toEqual([u.c]);
  });

  it('a supplier merge stamps the merging user onto the moved payment and its batch', async () => {
    const { c, bank } = await company();
    const p = await plantPayment(pool, c, u.a, bank);
    const b = await plantBatch(pool, c, u.a, bank);
    const target = await plantSupplier(pool, c);
    for (const source of [p.supplierId, b.members[0]!.supplierId]) {
      const res = await callRoute(supplierMerge, tokens[u.c]!, c, 'POST', { source_id: source, target_id: target },
        '/api/accounting/supplier-merge');
      expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    }
    const { rows } = await pool.query(
      `SELECT (SELECT content_authors FROM supplier_payments WHERE id = $1) AS payment,
              (SELECT content_authors FROM supplier_payment_batches WHERE id = $2) AS batch`, [p.id, b.id]);
    expect(rows[0]).toEqual({ payment: [u.c], batch: [u.c] });
    const req = await raise(c, 'payment_batch', b.id);
    expect(await decided(c, u.c, req)).toBe(403);
  });
  it('the duplicate-merge wizard stamps the merging user onto the moved payment and its batch too', async () => {
    const { c, bank } = await company();
    const b = await plantBatch(pool, c, u.a, bank);
    const target = await plantSupplier(pool, c);
    await inRequest(pool, u.d, c, () => mergeEntities(c, 'supplier', target, b.members[0]!.supplierId, u.d));
    const { rows } = await pool.query(
      `SELECT (SELECT content_authors FROM supplier_payments WHERE id = $1) AS payment,
              (SELECT content_authors FROM supplier_payment_batches WHERE id = $2) AS batch`, [b.members[0]!.id, b.id]);
    expect(rows[0]).toEqual({ payment: [u.d], batch: [u.d] });
  });
});

describe('the sole approver (Q2)', () => {
  it('a company with one owner: the owner creates, raises and approves their own payment, then pays it', async () => {
    const { company: c, bank } = await payCompany(pool, [[u.b, 'owner']], companies);
    await plantRule(pool, c, 'owner', { documentType: 'supplier_payment' });
    await enforcePay(pool, c, 'supplier_payment', u.b);
    const p = await plantPayment(pool, c, u.b, bank);
    const req = dataOf<{ id: string }>(await r.raise(u.b, c, 'supplier_payment', p.id)).id;
    expect(await decided(c, u.b, req)).toBe(200);
    expect((await r.payment(u.b, c, 'approve', p.id)).state.statusCode).toBe(200);
    expect((await r.payment(u.b, c, 'process', p.id)).state.statusCode).toBe(200);
  });
});
