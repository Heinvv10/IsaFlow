/**
 * processSupplierPayment takes no supplier lock: the two interleavings an earlier fix for the supplier-update 40P01
 * (a supplier FOR KEY SHARE taken before the payment lock) got wrong, found by the adversarial review.
 *
 * (1) Journal-number lock x refund plan. One bank-rule sweep transaction numbers a journal (company+year advisory
 *     lock, migration 857, held to COMMIT), then plans a supplier refund (lockContactForRefund: supplier FOR UPDATE).
 *     A process route that holds a lock on that supplier and then numbers its journal closes a cycle with it.
 * (2) Merge re-point. A merge holds both suppliers and re-points the payment; the process route gets the payment
 *     once the merge commits, now naming the surviving supplier; updateSupplier(survivor) then holds it and waits on
 *     the payment. Before the fix the route's second write of the payment row key-shared the survivor: 40P01.
 *
 * Interleaved deterministically (parked routes, waits found by pid via pg_blocking_pids / pg_stat_activity), judged
 * by outcome: both requests succeed. Disposable fixture DB only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
    await pass('p'); // processSupplierPayment calls it under the payment lock, before the journal
    return actual.assertPaymentApprovalCleared(...a);
  } };
});
vi.mock('@/modules/accounting/services/ap/supplierPaymentAuthors', async (orig) => {
  const actual = await orig<typeof import('@/modules/accounting/services/ap/supplierPaymentAuthors')>();
  return { ...actual, stampBatchesOfMovedPayments: async (...a: Parameters<typeof actual.stampBatchesOfMovedPayments>) => {
    await pass('m'); // the merge calls it holding both suppliers, after re-pointing the payments
    return actual.stampBatchesOfMovedPayments(...a);
  } };
});

import { createJournalEntry } from '@/modules/accounting/services/gl/journalEntryService';
import { getSystemAccount } from '@/modules/accounting/services/gl/systemAccountResolver';
import { defaultHumanMeta } from '@/modules/accounting/services/gl/journalEntryMeta';
import { planSupplierRefund } from '@/modules/accounting/services/ap/supplierRefundDocument';
import { updateSupplier } from '@/modules/accounting/services/core/supplierWriteService';
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
beforeEach(() => { gate.p = null; gate.m = null; });
afterAll(async () => {
  await pool.query('DELETE FROM gl_journal_lines WHERE journal_entry_id IN (SELECT id FROM gl_journal_entries WHERE company_id = ANY($1))', [companies]);
  await cleanupPr5(pool, companies, [u.a]);
});

function parked(which: 'p' | 'm') {
  let release!: () => void;
  let entered!: () => void;
  const inGate = new Promise<void>((res) => { entered = res; });
  gate[which] = { entered, hold: new Promise<void>((res) => { release = res; }) };
  return { inGate, release };
}

/** Resolves once some backend waits on `holderPid`. */
async function waitBlockedBy(holderPid: number): Promise<void> {
  for (let i = 0; i < 500; i += 1) {
    if ((await pool.query('SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))', [holderPid])).rowCount) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`nobody ever waited on ${holderPid}`);
}

async function approvedPayment() {
  const { company: c, bank } = await payCompany(pool, [[u.a, 'admin']], companies);
  const pay = await plantPayment(pool, c, u.a, bank);
  expect((await r.payment(u.a, c, 'approve', pay.id)).state.statusCode).toBe(200);
  return { c, bank, pay };
}

const outcomeOf = (res: { state: { statusCode: number; body?: unknown } }) =>
  ({ status: res.state.statusCode, body: res.state.statusCode === 200 ? null : res.state.body });

describe('processSupplierPayment against the journal-number lock and the supplier row', () => {
  it('a sweep that numbered a journal and then plans a refund for the payee does not deadlock the process route', async () => {
    const { c, bank, pay } = await approvedPayment();
    const p = parked('p');
    const processing = r.payment(u.a, c, 'process', pay.id);
    await p.inGate; // the route holds the payment, before its journal

    let numbered!: () => void;
    let releaseSweep!: () => void;
    const hasNumber = new Promise<void>((res) => { numbered = res; });
    const sweepHold = new Promise<void>((res) => { releaseSweep = res; });
    const sweep = startWriter(c, async () => {
      const ap = await getSystemAccount('payable', c);
      await createJournalEntry(c, {
        entryDate: '2026-09-15', description: 'sweep line 1', source: 'auto_bank_recon',
        lines: [
          { glAccountId: String(ap.id), debit: 10, credit: 0, description: 'l1' },
          { glAccountId: bank, debit: 0, credit: 10, description: 'l1' },
        ],
      }, u.a, defaultHumanMeta(u.a)); // takes and keeps the company+year number lock
      numbered();
      await sweepHold;
      try {
        await planSupplierRefund(c, pay.supplierId, 1, '2026-09-15'); // supplier FOR UPDATE
      } catch (e) {
        if ((e as { name?: string }).name !== 'SupplierRefundRefusal') throw e; // the ceiling refusal comes after the lock
      }
    });
    await hasNumber;
    p.release();
    await waitBlockedBy(await sweep.pid); // the route now waits on the sweep's number lock
    releaseSweep();
    const [res, swept] = await Promise.all([processing, sweep.outcome]);
    expect({ process: outcomeOf(res), swept }).toEqual({ process: { status: 200, body: null }, swept: { ok: true } });
  }, 60_000);

  it('a payment whose supplier is merged away while the route waits, then an edit of the survivor: no 40P01', async () => {
    const { c, pay } = await approvedPayment(); // its own supplier becomes the duplicate
    const primary = await plantSupplier(pool, c);
    const m = parked('m');
    const merge = startWriter(c, () => mergeEntities(c, 'supplier', primary, pay.supplierId, u.a));
    await m.inGate; // the merge holds both suppliers and has re-pointed the payment

    const p = parked('p');
    const processing = r.payment(u.a, c, 'process', pay.id);
    await waitBlockedBy(await merge.pid); // the route waits on the re-pointed payment
    m.release();
    expect(await merge.outcome).toEqual({ ok: true });
    await p.inGate; // the route holds the payment, which now names the survivor

    const edit = startWriter(c, () => updateSupplier(c, primary, { bankAccountNumber: '62000009999' }, u.a));
    const blocked = await blockedStatement(await edit.pid).finally(p.release);
    const [res, edited] = await Promise.all([processing, edit.outcome]);
    expect({ process: outcomeOf(res), edited }).toEqual({ process: { status: 200, body: null }, edited: { ok: true } });
    expect(blocked).toMatch(/FROM supplier_payments[\s\S]*FOR UPDATE/); // the edit held the survivor, waited on the payment
  }, 60_000);
});
