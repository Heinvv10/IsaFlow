/**
 * D8 round 6 (adversarial pass 2, brk-d8b): lock order and stale chain reads.
 *
 * F2  Bank reversal locked the journal head BEFORE its unwind locked the receipt; receipt cancel locks the
 *     receipt, then the head. Both on one bank-allocated receipt deadlocked (40P01). The head is now locked
 *     after the unwind, so every flow locks document, then journal.
 * (a) Provisional dismiss locked the head, then the bank line; the automatic evidence attach locks the bank
 *     line, then the journal. Dismiss now locks the bank line first.
 * (c) AP bill cancel acted on the plan's UNLOCKED chain walk: a GL reversal landing between the plan and the
 *     cancel's own lock put the bill back in the ledger under a cancelled bill. It now decides under the lock.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import { sql } from '@/lib/neon';
import { reverseJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostingService';
import { cancelCustomerPayment } from '@/modules/accounting/services/ar/customerPaymentAllocationService';
import { allocateTransaction, reverseReconciledTransaction } from '@/modules/accounting/services/bank/bankAllocationService';
import { dismissProvisionalEntry } from '@/modules/accounting/services/bank/provisionalDismissService';
import { attachEvidenceToProvisional } from '@/modules/accounting/services/capture/evidenceAttachmentService';
import { cancelSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { inTx, runOn, seedBankTx } from './helpers/l1FifoFixture';
import {
  buildChain, diff, postedBill, postedInvoice, postedReversalsOf, provisional, settle, setup, sleep, tb, teardown, type Ctx,
} from './d8-r4-helpers';

let c: Ctx;
type Row = Record<string, unknown>;
const one = async (q: Promise<unknown>) => ((await q) as Row[])[0]!;

/** A committed transaction whose client runs `onHit` right after the `fireAt`-th query matching `match` returns. */
async function hooked<T>(fn: () => Promise<T>, match: (t: string) => boolean, fireAt: number,
  onHit: () => Promise<void>): Promise<T> {
  const cl: PoolClient = await c.fx.pool.connect();
  const orig = cl.query.bind(cl) as (...a: unknown[]) => Promise<unknown>;
  let n = 0;
  (cl as unknown as { query: unknown }).query = async (...a: unknown[]) => {
    const out = await orig(...a);
    const t = typeof a[0] === 'string' ? a[0] : (a[0] as { text?: string } | undefined)?.text ?? '';
    if (match(t) && ++n === fireAt) await onHit();
    return out;
  };
  await orig('BEGIN');
  try {
    const v = await runOn(c.fx, cl, fn);
    await orig('COMMIT');
    return v;
  } catch (err) {
    await orig('ROLLBACK');
    throw err;
  } finally {
    (cl as unknown as { query: unknown }).query = orig;
    cl.release();
  }
}
const isHeadLock = (t: string) => t.includes('SELECT status, reversed_at FROM gl_journal_entries') && t.includes('FOR UPDATE');
// The walk DOWN to the head (findJournalChainHead), the target's pre-write read — not the walk UP to the root (D10).
const isChainWalk = (t: string) => t.includes('ARRAY[id] AS path') && t.includes('RECURSIVE chain AS');

