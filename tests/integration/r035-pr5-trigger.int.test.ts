/**
 * R-035 PR5: the backstop triggers of migration 867 — the fail-closed floor
 * under every writer the TypeScript gate does not see (raw SQL, scripts).
 * A supplier payment may not ENTER approved / processed / reconciled (nor go
 * approved -> processed), and a batch may not enter approved / processed,
 * without a cleared approval of the governing document: the payment's own
 * for a single payment, its BATCH's for a member. Only an INSERT of a single
 * payment under the bank-feed or import GUC is exempt (Q4, Q1).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { createUser, plantRule } from './r035-approval.helpers';
import { asAppUser } from './r035-pr4.helpers';
import { cleanupPr5, enforcePay, payCompany, payRoutes, plantBatch, plantPayment, plantSupplier } from './r035-pr5.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
const u = { a: '', b: '', m: '' };
const r = payRoutes(tokens);

beforeAll(async () => {
  for (const k of Object.keys(u) as (keyof typeof u)[]) u[k] = await createUser(pool, tokens);
});
afterAll(() => cleanupPr5(pool, companies, Object.values(u)));

async function enforced(type: 'supplier_payment' | 'payment_batch' = 'supplier_payment', rule = 'owner') {
  const { company: c, bank } = await payCompany(pool, [[u.a, 'admin'], [u.b, 'owner'], [u.m, 'manager']], companies);
  await plantRule(pool, c, rule, { documentType: type });
  await enforcePay(pool, c, type, u.b);
  return { c, bank };
}

/** The outcome of `sql` as the session writer (app_user under A's claims) or as the owner. */
async function attempt(c: string, as: 'app_user' | 'owner', write: (db: PoolClient) => Promise<unknown>): Promise<string> {
  try {
    if (as === 'app_user') await asAppUser(pool, u.a, c, write);
    else {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await write(client);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    }
    return 'written';
  } catch (e) {
    return (e as Error).message;
  }
}
const REFUSED = /^R035_APPROVAL_REQUIRED/;
const setStatus = (id: string, status: string) => (db: PoolClient) =>
  db.query('UPDATE supplier_payments SET status = $2 WHERE id = $1', [id, status]);

