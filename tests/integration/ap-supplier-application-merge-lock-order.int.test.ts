/**
 * Applying a supplier payment to bills against a supplier merge (40P01, found by the adversarial review of the
 * supplier-update deadlock fix; present before it).
 *
 *   application (the AP auto-apply back-fill, and the supplier-allocations route): payment FOR UPDATE -> bills ->
 *     applyLineToBill writes each bill twice (amount_paid, then recomputeInvoiceStatus); the second write re-runs
 *     the bill's supplier FK check: FOR KEY SHARE on the supplier.
 *   merge (mergeEntities): batches -> both suppliers FOR UPDATE in id order -> UPDATE the duplicate's payments.
 * Payment then supplier against supplier then payment. Application now key-shares the supplier before the payment
 * (lockSupplierPaymentForUpdate's `supplierFirst`), and the back-fill, one transaction over many sources, visits
 * them in supplier-id order, as the merge locks them.
 *
 * Interleaved deterministically (the back-fill parked by a wrapped export, the merge's wait found by pid), judged
 * by outcome: both finish, and the back-fill fails no source. Disposable fixture DB only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';

type At = 'source2' | 'plan';
type Park = null | { at: At; entered: () => void; hold: Promise<void> };
const gate = vi.hoisted(() => ({ locks: 0, park: null as Park }));
async function pass(at: At) {
  const park = gate.park;
  if (park?.at === at) { gate.park = null; park.entered(); await park.hold; }
}
vi.mock('@/modules/accounting/services/core/paymentLock', async (orig) => {
  const actual = await orig<typeof import('@/modules/accounting/services/core/paymentLock')>();
  return { ...actual, lockSupplierPaymentForUpdate: async (...a: Parameters<typeof actual.lockSupplierPaymentForUpdate>) => {
    gate.locks += 1; // counted from the park: each back-fill source locks twice (applyOnePayment, then the plan)
    if (gate.locks === 3) await pass('source2'); // the back-fill's second source, before its first lock
    return actual.lockSupplierPaymentForUpdate(...a);
  } };
});
vi.mock('@/modules/accounting/services/ap/supplierPaymentApplicationService', async (orig) => {
  const actual = await orig<typeof import('@/modules/accounting/services/ap/supplierPaymentApplicationService')>();
  return { ...actual, planSupplierPaymentApplication: async (...a: Parameters<typeof actual.planSupplierPaymentApplication>) => {
    await pass('plan'); // the back-fill holds the payment and its bills, before writing them
    return actual.planSupplierPaymentApplication(...a);
  } };
});

import { autoApplyUnapplied } from '@/modules/accounting/services/shared/autoApplyBackfillService';
import { mergeEntities } from '@/modules/accounting/services/core/duplicateMergeService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { lockOrderKit } from './ap-supplier-batch-lock-order.helpers';
import { createUser } from './r035-approval.helpers';
import { cleanupPr5, payCompany, payRoutes, plantPayment } from './r035-pr5.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
const companies: string[] = [];
const tokens: Record<string, string> = {};
const u = { a: '' };
const r = payRoutes(tokens);
const { startWriter, blockedStatement } = lockOrderKit(pool, () => u.a);

beforeAll(async () => { u.a = await createUser(pool, tokens); });
beforeEach(() => { gate.park = null; });
afterAll(async () => {
  await pool.query('DELETE FROM gl_journal_lines WHERE journal_entry_id IN (SELECT id FROM gl_journal_entries WHERE company_id = ANY($1))', [companies]);
  await cleanupPr5(pool, companies, [u.a]);
});

async function supplier(c: string, id: string) {
  await pool.query(
    `INSERT INTO suppliers(id,company_id,name,bank_name,bank_account_number,bank_branch_code,bank_account_type,bank_account_holder)
     VALUES($1,$2,$3,'R035 Bank','62000000001','250655','current','R035 Holder')`, [id, c, `merge ${id.slice(0, 6)}`]);
}

/** A processed payment of `sid` whose allocation was taken off again: unapplied cash and an open bill to take it. */
async function unappliedPayment(c: string, bank: string, sid: string) {
  const p = await plantPayment(pool, c, u.a, bank, { supplierId: sid });
  expect((await r.payment(u.a, c, 'approve', p.id)).state.statusCode).toBe(200);
  expect((await r.payment(u.a, c, 'process', p.id)).state.statusCode).toBe(200);
  await pool.query('DELETE FROM payment_allocations WHERE payment_id = $1', [p.id]);
  await pool.query("UPDATE supplier_invoices SET amount_paid = 0, status = 'approved' WHERE id = $1", [p.billId]);
  return p;
}

/** Two suppliers of a fresh company, the first with the lower id. */
async function twoSuppliers() {
  const { company: c, bank } = await payCompany(pool, [[u.a, 'admin']], companies);
  const [lo, hi] = [crypto.randomUUID(), crypto.randomUUID()].sort();
  await supplier(c, lo!); await supplier(c, hi!);
  return { c, bank, lo: lo!, hi: hi! };
}

/** Back-fill parked at `at`; the merge of `duplicate` into `primary` started and waiting on a lock; then released. */
async function race(c: string, at: At, primary: string, duplicate: string) {
  let release!: () => void;
  let entered!: () => void;
  const inGate = new Promise<void>((res) => { entered = res; });
  gate.locks = 0;
  gate.park = { at, entered, hold: new Promise<void>((res) => { release = res; }) };
  let failed: unknown[] | null = null;
  const backfill = startWriter(c, async () => {
    failed = (await autoApplyUnapplied({ companyId: c, subledger: 'ap', dryRun: false, userId: u.a })).failed;
  });
  await inGate;
  const merge = startWriter(c, () => mergeEntities(c, 'supplier', primary, duplicate, u.a));
  await blockedStatement(await merge.pid).finally(release);
  const [b, m] = await Promise.all([backfill.outcome, merge.outcome]);
  return { backfill: b, merge: m, failed };
}

const SAFE = { backfill: { ok: true }, merge: { ok: true }, failed: [] };

describe('applying a supplier payment against a supplier merge', () => {
  it('the merge of the supplier whose payment the back-fill is applying does not deadlock', async () => {
    const { c, bank, lo, hi } = await twoSuppliers();
    await unappliedPayment(c, bank, hi);
    expect(await race(c, 'plan', lo, hi)).toEqual(SAFE);
  }, 60_000);

  it('a back-fill over two suppliers against merging them, the lower id kept, does not deadlock', async () => {
    const { c, bank, lo, hi } = await twoSuppliers();
    await unappliedPayment(c, bank, hi); // the older payment: first in the population
    await unappliedPayment(c, bank, lo);
    expect(await race(c, 'source2', lo, hi)).toEqual(SAFE);
  }, 60_000);
});
