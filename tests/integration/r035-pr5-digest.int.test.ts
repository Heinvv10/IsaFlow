/**
 * R-035 PR5: approval_document_digest() for `supplier_payment` and
 * `payment_batch` (migration 867). An approval binds WHAT is paid and WHERE
 * the money goes: every hashed column — including the payee's LIVE bank
 * details, which the payment does not copy and the money follows, and every
 * allocation — moves the digest; bookkeeping columns do not; a batch's digest
 * covers every member line, so changing, adding or removing a line voids its
 * approval; identical content digests identically again (Q9).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { createUser } from './r035-approval.helpers';
import { cleanupPr5, digestOf, payCompany, plantBatch, plantBill, plantPayment, plantSupplier } from './r035-pr5.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let a = '';
let fx: { company: string; bank: string; ap: string; otherSupplier: string };

beforeAll(async () => {
  a = await createUser(pool, tokens);
  const { company, bank } = await payCompany(pool, [[a, 'admin']], companies);
  const ap = (await pool.query("SELECT id FROM gl_accounts WHERE company_id = $1 AND account_subtype = 'payable'", [company])).rows[0].id;
  fx = { company, bank, ap, otherSupplier: await plantSupplier(pool, company) };
});
afterAll(() => cleanupPr5(pool, companies, [a]));

/** Run `edit` in a transaction that is always rolled back; answer the digest before and after it. */
async function moved(type: 'supplier_payment' | 'payment_batch', id: string, edit: (c: PoolClient) => Promise<unknown>) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const before = await digestOf(client, fx.company, type, id);
    await edit(client);
    const after = await digestOf(client, fx.company, type, id);
    expect(before).toMatch(/^[0-9a-f]{64}$/);
    return before !== after;
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

const sp = (set: string) => (id: string, extra: unknown[] = []) => (c: PoolClient) =>
  c.query(`UPDATE supplier_payments SET ${set} WHERE id = $1`, [id, ...extra]);
const supplier = (set: string) => (supplierId: string) => (c: PoolClient) =>
  c.query(`UPDATE suppliers SET ${set} WHERE id = $1`, [supplierId]);

describe('supplier_payment', () => {
  it('is a sha256 for a single payment, and NULL for a batch member, another company or no payment', async () => {
    const p = await plantPayment(pool, fx.company, a, fx.bank);
    const b = await plantBatch(pool, fx.company, a, fx.bank);
    expect(await digestOf(pool, fx.company, 'supplier_payment', p.id)).toMatch(/^[0-9a-f]{64}$/);
    expect(await digestOf(pool, fx.company, 'supplier_payment', b.members[0]!.id)).toBeNull();
    expect(await digestOf(pool, crypto.randomUUID(), 'supplier_payment', p.id)).toBeNull();
    expect(await digestOf(pool, fx.company, 'supplier_payment', crypto.randomUUID())).toBeNull();
  });

  it.each([
    ['supplier_id', (id: string) => sp('supplier_id = $2')(id, [fx.otherSupplier])],
    ['payment_date', (id: string) => sp("payment_date = DATE '2026-09-02'")(id)],
    ['total_amount', (id: string) => sp('total_amount = 1150.01')(id)],
    ['payment_method', (id: string) => sp("payment_method = 'cheque'")(id)],
    ['bank_account_id', (id: string) => sp('bank_account_id = $2')(id, [fx.ap])],
    ['reference', (id: string) => sp("reference = 'other'")(id)],
    ['project_id', (id: string) => sp('project_id = gen_random_uuid()')(id)],
    ['cost_center_id', (id: string) => sp('cost_center_id = gen_random_uuid()')(id)],
  ])('%s moves it', async (_column, edit) => {
    const p = await plantPayment(pool, fx.company, a, fx.bank);
    expect(await moved('supplier_payment', p.id, edit(p.id))).toBe(true);
  });

  it.each(['bank_name', 'bank_account_number', 'bank_branch_code', 'bank_account_type', 'bank_account_holder'])(
    "the payee's live %s moves it", async (column) => {
      const p = await plantPayment(pool, fx.company, a, fx.bank);
      expect(await moved('supplier_payment', p.id, supplier(`${column} = ${column} || 'x'`)(p.supplierId))).toBe(true);
    });

  it('an allocation amount, a re-pointed allocation, an added and a removed allocation each move it', async () => {
    const p = await plantPayment(pool, fx.company, a, fx.bank);
    const bill = await plantBill(pool, fx.company, p.supplierId, a);
    expect(await moved('supplier_payment', p.id, (c) =>
      c.query('UPDATE payment_allocations SET amount_allocated = 1000 WHERE payment_id = $1', [p.id]))).toBe(true);
    expect(await moved('supplier_payment', p.id, (c) =>
      c.query('UPDATE payment_allocations SET invoice_id = $2 WHERE payment_id = $1', [p.id, bill]))).toBe(true);
    expect(await moved('supplier_payment', p.id, (c) =>
      c.query('INSERT INTO payment_allocations(payment_id,invoice_id,amount_allocated) VALUES($1,$2,1)', [p.id, bill]))).toBe(true);
    expect(await moved('supplier_payment', p.id, (c) =>
      c.query('DELETE FROM payment_allocations WHERE payment_id = $1', [p.id]))).toBe(true);
  });

  it('bookkeeping does not move it: status, description, approval and journal stamps, number, authors, payee name and email', async () => {
    const p = await plantPayment(pool, fx.company, a, fx.bank);
    expect(await moved('supplier_payment', p.id, async (c) => {
      await c.query(
        `UPDATE supplier_payments SET status = 'approved', description = 'x', approved_by = created_by, approved_at = now(),
           processed_at = now(), payment_number = payment_number || 'x', updated_at = now() - interval '1 day',
           content_authors = ARRAY[created_by] WHERE id = $1`, [p.id]);
      await c.query("UPDATE suppliers SET name = name || 'x', email = 'x@y.z' WHERE id = $1", [p.supplierId]);
    })).toBe(false);
  });

  it('re-inserting identical allocations, and 1150 vs 1150.00, digest identically (Q9)', async () => {
    const p = await plantPayment(pool, fx.company, a, fx.bank);
    expect(await moved('supplier_payment', p.id, async (c) => {
      await c.query('DELETE FROM payment_allocations WHERE payment_id = $1', [p.id]);
      await c.query('INSERT INTO payment_allocations(payment_id,invoice_id,amount_allocated) VALUES($1,$2,1150.00)', [p.id, p.billId]);
      await c.query('UPDATE supplier_payments SET total_amount = 1150.000 WHERE id = $1', [p.id]);
    })).toBe(false);
  });
});

