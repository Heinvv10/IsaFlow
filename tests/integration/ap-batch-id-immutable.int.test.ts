/**
 * supplier_payments.batch_id is fixed at INSERT: a payment joins a batch only by
 * being created with it (createBatch). Re-pointing one later would let a batch's
 * approval digest, lock order and totals be judged against a membership that
 * changed underneath it. Migration 914 refuses every UPDATE that changes it,
 * whatever the statement shape; the batch flows never need to.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { createUser } from './r035-approval.helpers';
import { batchState, cleanupPr5, inRequest, payCompany, plantBatch, plantBill, plantPayment, plantSupplier } from './r035-pr5.helpers';
import {
  approveBatch, cancelBatch, createBatch, processBatch,
} from '@/modules/accounting/services/ap/batchPaymentService';
import { reverseBatch } from '@/modules/accounting/services/ap/batchPaymentReversal';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let user = '';

beforeAll(async () => { user = await createUser(pool, tokens); });
afterAll(async () => { await cleanupPr5(pool, companies, [user]); });

const REFUSED = /supplier_payments\.batch_id is immutable/;

async function fixture() {
  const { company, bank } = await payCompany(pool, [[user, 'admin']], companies);
  const a = await plantBatch(pool, company, user, bank);
  const b = await plantBatch(pool, company, user, bank);
  return { company, bank, a, b, member: a.members[0]!.id };
}
const batchOf = async (id: string) =>
  (await pool.query('SELECT batch_id FROM supplier_payments WHERE id = $1', [id])).rows[0].batch_id as string | null;

/** A real createBatch of one bill, driven the way the route drives it. */
async function created(company: string, bank: string) {
  const supplierId = await plantSupplier(pool, company);
  const billId = await plantBill(pool, company, supplierId, user);
  const batch = await inRequest(pool, user, company, () => createBatch(company, {
    batchDate: '2026-09-01', bankAccountId: bank,
    payments: [{ supplierId, invoiceAllocations: [{ invoiceId: billId, amount: 1000 }] }],
  }, user));
  return batch.id;
}

describe('every UPDATE that changes batch_id is refused', () => {
  it('plain UPDATE to another batch', async () => {
    const { a, b, member } = await fixture();
    await expect(pool.query('UPDATE supplier_payments SET batch_id = $1 WHERE id = $2', [b.id, member])).rejects.toThrow(REFUSED);
    expect(await batchOf(member)).toBe(a.id);
  });

  it('SET NULL', async () => {
    const { a, member } = await fixture();
    await expect(pool.query('UPDATE supplier_payments SET batch_id = NULL WHERE id = $1', [member])).rejects.toThrow(REFUSED);
    expect(await batchOf(member)).toBe(a.id);
  });

  it('attaching a batch-less payment', async () => {
    const { company, bank, a } = await fixture();
    const loose = await plantPayment(pool, company, user, bank);
    await expect(pool.query('UPDATE supplier_payments SET batch_id = $1 WHERE id = $2', [a.id, loose.id])).rejects.toThrow(REFUSED);
    expect(await batchOf(loose.id)).toBeNull();
  });

  it('aliased UPDATE', async () => {
    const { b, member } = await fixture();
    await expect(pool.query('UPDATE supplier_payments AS sp SET batch_id = $1 WHERE sp.id = $2', [b.id, member])).rejects.toThrow(REFUSED);
  });

  it('UPDATE ... FROM', async () => {
    const { a, b } = await fixture();
    await expect(pool.query(
      'UPDATE supplier_payments sp SET batch_id = nb.id FROM supplier_payment_batches nb WHERE nb.id = $1 AND sp.batch_id = $2',
      [b.id, a.id])).rejects.toThrow(REFUSED);
  });

  it('UPDATE of every member of a batch in one statement', async () => {
    const { a, b } = await fixture();
    await expect(pool.query('UPDATE supplier_payments SET batch_id = $1 WHERE batch_id = $2', [b.id, a.id])).rejects.toThrow(REFUSED);
    expect((await batchState(pool, a.id)).members).toHaveLength(2);
  });

  it('INSERT ... ON CONFLICT DO UPDATE', async () => {
    const { company, bank, b, member } = await fixture();
    const sp = (await pool.query('SELECT supplier_id, total_amount FROM supplier_payments WHERE id = $1', [member])).rows[0];
    await expect(pool.query(
      `INSERT INTO supplier_payments(id, company_id, supplier_id, payment_date, total_amount, payment_method, status, batch_id, created_by)
       VALUES($1,$2,$3,DATE '2026-09-01',$4,'eft','draft',$5,$6)
       ON CONFLICT (id) DO UPDATE SET batch_id = EXCLUDED.batch_id`,
      [member, company, sp.supplier_id, sp.total_amount, b.id, user])).rejects.toThrow(REFUSED);
    void bank;
  });

  it('MERGE', async () => {
    const { b, member } = await fixture();
    await expect(pool.query(
      `MERGE INTO supplier_payments sp USING (SELECT $1::uuid AS id, $2::uuid AS batch_id) s ON sp.id = s.id
       WHEN MATCHED THEN UPDATE SET batch_id = s.batch_id`, [member, b.id])).rejects.toThrow(REFUSED);
  });

  it('is a clear, catchable constraint-family error naming the lock order', async () => {
    const { b, member } = await fixture();
    const err = await pool.query('UPDATE supplier_payments SET batch_id = $1 WHERE id = $2', [b.id, member]).catch((e) => e);
    expect(err.code).toBe('23000');
    expect(err.message).toMatch(/lock order/i);
  });
});

