/**
 * D8 round 10 (adversarial pass 3, brk-d8c).
 * F3 Credit-note cancel took note -> journal head -> its contra -> THEN the invoice / bill; a receipt cancel or payment
 *    void on the same document takes bank line -> payment -> document -> journal. The pair deadlocked (40P01 -> 500).
 *    The cancel now locks the documents the note credited first.
 * O8 Dismiss read needs_evidence before its locks: an automatic attach that committed while it waited was followed by
 *    a dismiss of the just-evidenced provisional. It re-reads under the bank-line lock.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import { sql } from '@/lib/neon';
import { createCreditNote } from '@/modules/accounting/services/ar/creditNoteService';
import { approveCreditNote } from '@/modules/accounting/services/ar/creditNoteApproveService';
import { cancelCreditNote } from '@/modules/accounting/services/ar/creditNoteCancelService';
import { cancelCustomerPayment } from '@/modules/accounting/services/ar/customerPaymentAllocationService';
import { voidSupplierPayment } from '@/modules/accounting/services/ap/supplierPaymentWorkflowService';
import { voidPaymentDocument } from '@/modules/accounting/services/core/paymentVoidService';
import { dismissProvisionalEntry } from '@/modules/accounting/services/bank/provisionalDismissService';
import { attachEvidenceToProvisional } from '@/modules/accounting/services/capture/evidenceAttachmentService';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { inTx, runOn } from './helpers/l1FifoFixture';
import {
  buildChain, confirmedReceipt, postedBill, postedInvoice, processedPayment, provisional, setup, sleep, teardown, type Ctx,
} from './d8-r4-helpers';

let c: Ctx;
type Row = Record<string, unknown>;

/** A committed request transaction; `onPause` runs once, after the first query matching `pauseOn`. */
async function run(fn: () => Promise<unknown>, pauseOn?: (t: string) => boolean, onPause?: () => Promise<void>) {
  const cl: PoolClient = await c.fx.pool.connect();
  const orig = cl.query.bind(cl) as (...a: unknown[]) => Promise<unknown>;
  let fired = false;
  (cl as unknown as { query: unknown }).query = async (...a: unknown[]) => {
    const out = await orig(...a);
    const t = typeof a[0] === 'string' ? a[0] : (a[0] as { text?: string } | undefined)?.text ?? '';
    if (pauseOn && onPause && !fired && pauseOn(t)) { fired = true; await onPause(); }
    return out;
  };
  await orig('BEGIN');
  try {
    const v = await runOn(c.fx, cl, fn);
    await orig('COMMIT');
    return { ok: true, value: v };
  } catch (err) {
    await orig('ROLLBACK').catch(() => undefined);
    return { ok: false, error: `${(err as Error).name}: ${(err as Error).message}`, code: (err as { code?: string }).code };
  } finally {
    (cl as unknown as { query: unknown }).query = orig;
    cl.release();
  }
}

/** An invoice (or bill) R1150 credited R575 by an approved note and paid R575 by a receipt (or payment). */
async function noteAndPayment(side: 'customer' | 'supplier', k: number) {
  const id = c.fx.companyId, u = c.fx.userId;
  const doc = side === 'customer' ? await postedInvoice(c) : await postedBill(c);
  const note = await inTx(c.fx, async () => {
    const n = await createCreditNote(id, side === 'customer'
      ? { type: 'customer', clientId: c.fx.customerId, customerInvoiceId: doc.id, creditDate: '2026-05-10', subtotal: 500, taxRate: 15 }
      : { type: 'supplier', supplierId: c.fx.supplierId, supplierInvoiceId: doc.id, creditDate: '2026-05-10', subtotal: 500, taxRate: 15 }, u);
    return { id: n.id, je: (await approveCreditNote(id, n.id, u)).glJournalEntryId! };
  });
  const pay = side === 'customer' ? await confirmedReceipt(c, doc.id, 575) : await processedPayment(c, doc.id, 575);
  await buildChain(c, note.je, k);
  await buildChain(c, pay.je, k);
  return { note, pay };
}

describe.skipIf(!process.env.DATABASE_URL)('D8 round 10: credit-note cancel and dismiss on the one lock order', () => {
  beforeAll(async () => {
    assertNotProductionDb('D8 round 10 credit-note order');
    c = await setup('D8R10C');
  }, 120000);
  afterAll(async () => {
    if (c) {
      await sql`DELETE FROM credit_note_allocations WHERE company_id = ${c.fx.companyId}::UUID`;
      await sql`DELETE FROM credit_notes WHERE company_id = ${c.fx.companyId}::UUID`;
    }
    await teardown(c);
  }, 120000);

  const pairs: [string, 'customer' | 'supplier', (p: string) => () => Promise<unknown>][] = [
    ['receipt cancel', 'customer', (p) => () => cancelCustomerPayment(c.fx.companyId, p, c.fx.userId)],
    ['MCP void_receipt', 'customer', (p) => () => voidPaymentDocument(c.fx.companyId, 'customer', p, c.fx.userId)],
    ['HTTP void', 'supplier', (p) => () => voidSupplierPayment(c.fx.companyId, p, c.fx.userId)],
    ['MCP void_payment', 'supplier', (p) => () => voidPaymentDocument(c.fx.companyId, 'supplier', p, c.fx.userId)],
  ];
  for (const [name, side, payFlow] of pairs) {
    for (const k of [0, 2]) {
      it(`F3 ${name} holds the document while the note's cancel runs (k=${k}) — no deadlock, both complete`, async () => {
        const s = await noteAndPayment(side, k);
        let other: Promise<Record<string, unknown>> = Promise.resolve({});
        const a = await run(payFlow(s.pay.id), (t) => /^\s*UPDATE (customer|supplier)_invoices/.test(t), async () => {
          other = run(() => cancelCreditNote(c.fx.companyId, s.note.id, c.fx.userId));
          await sleep(500);
        });
        const b = await other;
        expect(JSON.stringify([a, b])).not.toMatch(/40P01|deadlock/);
        expect(a.ok, JSON.stringify(a)).toBe(true);
        expect(b.ok, JSON.stringify(b)).toBe(true);
      }, 30000);
    }
  }

  it('O8 an automatic attach committing while dismiss waits: dismiss refuses the now-evidenced entry', async () => {
    const amount = 640 + (++c.seq);
    const pv = await provisional(c, amount);
    await sql`UPDATE bank_transactions SET predicted_supplier_id = ${c.fx.supplierId}::UUID WHERE id = ${pv.bt}::UUID`;
    const [doc] = (await sql`
      INSERT INTO captured_documents (company_id, file_name, file_type, status, document_type)
      VALUES (${c.fx.companyId}::UUID, ${`d8r10-o8-${c.seq}.pdf`}, 'application/pdf', 'reviewed', 'supplier_invoice')
      RETURNING id`) as Row[];
    const d = await run(() => dismissProvisionalEntry(c.fx.companyId, pv.je, c.fx.userId),
      (t) => t.includes('SELECT id, needs_evidence, status FROM gl_journal_entries'),
      async () => {
        const r = await inTx(c.fx, () => attachEvidenceToProvisional(c.fx.companyId, String(doc!.id), c.fx.supplierId, amount, '2026-05-15'));
        expect(r.attachedJeId).toBe(pv.je);
      });
    expect(d.ok).toBe(false);
    expect(String(d.error)).toMatch(/not provisional/);
    const [x] = (await sql`SELECT needs_evidence, reversed_at FROM gl_journal_entries WHERE id = ${pv.je}::UUID`) as Row[];
    expect(x).toEqual({ needs_evidence: false, reversed_at: null });
  }, 30000);
});