describe('payment_batch', () => {
  it('is a sha256 for a batch of this company, NULL for another company', async () => {
    const b = await plantBatch(pool, fx.company, a, fx.bank);
    expect(await digestOf(pool, fx.company, 'payment_batch', b.id)).toMatch(/^[0-9a-f]{64}$/);
    expect(await digestOf(pool, crypto.randomUUID(), 'payment_batch', b.id)).toBeNull();
  });

  it.each([
    ['batch_date', "batch_date = DATE '2026-09-02'"],
    ['payment_method', "payment_method = 'cheque'"],
    ['total_amount', 'total_amount = total_amount + 1'],
  ])('the header %s moves it', async (_column, set) => {
    const b = await plantBatch(pool, fx.company, a, fx.bank);
    expect(await moved('payment_batch', b.id, (c) =>
      c.query(`UPDATE supplier_payment_batches SET ${set} WHERE id = $1`, [b.id]))).toBe(true);
  });

  it('the header bank_account_id moves it', async () => {
    const b = await plantBatch(pool, fx.company, a, fx.bank);
    expect(await moved('payment_batch', b.id, (c) =>
      c.query('UPDATE supplier_payment_batches SET bank_account_id = $2 WHERE id = $1', [b.id, fx.ap]))).toBe(true);
  });

  it.each([
    ['payee', 'supplier_id = $2'], ['amount', 'total_amount = total_amount + 1'],
    ['date', "payment_date = DATE '2026-09-02'"], ['reference', "reference = 'other'"],
  ])("a member line's %s moves it", async (_what, set) => {
    const b = await plantBatch(pool, fx.company, a, fx.bank);
    const params = set.includes('$2') ? [b.members[1]!.id, fx.otherSupplier] : [b.members[1]!.id];
    expect(await moved('payment_batch', b.id, (c) => c.query(`UPDATE supplier_payments SET ${set} WHERE id = $1`, params))).toBe(true);
  });

  it("a member's allocation, and a member payee's live bank account number, move it", async () => {
    const b = await plantBatch(pool, fx.company, a, fx.bank);
    expect(await moved('payment_batch', b.id, (c) =>
      c.query('UPDATE payment_allocations SET amount_allocated = 1 WHERE payment_id = $1', [b.members[0]!.id]))).toBe(true);
    expect(await moved('payment_batch', b.id, supplier("bank_account_number = '999'")(b.members[1]!.supplierId))).toBe(true);
  });

  it('adding a member line and removing one each move it', async () => {
    const b = await plantBatch(pool, fx.company, a, fx.bank);
    expect(await moved('payment_batch', b.id, (c) =>
      plantPayment(c, fx.company, a, fx.bank, { batchId: b.id, amount: 10 }))).toBe(true);
    expect(await moved('payment_batch', b.id, async (c) => {
      await c.query('DELETE FROM payment_allocations WHERE payment_id = $1', [b.members[0]!.id]);
      await c.query('DELETE FROM supplier_payments WHERE id = $1', [b.members[0]!.id]);
    })).toBe(true);
  });

  it('bookkeeping does not move it: notes, status, processor, member statuses and member ids (Q9)', async () => {
    const b = await plantBatch(pool, fx.company, a, fx.bank);
    const m = b.members[0]!;
    expect(await moved('payment_batch', b.id, async (c) => {
      await c.query(
        `UPDATE supplier_payment_batches SET notes = 'x', status = 'approved', processed_by = created_by, processed_at = now(),
           content_authors = ARRAY[created_by] WHERE id = $1`, [b.id]);
      await c.query("UPDATE supplier_payments SET status = 'approved' WHERE batch_id = $1", [b.id]);
      // The same line under a new id: identical content digests identically.
      const { rows: [old] } = await c.query('SELECT * FROM supplier_payments WHERE id = $1', [m.id]);
      await c.query('DELETE FROM payment_allocations WHERE payment_id = $1', [m.id]);
      await c.query('DELETE FROM supplier_payments WHERE id = $1', [m.id]);
      const { rows: [again] } = await c.query(
        `INSERT INTO supplier_payments(company_id,supplier_id,payment_date,total_amount,payment_method,reference,status,batch_id,created_by)
         VALUES($1,$2,$3,$4,$5,$6,'draft',$7,$8) RETURNING id`,
        [old.company_id, old.supplier_id, old.payment_date, old.total_amount, old.payment_method, old.reference, b.id, old.created_by]);
      await c.query('INSERT INTO payment_allocations(payment_id,invoice_id,amount_allocated) VALUES($1,$2,$3)',
        [again.id, m.billId, old.total_amount]);
    })).toBe(false);
  });
});