describe('supplier_payments', () => {
  it.each(['app_user', 'owner'] as const)('a raw draft -> approved and -> processed are refused as %s', async (as) => {
    const { c, bank } = await enforced();
    const p = await plantPayment(pool, c, u.a, bank);
    expect(await attempt(c, as, setStatus(p.id, 'approved'))).toMatch(REFUSED);
    expect(await attempt(c, as, setStatus(p.id, 'processed'))).toMatch(REFUSED);
  });

  it('approved -> processed is refused for an approval from before enforcement; draft -> cancelled is not', async () => {
    const { company: c, bank } = await payCompany(pool, [[u.a, 'admin'], [u.b, 'owner']], companies);
    await plantRule(pool, c, 'owner', { documentType: 'supplier_payment' });
    const p = await plantPayment(pool, c, u.a, bank, { status: 'approved' });
    const q = await plantPayment(pool, c, u.a, bank);
    await enforcePay(pool, c, 'supplier_payment', u.b);
    expect(await attempt(c, 'app_user', setStatus(p.id, 'processed'))).toMatch(REFUSED);
    expect(await attempt(c, 'app_user', setStatus(q.id, 'cancelled'))).toBe('written');
  });

  it('processed <-> reconciled (applying cash already paid) passes', async () => {
    const { company: c, bank } = await payCompany(pool, [[u.a, 'admin'], [u.b, 'owner']], companies);
    await plantRule(pool, c, 'owner', { documentType: 'supplier_payment' });
    const p = await plantPayment(pool, c, u.a, bank, { status: 'processed' });
    await enforcePay(pool, c, 'supplier_payment', u.b);
    expect(await attempt(c, 'app_user', setStatus(p.id, 'reconciled'))).toBe('written');
    expect(await attempt(c, 'app_user', setStatus(p.id, 'processed'))).toBe('written');
  });

  it('a cleared approval at rank lets the raw write through; the ratchet refuses a lower one', async () => {
    const { c, bank } = await enforced('supplier_payment', 'manager');
    const p = await plantPayment(pool, c, u.a, bank);
    await r.approvedBy(pool, u.a, u.m, c, 'supplier_payment', p.id);
    await plantRule(pool, c, 'owner', { documentType: 'supplier_payment' });
    expect(await attempt(c, 'app_user', setStatus(p.id, 'approved'))).toMatch(REFUSED);
    await pool.query("UPDATE approval_rules SET is_active = false WHERE company_id = $1 AND approver_role = 'owner'", [c]);
    expect(await attempt(c, 'app_user', setStatus(p.id, 'approved'))).toBe('written');
  });

  it('enforcement off, or no rule matching: raw writes pass', async () => {
    const { company: c, bank } = await payCompany(pool, [[u.a, 'admin']], companies);
    await plantRule(pool, c, 'owner', { documentType: 'supplier_payment' });
    const p = await plantPayment(pool, c, u.a, bank);
    expect(await attempt(c, 'app_user', setStatus(p.id, 'approved'))).toBe('written');
    const { c: c2, bank: bank2 } = await enforced();
    await pool.query("UPDATE approval_rules SET condition_operator = 'greater_than', condition_value = 5000 WHERE company_id = $1", [c2]);
    const q = await plantPayment(pool, c2, u.a, bank2);
    expect(await attempt(c2, 'app_user', setStatus(q.id, 'approved'))).toBe('written');
  });

  const insertProcessed = (c: string, supplierId: string, guc: string | null, batchId: string | null = null) =>
    async (db: PoolClient) => {
      if (guc !== null) await db.query("SELECT set_config('isaflow.approval_gate_exempt', $1, true)", [guc]);
      await db.query(
        `INSERT INTO supplier_payments(company_id,supplier_id,payment_date,total_amount,payment_method,status,batch_id,created_by)
         VALUES($1,$2,DATE '2026-09-01',1150,'eft','processed',$3,$4)`, [c, supplierId, batchId, u.a]);
    };

  it("an INSERT straight to 'processed' passes only under the bank-feed or import GUC", async () => {
    const { c } = await enforced();
    const s = await plantSupplier(pool, c);
    expect(await attempt(c, 'app_user', insertProcessed(c, s, null))).toMatch(REFUSED);
    expect(await attempt(c, 'app_user', insertProcessed(c, s, 'something'))).toMatch(REFUSED);
    expect(await attempt(c, 'app_user', insertProcessed(c, s, 'bank_feed'))).toBe('written');
    expect(await attempt(c, 'app_user', insertProcessed(c, s, 'import'))).toBe('written');
  });

  it('the GUC never exempts an UPDATE, nor an INSERT of a batch member', async () => {
    const { c, bank } = await enforced('supplier_payment');
    await enforcePay(pool, c, 'payment_batch', u.b);
    await plantRule(pool, c, 'owner', { documentType: 'payment_batch' });
    const p = await plantPayment(pool, c, u.a, bank);
    expect(await attempt(c, 'app_user', async (db) => {
      await db.query("SELECT set_config('isaflow.approval_gate_exempt', 'bank_feed', true)");
      await setStatus(p.id, 'processed')(db);
    })).toMatch(REFUSED);
    const b = await plantBatch(pool, c, u.a, bank);
    expect(await attempt(c, 'app_user', insertProcessed(c, b.members[0]!.supplierId, 'bank_feed', b.id))).toMatch(REFUSED);
  });
});

describe('batch members and batches', () => {
  it('a member entering approved is judged by its BATCH: refused until the batch is approved', async () => {
    const { c, bank } = await enforced('payment_batch');
    const b = await plantBatch(pool, c, u.a, bank);
    expect(await attempt(c, 'app_user', setStatus(b.members[0]!.id, 'approved'))).toMatch(/batch member .* of batch /);
    await r.approvedBy(pool, u.a, u.b, c, 'payment_batch', b.id);
    expect(await attempt(c, 'app_user', setStatus(b.members[0]!.id, 'approved'))).toBe('written');
  });

  it('with both types enforced, a member is still judged as its batch, never as a supplier_payment', async () => {
    const { c, bank } = await enforced('payment_batch');
    const b = await plantBatch(pool, c, u.a, bank);
    await enforcePay(pool, c, 'supplier_payment', u.b);
    expect(await attempt(c, 'owner', setStatus(b.members[0]!.id, 'processed'))).toMatch(REFUSED);
  });

  it.each(['app_user', 'owner'] as const)('a raw batch draft -> approved and approved -> processed are refused as %s', async (as) => {
    const { c, bank } = await enforced('payment_batch');
    const b = await plantBatch(pool, c, u.a, bank);
    const batch = (status: string) => (db: PoolClient) =>
      db.query('UPDATE supplier_payment_batches SET status = $2 WHERE id = $1', [b.id, status]);
    expect(await attempt(c, as, batch('approved'))).toMatch(REFUSED);
    expect(await attempt(c, as, batch('processed'))).toMatch(REFUSED);
    expect(await attempt(c, as, batch('cancelled'))).toBe('written');
  });

  it('the batch trigger honours no GUC', async () => {
    const { c, bank } = await enforced('payment_batch');
    const b = await plantBatch(pool, c, u.a, bank);
    expect(await attempt(c, 'app_user', async (db) => {
      await db.query("SELECT set_config('isaflow.approval_gate_exempt', 'import', true)");
      await db.query("UPDATE supplier_payment_batches SET status = 'approved' WHERE id = $1", [b.id]);
    })).toMatch(REFUSED);
  });
});