describe('what stays allowed', () => {
  it('other columns, including status', async () => {
    const { member } = await fixture();
    await pool.query("UPDATE supplier_payments SET reference = 'x', status = 'cancelled' WHERE id = $1", [member]);
    expect((await pool.query('SELECT status FROM supplier_payments WHERE id = $1', [member])).rows[0].status).toBe('cancelled');
  });

  it('setting batch_id to the value it already has', async () => {
    const { a, member } = await fixture();
    await pool.query('UPDATE supplier_payments SET batch_id = $1 WHERE id = $2', [a.id, member]);
    expect(await batchOf(member)).toBe(a.id);
  });

  it('a batch-less payment keeps NULL when NULL is written', async () => {
    const { company, bank } = await fixture();
    const loose = await plantPayment(pool, company, user, bank);
    await pool.query('UPDATE supplier_payments SET batch_id = NULL WHERE id = $1', [loose.id]);
    expect(await batchOf(loose.id)).toBeNull();
  });

  it('INSERT with a batch_id', async () => {
    const { company, bank, a } = await fixture();
    const extra = await plantPayment(pool, company, user, bank, { batchId: a.id });
    expect(await batchOf(extra.id)).toBe(a.id);
  });
});

describe('the batch flows never re-point a member', () => {
  it('createBatch -> approve -> process', async () => {
    const { company, bank } = await fixture();
    const id = await created(company, bank);
    await inRequest(pool, user, company, async () => { await approveBatch(company, id, user); await processBatch(company, id, user); });
    expect(await batchState(pool, id)).toMatchObject({ status: 'processed', members: ['processed'], journals: 1 });
  });

  it('createBatch -> cancel keeps the members in the batch', async () => {
    const { company, bank } = await fixture();
    const id = await created(company, bank);
    await inRequest(pool, user, company, () => cancelBatch(company, id));
    expect(await batchState(pool, id)).toMatchObject({ status: 'cancelled', members: ['cancelled'] });
  });

  it('process -> reverse keeps the members in the batch', async () => {
    const { company, bank } = await fixture();
    const id = await created(company, bank);
    await inRequest(pool, user, company, async () => { await approveBatch(company, id, user); await processBatch(company, id, user); });
    await inRequest(pool, user, company, () => reverseBatch(company, id, user));
    expect((await batchState(pool, id)).members).toHaveLength(1);
    expect((await pool.query('SELECT count(*)::INT AS n FROM supplier_payments WHERE batch_id = $1', [id])).rows[0].n).toBe(1);
  });
});
