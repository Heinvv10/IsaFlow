/**
 * Unapplying a supplier payment against a supplier merge (40P01, found by the adversarial review of the
 * supplier-update deadlock fix; older than it).
 *
 *   unapply: payment FOR UPDATE -> each bill written twice (UPDATE, then recomputeInvoiceStatus); the second write
 *     re-runs the bill's supplier FK check: FOR KEY SHARE on the supplier, after the payment.
 *   merge (mergeEntities): suppliers FOR UPDATE -> UPDATE supplier_payments (waits on the payment).
 * Fixed 2026-10-25 by writing each bill ONCE (`moveSupplierBillPaid`): no supplier key-share after the payment.
 *
 * Deterministic: unapply parked right after its payment lock, the merge's wait found by pid, judged by outcome.
 * Disposable fixture DB only.
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { Pool } from 'pg';

type Park = null | { entered: () => void; hold: Promise<void> };
const gate = vi.hoisted(() => ({ p: null as Park, m: null as Park }));
async function pass(which: 'p' | 'm') {
  const park = gate[which];
  if (park) { gate[which] = null; park.entered(); await park.hold; }
}
vi.mock('@/modules/accounting/services/core/paymentLock', async (orig) => {
  const actual = await orig<typeof import('@/modules/accounting/services/core/paymentLock')>();
  return { ...actual, lockSupplierPaymentForUpdate: async (...a: Parameters<typeof actual.lockSupplierPaymentForUpdate>) => {
    const row = await actual.lockSupplierPaymentForUpdate(...a);
    await pass('p'); // armed only around the unapply call: it now holds the payment row
    return row;
  } };
});
vi.mock('@/modules/accounting/services/ap/supplierPaymentAuthors', async (orig) => {
  const actual = await orig<typeof import('@/modules/accounting/services/ap/supplierPaymentAuthors')>();
  return { ...actual, stampBatchesOfMovedPayments: async (...a: Parameters<typeof actual.stampBatchesOfMovedPayments>) => {
    await pass('m'); return actual.stampBatchesOfMovedPayments(...a);
  } };
});

import { mergeEntities } from '@/modules/accounting/services/core/duplicateMergeService';
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
afterAll(async () => {
  await pool.query('DELETE FROM gl_journal_lines WHERE journal_entry_id IN (SELECT id FROM gl_journal_entries WHERE company_id = ANY($1))', [companies]);
  await cleanupPr5(pool, companies, [u.a]);
});

function parked(which: 'p' | 'm') {
  let release!: () => void; let entered!: () => void;
  const inGate = new Promise<void>((res) => { entered = res; });
  gate[which] = { entered, hold: new Promise<void>((res) => { release = res; }) };
  return { inGate, release };
}
it('unapplying a payment while its supplier is merged away: no 40P01', async () => {
  const { company: c, bank } = await payCompany(pool, [[u.a, 'admin']], companies);
  const pay = await plantPayment(pool, c, u.a, bank);
  const primary = await plantSupplier(pool, c);
  expect((await r.payment(u.a, c, 'approve', pay.id)).state.statusCode).toBe(200);
  expect((await r.payment(u.a, c, 'process', pay.id)).state.statusCode).toBe(200);

  const p = parked('p');
  const unapplying = r.payment(u.a, c, 'unapply', pay.id);
  await p.inGate; // unapply holds the payment row
  const merge = startWriter(c, () => mergeEntities(c, 'supplier', primary, pay.supplierId, u.a));
  // The merge holds the suppliers and waits on the payment; unapply then finishes without reaching a supplier row.
  await blockedStatement(await merge.pid).finally(p.release);
  const [res, merged] = await Promise.all([unapplying, merge.outcome]);
  expect({ unapply: res.state.statusCode, body: res.state.statusCode === 200 ? null : res.state.body, merged })
    .toEqual({ unapply: 200, body: null, merged: { ok: true } });
}, 60_000);
