/**
 * The supplier-merge ROUTE (pages/api/accounting/supplier-merge.ts) against processing a payment of the merged-away
 * supplier (40P01, found by the adversarial review of the supplier-update deadlock fix; older than it).
 *
 * The route re-parented the duplicate's BILLS before its PAYMENTS, the inverse of every payment writer:
 *   route: UPDATE supplier_invoices (the duplicate's bills) -> UPDATE supplier_payments (waits on the payment)
 *   process: payment FOR UPDATE -> assertPaymentStillProcessable locks the payment's bills (waits on the route)
 * It now moves payments, then bills, as duplicateMergeService does.
 *
 * The route is parked at lockBatchesPayingSupplier (before the payments; before the fix, after the bills). Process
 * runs until it either finishes or waits on a bill; then the route is released. Judged by outcome: both 200.
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
vi.mock('@/modules/accounting/services/ap/supplierPaymentApproval', async (orig) => {
  const actual = await orig<typeof import('@/modules/accounting/services/ap/supplierPaymentApproval')>();
  return { ...actual, assertPaymentApprovalCleared: async (...a: Parameters<typeof actual.assertPaymentApprovalCleared>) => {
    await pass('p'); return actual.assertPaymentApprovalCleared(...a);
  } };
});
vi.mock('@/modules/accounting/services/ap/supplierPaymentAuthors', async (orig) => {
  const actual = await orig<typeof import('@/modules/accounting/services/ap/supplierPaymentAuthors')>();
  return { ...actual, lockBatchesPayingSupplier: async (...a: Parameters<typeof actual.lockBatchesPayingSupplier>) => {
    await pass('m'); return actual.lockBatchesPayingSupplier(...a);
  } };
});

import supplierMerge from '../../pages/api/accounting/supplier-merge';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser } from './r035-approval.helpers';
import { cleanupPr5, payCompany, payRoutes, plantPayment, plantSupplier } from './r035-pr5.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
const companies: string[] = [];
const tokens: Record<string, string> = {};
const u = { a: '' };
const r = payRoutes(tokens);

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
it('processing a payment while the supplier-merge route merges its supplier away: no 40P01', async () => {
  const { company: c, bank } = await payCompany(pool, [[u.a, 'admin']], companies);
  const pay = await plantPayment(pool, c, u.a, bank); // its own supplier: the merge's source
  const target = await plantSupplier(pool, c);
  expect((await r.payment(u.a, c, 'approve', pay.id)).state.statusCode).toBe(200);

  const m = parked('m');
  const merging = callRoute(supplierMerge as never, tokens[u.a]!, c, 'POST', { source_id: pay.supplierId, target_id: target },
    '/api/accounting/supplier-merge');
  await m.inGate; // the route is parked at lockBatchesPayingSupplier (before the fix: with the bills already moved)
  const processing = r.payment(u.a, c, 'process', pay.id);
  // Process holds the payment and either waits on its bill (the route moved it first) or simply finishes.
  const waitsOnBill = (async () => {
    for (let i = 0; i < 500; i += 1) {
      // Any lock wait on a bill statement in this database (suites run one file at a time per database; a stray
      // match could only end the wait early, weakening the red-before-the-fix check, never failing a green run).
      const w = await pool.query(`SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock'
        AND datname = current_database() AND query ILIKE '%supplier_invoices%'`);
      if (w.rowCount) return;
      await new Promise((res) => setTimeout(res, 20));
    }
  })();
  await Promise.race([processing, waitsOnBill]);
  m.release();
  const [proc, merged] = await Promise.all([processing, merging]);
  expect({ process: proc.state.statusCode, merge: merged.state.statusCode,
    bodies: [proc.state.statusCode === 200 ? null : proc.state.body, merged.state.statusCode === 200 ? null : merged.state.body] })
    .toEqual({ process: 200, merge: 200, bodies: [null, null] });
}, 60_000);