describe.skipIf(!process.env.DATABASE_URL)('D8 round 6: one lock order, decisions under the head lock', () => {
  beforeAll(async () => {
    assertNotProductionDb('D8 round 6 lock order');
    c = await setup('D8R6L');
  }, 120000);
  afterAll(async () => {
    if (c) await sql`UPDATE bank_transactions SET matched_journal_line_id = NULL WHERE company_id = ${c.fx.companyId}::UUID`;
    await teardown(c);
  }, 120000);

  for (const k of [0, 2]) {
    it(`F2 k=${k}: bank reversal and receipt cancel of one bank-allocated receipt — no deadlock, out once`, async () => {
      const inv = await postedInvoice(c);
      const bt = await seedBankTx(c.fx, { date: '2026-05-22', amount: 1150, description: `D8R6-DL ${++c.seq}` });
      const a = await inTx(c.fx, () => allocateTransaction(c.fx.companyId, bt, null, c.fx.userId, undefined, 'customer',
        c.fx.customerId, undefined, undefined, undefined, undefined, inv.id));
      const p = await one(sql`SELECT id FROM customer_payments WHERE gl_journal_entry_id = ${a.journalEntryId}::UUID`);
      await buildChain(c, a.journalEntryId, k);
      const t0 = await tb(c);
      let cancel: Promise<unknown> = Promise.resolve();
      const bank = await settle(hooked(() => reverseReconciledTransaction(c.fx.companyId, bt, c.fx.userId), isHeadLock, 1,
        async () => {
          cancel = settle(inTx(c.fx, () => cancelCustomerPayment(c.fx.companyId, String(p.id), c.fx.userId)));
          await sleep(700);
        }));
      const cr = await cancel;
      expect(JSON.stringify([bank, cr])).not.toMatch(/deadlock/i);
      expect(bank.ok, JSON.stringify(bank)).toBe(true);
      expect(diff(t0, await tb(c))).toMatchObject({ ar: 1150, bank: -1150 });
      const st = await one(sql`SELECT cp.status, bt.status AS line FROM customer_payments cp, bank_transactions bt
        WHERE cp.id = ${String(p.id)}::UUID AND bt.id = ${bt}::UUID`);
      expect(st).toEqual({ status: 'cancelled', line: 'imported' });
    });
  }

  it('F2 order: when bank reversal locks the journal head it already holds the receipt (document, then journal)', async () => {
    const inv = await postedInvoice(c);
    const bt = await seedBankTx(c.fx, { date: '2026-05-22', amount: 1150, description: `D8R6-ORD ${++c.seq}` });
    const a = await inTx(c.fx, () => allocateTransaction(c.fx.companyId, bt, null, c.fx.userId, undefined, 'customer',
      c.fx.customerId, undefined, undefined, undefined, undefined, inv.id));
    const p = await one(sql`SELECT id FROM customer_payments WHERE gl_journal_entry_id = ${a.journalEntryId}::UUID`);
    await buildChain(c, a.journalEntryId, 2);
    let probe = '';
    await hooked(() => reverseReconciledTransaction(c.fx.companyId, bt, c.fx.userId), isHeadLock, 1, async () => {
      const cl = await c.fx.pool.connect();
      try {
        await cl.query('BEGIN');
        await cl.query('SELECT id FROM customer_payments WHERE id = $1 FOR UPDATE NOWAIT', [String(p.id)]);
        probe = 'receipt free';
      } catch (err) {
        probe = String((err as { code?: string }).code);
      } finally {
        await cl.query('ROLLBACK');
        cl.release();
      }
    });
    expect(probe, 'the receipt row is held when the head is locked').toBe('55P03');
  });

  it('F2: a reversal landing between the pre-write read and the head lock is a retryable refusal, nothing written', async () => {
    const bt = await seedBankTx(c.fx, { date: '2026-05-12', amount: -230, description: `D8R6-MOV ${++c.seq}` });
    await inTx(c.fx, () => allocateTransaction(c.fx.companyId, bt, c.acct.expense!, c.fx.userId, undefined, 'account',
      undefined, undefined));
    const m = await one(sql`SELECT l.journal_entry_id AS j FROM bank_transactions bt
      JOIN gl_journal_lines l ON l.id = bt.matched_journal_line_id WHERE bt.id = ${bt}::UUID`);
    const t0 = await tb(c);
    const r = await settle(hooked(() => reverseReconciledTransaction(c.fx.companyId, bt, c.fx.userId), isChainWalk, 1,
      async () => { await inTx(c.fx, () => reverseJournalEntry(c.fx.companyId, String(m.j), c.fx.userId)); }));
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).toMatch(/BankAllocationRefusal.*reversed by another request.*retry/);
    expect((await one(sql`SELECT status FROM bank_transactions WHERE id = ${bt}::UUID`)).status).toBe('allocated');
    expect(diff(t0, await tb(c))).toMatchObject({ expense: -230, bank: 230 }); // the GL reversal alone
  });

  for (const k of [0, 2]) {
    it(`(a) k=${k}: provisional dismiss and the automatic evidence attach — no deadlock`, async () => {
      const amount = 300 + (++c.seq);
      const pv = await provisional(c, amount);
      await sql`UPDATE bank_transactions SET predicted_supplier_id = ${c.fx.supplierId}::UUID WHERE id = ${pv.bt}::UUID`;
      await buildChain(c, pv.je, k);
      const doc = await one(sql`
        INSERT INTO captured_documents (company_id, file_name, file_type, status, document_type)
        VALUES (${c.fx.companyId}::UUID, ${`d8r6-da-${c.seq}.pdf`}, 'application/pdf', 'reviewed', 'supplier_invoice')
        RETURNING id`);
      const t0 = await tb(c);
      let attach: Promise<unknown> = Promise.resolve();
      const d = await settle(hooked(() => dismissProvisionalEntry(c.fx.companyId, pv.je, c.fx.userId), isHeadLock, 1,
        async () => {
          attach = settle(inTx(c.fx, () => attachEvidenceToProvisional(
            c.fx.companyId, String(doc.id), c.fx.supplierId, amount, '2026-05-15')));
          await sleep(1500);
        }));
      const at = await attach;
      expect(JSON.stringify([d, at])).not.toMatch(/deadlock/i);
      expect(d.ok, JSON.stringify(d)).toBe(true);
      // Dismissed: the provisional is out once and its line back in the queue; the attach found nothing to evidence.
      expect(diff(t0, await tb(c))).toMatchObject({ expense: -amount, bank: amount });
      expect(await one(sql`SELECT status, provisional_je_id FROM bank_transactions WHERE id = ${pv.bt}::UUID`))
        .toEqual({ status: 'imported', provisional_je_id: null });
    });
  }

  it('(c) AP cancel: a GL reversal landing after the plan read "out" is acted on under the lock — bill out once', async () => {
    const bill = await postedBill(c);
    const chain = await buildChain(c, bill.je, 1); // out
    const t0 = await tb(c);
    let r2 = '';
    const r = await settle(hooked(() => cancelSupplierInvoice(c.fx.companyId, bill.id, c.fx.userId), isChainWalk, 1,
      async () => {
        r2 = (await inTx(c.fx, () => reverseJournalEntry(c.fx.companyId, chain[1]!, c.fx.userId))).id; // back IN
      }));
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r2).not.toBe('');
    expect(await postedReversalsOf(c, r2)).toHaveLength(1);
    expect(diff(t0, await tb(c))).toMatchObject({ ap: 0, expense: 0, vatIn: 0 });
    expect((await one(sql`SELECT status FROM supplier_invoices WHERE id = ${bill.id}::UUID`)).status).toBe('cancelled');
  });
});
