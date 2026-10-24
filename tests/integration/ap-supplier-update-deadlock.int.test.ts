/**
 * Supplier <-> single-payment lock order (40P01 on a supplier update, found by #812's stress run).
 *
 * The cycle, read off the server log (log_lock_waits, deadlock_timeout 200ms):
 *   processSupplierPayment: payment FOR UPDATE (lockSupplierPaymentForUpdate) -> claim UPDATE -> journal ->
 *     UPDATE supplier_payments SET gl_journal_entry_id. The row's live version is now this transaction's own (the
 *     claim wrote it), so Postgres re-runs the supplier FK check: FOR KEY SHARE on the payee's suppliers row.
 *   updateSupplier (a bank-detail or name edit): batches -> supplier FOR UPDATE (lockSupplierBankDetails) ->
 *     recordBankDetailsSetter's SELECT ... FROM supplier_payments ... FOR UPDATE on the supplier's approved payments.
 * Payment then supplier on one side, supplier then payment on the other. One order now: the payment lock key-shares
 * its supplier first.
 *
 * Judged by OUTCOME, interleaved deterministically: the real route is parked while it holds the payment row, the
 * edit is started and waits until ITS backend (by pid) is blocked on a lock, then the route is released. A 40P01 on
 * either side, or a 5xx, fails the test. Disposable fixture DB only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';

const gate = vi.hoisted(() => ({
  park: null as null | { entered: () => void; hold: Promise<void> },
}));
vi.mock('@/modules/accounting/services/ap/supplierPaymentApproval', async (orig) => {
  const actual = await orig<typeof import('@/modules/accounting/services/ap/supplierPaymentApproval')>();
  return {
    ...actual,
    // Called by processSupplierPayment under the payment lock, before the claim.
    assertPaymentApprovalCleared: async (...a: Parameters<typeof actual.assertPaymentApprovalCleared>) => {
      const park = gate.park;
      if (park) {
        gate.park = null;
        park.entered();
        await park.hold;
      }
      return actual.assertPaymentApprovalCleared(...a);
    },
  };
});

import { updateSupplier } from '@/modules/accounting/services/core/supplierWriteService';
import { lockSupplierPaymentForUpdate } from '@/modules/accounting/services/core/paymentLock';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { lockOrderKit } from './ap-supplier-batch-lock-order.helpers';
import { createUser } from './r035-approval.helpers';
import { cleanupPr5, payCompany, payRoutes, plantPayment, plantSupplier } from './r035-pr5.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
const companies: string[] = [];
const tokens: Record<string, string> = {};
const u = { a: '' };
const r = payRoutes(tokens);
const { startWriter, blockedStatement } = lockOrderKit(pool, () => u.a);

beforeAll(async () => { u.a = await createUser(pool, tokens); });
beforeEach(() => { gate.park = null; });
afterAll(() => cleanupPr5(pool, companies, [u.a]));

/** An approved single payment (not in a batch) of a company with no approval rules. */
async function approvedPayment() {
  const { company: c, bank } = await payCompany(pool, [[u.a, 'admin']], companies);
  const p = await plantPayment(pool, c, u.a, bank);
  expect((await r.payment(u.a, c, 'approve', p.id)).state.statusCode).toBe(200);
  return { c, p };
}

/** The process route, parked while it holds the payment row. */
async function startParkedProcess(c: string, paymentId: string) {
  let release!: () => void;
  let entered!: () => void;
  const inGate = new Promise<void>((res) => { entered = res; });
  gate.park = { entered, hold: new Promise<void>((res) => { release = res; }) };
  const processing = r.payment(u.a, c, 'process', paymentId);
  await inGate;
  return { processing, release };
}

describe('updateSupplier against processSupplierPayment: supplier, then payment', () => {
  it.each([
    ['a bank-detail edit', { bankAccountNumber: '62000007777' }],
    ['a payee rename', { name: 'Renamed payee' }],
  ])('%s of the payee while its payment is processed does not deadlock', async (_label, input) => {
    const { c, p } = await approvedPayment();
    const { processing, release } = await startParkedProcess(c, p.id); // route holds the payment row
    const edit = startWriter(c, () => updateSupplier(c, p.supplierId, input, u.a));
    const blocked = await blockedStatement(await edit.pid).finally(release);
    const [res, edited] = await Promise.all([processing, edit.outcome]);
    expect({ process: res.state.statusCode, edited }).toEqual({ process: 200, edited: { ok: true } });
    // The edit waited on the supplier the route key-shares (before the fix: it held the supplier, waited on the payment).
    expect(blocked).toMatch(/FROM suppliers WHERE[\s\S]*FOR UPDATE/);
    const row = (await pool.query('SELECT status, gl_journal_entry_id FROM supplier_payments WHERE id = $1', [p.id])).rows[0];
    expect(row.status).toBe('processed');
    expect(row.gl_journal_entry_id).not.toBeNull();
  });
});

describe('lockSupplierPaymentForUpdate: a payment re-pointed while it waited', () => {
  it('key-shares the supplier the payment names once locked, not only the one it named before', async () => {
    const { company: c, bank } = await payCompany(pool, [[u.a, 'admin']], companies);
    const p = await plantPayment(pool, c, u.a, bank); // draft
    const moved = await plantSupplier(pool, c);
    // A merge-like writer re-points the payment and holds it.
    const merge = await pool.connect();
    try {
      await merge.query('BEGIN');
      await merge.query('UPDATE supplier_payments SET supplier_id = $1 WHERE id = $2', [moved, p.id]);
      let release!: () => void;
      const hold = new Promise<void>((res) => { release = res; });
      const locker = startWriter(c, async () => {
        const row = await lockSupplierPaymentForUpdate(c, p.id);
        await hold; // keep the transaction (and its locks) open while the probe runs
        return row;
      });
      expect(await blockedStatement(await locker.pid)).toMatch(/FOR UPDATE OF sp/);
      await merge.query('COMMIT');
      // Once the payment lock is granted the new supplier is key-shared: a FOR UPDATE of it cannot be had.
      let probe: string | undefined;
      for (let i = 0; i < 500 && probe !== '55P03'; i += 1) {
        probe = await pool.query('SELECT id FROM suppliers WHERE id = $1 FOR UPDATE NOWAIT', [moved])
          .then(() => 'free', (e: { code?: string }) => e.code);
        if (probe !== '55P03') await new Promise((res) => setTimeout(res, 20));
      }
      release();
      expect({ probe, locked: await locker.outcome }).toEqual({ probe: '55P03', locked: { ok: true } });
    } finally {
      await merge.query('ROLLBACK').catch(() => undefined);
      merge.release();
    }
  });
});
