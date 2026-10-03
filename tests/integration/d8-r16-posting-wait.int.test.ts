/**
 * D8 round 16 (adversarial pass 4, brk-d8d), through the real routes. Every row a D8 flow waits on, held 9 s by another
 * transaction, must come back as 503 + Retry-After within the 5 s budget, with nothing committed.
 * F1 The contra POSTING: another posting on the same account and month holds the gl_account_balances row the posting
 *    trigger upserts. The 55P03 aborted the transaction, the reversal's draft cleanup then raised 25P02 and replaced it:
 *    500 / 400 "current transaction is aborted", no Retry-After.
 * F2 Batch reversal: `lockBillCandidates` reset lock_timeout to DEFAULT inside the flow budget, so its posting waited
 *    unbounded and answered 200 once the holder let go.
 * F4 HTTP void / receipt cancel with the payment row or its bank line held: 409 with no Retry-After. A held row is a
 *    lock timeout. Round 17: bank reversal (`bank-transactions-action` reverse) too. Round 18: batch reversal with the
 *    batch row or one of its bills held, and the manual evidence attach with its bank line or captured document held.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import { SignJWT } from 'jose';
import { sql } from '@/lib/neon';
import { approveBatch, createBatch, processBatch } from '@/modules/accounting/services/ap/batchPaymentService';
import customerPaymentsAction from '../../pages/api/accounting/customer-payments-action';
import supplierPaymentsAction from '../../pages/api/accounting/supplier-payments-action';
import supplierInvoicesAction from '../../pages/api/accounting/supplier-invoices-action';
import customerInvoicesDetail from '../../pages/api/accounting/customer-invoices-detail';
import batchPaymentsAction from '../../pages/api/accounting/batch-payments-action';
import bankTransactionsAction from '../../pages/api/accounting/bank-transactions-action';
import { allocateTransaction } from '@/modules/accounting/services/bank/bankAllocationService';
import softDeleteRoute from '../../pages/api/accounting/soft-delete';
import provisionalAttach from '../../pages/api/accounting/provisional/[jeId]/attach';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { request, response } from './mfa-impersonation-postgres.helpers';
import { inTx, seedBankTx } from './helpers/l1FifoFixture';
import { confirmedReceipt, postedBill, postedInvoice, processedPayment, provisional, setup, teardown, type Ctx } from './d8-r4-helpers';

let c: Ctx;
type Row = Record<string, unknown>;
type Handler = (req: never, res: never) => unknown;
let token = '';
const one = async (q: Promise<unknown>) => ((await q) as Row[])[0]!;

async function call(route: Handler, method: string, body: Record<string, unknown>, query: Record<string, string> = {}) {
  const req = request({ 'sb-access-token': token, active_company_id: c.fx.companyId }, method) as unknown as Row;
  req.body = body;
  req.query = query;
  const out = response();
  const t0 = Date.now();
  await route(req as never, out.res as never);
  return { status: out.state.statusCode, ms: Date.now() - t0, retryAfter: out.headers.get('retry-after') ?? null,
    body: JSON.stringify(out.state.body).slice(0, 300) };
}

/** Another transaction holding `text` FOR UPDATE for up to 9 s; the returned function lets go early. */
async function holdFor(text: string, params: unknown[]) {
  const cl: PoolClient = await c.fx.pool.connect();
  await cl.query('BEGIN');
  if (!(await cl.query(text, params)).rowCount) throw new Error(`holder locked nothing: ${text}`);
  let done = false;
  const release = async () => { if (!done) { done = true; await cl.query('ROLLBACK'); cl.release(); } };
  const timer = setTimeout(() => { void release(); }, 9000);
  return async () => { clearTimeout(timer); await release(); };
}
const balanceRow = async (acct: string, je: string) => holdFor(
  'SELECT 1 FROM gl_account_balances WHERE gl_account_id = $1 AND fiscal_period_id = $2 FOR UPDATE',
  [acct, String((await one(sql`SELECT fiscal_period_id AS p FROM gl_journal_entries WHERE id = ${je}::UUID`)).p)]);
const reversed = async (je: string) => Boolean((await one(sql`SELECT reversed_at IS NOT NULL AS r FROM gl_journal_entries WHERE id = ${je}::UUID`)).r);

/** A statement line matched to journal `je`'s bank leg. */
async function lineOn(je: string, amount: number): Promise<string> {
  const leg = await one(sql`SELECT id FROM gl_journal_lines WHERE journal_entry_id = ${je}::UUID AND gl_account_id = ${c.fx.bankAccountId}::UUID`);
  return String((await one(sql`
    INSERT INTO bank_transactions (company_id, bank_account_id, transaction_date, amount, description, status, matched_journal_line_id)
    VALUES (${c.fx.companyId}::UUID, ${c.fx.bankAccountId}::UUID, '2026-05-20', ${amount}, ${`D8R16 ${++c.seq}`}, 'matched',
            ${String(leg.id)}::UUID) RETURNING id`)).id);
}

interface Case {
  je: string; hold: () => Promise<() => Promise<void>>; run: () => ReturnType<typeof call>;
  /** What else must be unchanged, beyond the journal not being reversed. */
  unchanged?: () => Promise<void>;
}
const supplierVoid = (pay: string) => () => call(supplierPaymentsAction as Handler, 'POST', { action: 'void', paymentId: pay });
const receiptCancel = (rc: string) => () => call(customerPaymentsAction as Handler, 'POST', { action: 'cancel', paymentId: rc });

/** A statement line allocated to a customer receipt for a posted invoice: the line, the receipt and its journal. */
async function allocatedReceipt(): Promise<{ bt: string; rc: string; je: string }> {
  const inv = await postedInvoice(c);
  const bt = await seedBankTx(c.fx, { date: '2026-05-22', amount: 1150, description: `D8R17 ${++c.seq}` });
  const a = await inTx(c.fx, () => allocateTransaction(c.fx.companyId, bt, null, c.fx.userId, undefined, 'customer',
    c.fx.customerId, undefined, undefined, undefined, undefined, inv.id));
  const rc = String((await one(sql`SELECT id FROM customer_payments WHERE gl_journal_entry_id = ${a.journalEntryId}::UUID`)).id);
  return { bt, rc, je: a.journalEntryId };
}
/** A processed one-bill batch: its id and its journal. */
async function processedBatch(): Promise<{ id: string; je: string }> {
  const bill = await postedBill(c);
  const id = await inTx(c.fx, async () => {
    const b = await createBatch(c.fx.companyId, { batchDate: '2026-05-20', bankAccountId: c.fx.bankAccountId,
      payments: [{ supplierId: c.fx.supplierId, invoiceAllocations: [{ invoiceId: bill.id, amount: 300 }] }] }, c.fx.userId);
    await approveBatch(c.fx.companyId, b.id, c.fx.userId);
    await processBatch(c.fx.companyId, b.id, c.fx.userId);
    return b.id;
  });
  return { id, je: String((await one(sql`SELECT gl_journal_entry_id AS j FROM supplier_payment_batches WHERE id = ${id}::UUID`)).j) };
}
const batchReverse = (id: string) => () => call(batchPaymentsAction as Handler, 'POST', { action: 'reverse', id });
const batchStatus = async (id: string) => String((await one(sql`SELECT status FROM supplier_payment_batches WHERE id = ${id}::UUID`)).status);

/** A bank-first provisional and a reviewed captured document of the same supplier and amount. */
async function provisionalAndDoc(): Promise<{ je: string; bt: string; doc: string }> {
  const pv = await provisional(c, 910 + (++c.seq));
  const doc = await one(sql`INSERT INTO captured_documents (company_id, file_name, file_type, status, document_type)
    VALUES (${c.fx.companyId}::UUID, ${`d8r18-${c.seq}.pdf`}, 'application/pdf', 'reviewed', 'supplier_invoice') RETURNING id`);
  return { je: pv.je, bt: pv.bt, doc: String(doc.id) };
}
const attach = (je: string, doc: string) => () =>
  call(provisionalAttach as Handler, 'POST', { capturedDocumentId: doc }, { jeId: je });
const stillNeedsEvidence = (je: string) => async () => {
  expect((await one(sql`SELECT needs_evidence FROM gl_journal_entries WHERE id = ${je}::UUID`)).needs_evidence).toBe(true);
};

const bankReverse = (bt: string) => () =>
  call(bankTransactionsAction as Handler, 'POST', { action: 'reverse', bankTransactionId: bt });

const cases: Record<string, () => Promise<Case>> = {
  'F1 HTTP void, the bank balance row': async () => {
    const p = await processedPayment(c, (await postedBill(c)).id, 400);
    return { je: p.je, hold: () => balanceRow(c.fx.bankAccountId, p.je), run: supplierVoid(p.id) };
  },
  'F1 receipt cancel, the bank balance row': async () => {
    const r = await confirmedReceipt(c, (await postedInvoice(c)).id, 400);
    return { je: r.je, hold: () => balanceRow(c.fx.bankAccountId, r.je), run: receiptCancel(r.id) };
  },
  'F1 AP bill cancel, the AP balance row': async () => {
    const b = await postedBill(c);
    return { je: b.je, hold: () => balanceRow(c.acct.ap!, b.je),
      run: () => call(supplierInvoicesAction as Handler, 'POST', { action: 'cancel', invoiceId: b.id }) };
  },
  'F1 AR invoice cancel, the AR balance row': async () => {
    const i = await postedInvoice(c);
    return { je: i.je, hold: () => balanceRow(c.acct.ar!, i.je),
      run: () => call(customerInvoicesDetail as Handler, 'POST', { id: i.id, action: 'cancel' }) };
  },
  'F1 soft delete of a customer invoice, the AR balance row': async () => {
    const i = await postedInvoice(c);
    return { je: i.je, hold: () => balanceRow(c.acct.ar!, i.je),
      run: () => call(softDeleteRoute as Handler, 'POST', { entityType: 'customer_invoice', entityId: i.id }) };
  },
  'F1 soft delete of a supplier bill, the AP balance row': async () => {
    const b = await postedBill(c);
    return { je: b.je, hold: () => balanceRow(c.acct.ap!, b.je),
      run: () => call(softDeleteRoute as Handler, 'POST', { entityType: 'supplier_invoice', entityId: b.id }) };
  },
  'F2 batch reversal, the bank balance row': async () => {
    const b = await processedBatch();
    return { je: b.je, hold: () => balanceRow(c.fx.bankAccountId, b.je), run: batchReverse(b.id) };
  },
  'R18 batch reversal, the batch row': async () => {
    const b = await processedBatch();
    return { je: b.je, hold: () => holdFor('SELECT id FROM supplier_payment_batches WHERE id = $1 FOR UPDATE', [b.id]),
      run: batchReverse(b.id), unchanged: async () => { expect(await batchStatus(b.id)).toBe('processed'); } };
  },
  'R18 batch reversal, a bill it paid': async () => {
    const b = await processedBatch();
    const bill = String((await one(sql`SELECT pa.invoice_id AS i FROM payment_allocations pa
      JOIN supplier_payments sp ON sp.id = pa.payment_id WHERE sp.batch_id = ${b.id}::UUID`)).i);
    return { je: b.je, hold: () => holdFor('SELECT id FROM supplier_invoices WHERE id = $1 FOR UPDATE', [bill]),
      run: batchReverse(b.id), unchanged: async () => { expect(await batchStatus(b.id)).toBe('processed'); } };
  },
  'R18 manual evidence attach, the bank line': async () => {
    const p = await provisionalAndDoc();
    return { je: p.je, hold: () => holdFor('SELECT id FROM bank_transactions WHERE id = $1 FOR UPDATE', [p.bt]),
      run: attach(p.je, p.doc), unchanged: stillNeedsEvidence(p.je) };
  },
  'R18 manual evidence attach, the captured document': async () => {
    const p = await provisionalAndDoc();
    return { je: p.je, hold: () => holdFor('SELECT id FROM captured_documents WHERE id = $1 FOR UPDATE', [p.doc]),
      run: attach(p.je, p.doc), unchanged: stillNeedsEvidence(p.je) };
  },
  'F4 HTTP void, the payment row': async () => {
    const p = await processedPayment(c, (await postedBill(c)).id, 400);
    return { je: p.je, hold: () => holdFor('SELECT id FROM supplier_payments WHERE id = $1 FOR UPDATE', [p.id]), run: supplierVoid(p.id) };
  },
  'F4 HTTP void, its bank line': async () => {
    const p = await processedPayment(c, (await postedBill(c)).id, 400);
    const bt = await lineOn(p.je, -400);
    return { je: p.je, hold: () => holdFor('SELECT id FROM bank_transactions WHERE id = $1 FOR UPDATE', [bt]), run: supplierVoid(p.id) };
  },
  'F4 receipt cancel, the receipt row': async () => {
    const r = await confirmedReceipt(c, (await postedInvoice(c)).id, 400);
    return { je: r.je, hold: () => holdFor('SELECT id FROM customer_payments WHERE id = $1 FOR UPDATE', [r.id]), run: receiptCancel(r.id) };
  },
  'R17 bank reversal, its bank line': async () => {
    const a = await allocatedReceipt();
    return { je: a.je, hold: () => holdFor('SELECT id FROM bank_transactions WHERE id = $1 FOR UPDATE', [a.bt]), run: bankReverse(a.bt) };
  },
  'R17 bank reversal, the receipt row': async () => {
    const a = await allocatedReceipt();
    return { je: a.je, hold: () => holdFor('SELECT id FROM customer_payments WHERE id = $1 FOR UPDATE', [a.rc]), run: bankReverse(a.bt) };
  },
  'F4 receipt cancel, its bank line': async () => {
    const r = await confirmedReceipt(c, (await postedInvoice(c)).id, 400);
    const bt = await lineOn(r.je, 400);
    return { je: r.je, hold: () => holdFor('SELECT id FROM bank_transactions WHERE id = $1 FOR UPDATE', [bt]), run: receiptCancel(r.id) };
  },
};

describe.skipIf(!process.env.DATABASE_URL || !process.env.JWT_SECRET)('D8 round 16: every held row is a 503 within the budget', () => {
  beforeAll(async () => {
    assertNotProductionDb('D8 round 16 posting wait');
    c = await setup('D8R16P');
    await sql`INSERT INTO users (id, email, first_name) VALUES (${c.fx.userId}, ${`d8r16-${c.fx.tag}@example.invalid`}, 'd8r16')
              ON CONFLICT (id) DO NOTHING`;
    await sql`INSERT INTO company_users (company_id, user_id, role) VALUES (${c.fx.companyId}::UUID, ${c.fx.userId}, 'admin')`;
    token = await new SignJWT({ sub: c.fx.userId, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
  }, 120000);
  afterAll(async () => {
    if (c) {
      await sql`UPDATE bank_transactions SET matched_journal_line_id = NULL WHERE company_id = ${c.fx.companyId}::UUID`;
      await sql`UPDATE supplier_payments SET batch_id = NULL WHERE company_id = ${c.fx.companyId}::UUID`;
      await sql`DELETE FROM supplier_payment_batches WHERE company_id = ${c.fx.companyId}::UUID`;
      await sql`DELETE FROM company_users WHERE company_id = ${c.fx.companyId}::UUID`;
    }
    await teardown(c);
  }, 120000);

  for (const [name, make] of Object.entries(cases)) {
    it(`${name} held 9 s: 503 + Retry-After within the budget, nothing committed`, async () => {
      const s = await make();
      const release = await s.hold();
      let out: Awaited<ReturnType<typeof call>>;
      try { out = await s.run(); } finally { await release(); }
      expect(out.status, JSON.stringify(out)).toBe(503);
      expect(out.retryAfter).toBe('2');
      expect(out.ms).toBeLessThan(8000);
      expect(out.body).not.toMatch(/aborted/);
      expect(await reversed(s.je), 'nothing committed').toBe(false);
      await s.unchanged?.();
    }, 40000);
  }

  // The state conflicts keep their answers: a lock timeout is 503, a conflict about the document's state is not.
  it('R18 batch reversal of a batch already reversed: still 409', async () => {
    const b = await processedBatch();
    expect((await batchReverse(b.id)()).status).toBe(200);
    const again = await batchReverse(b.id)();
    expect(again.status, JSON.stringify(again)).toBe(409);
    expect(again.retryAfter).toBeNull();
  }, 40000);

  it('R18 manual attach to a provisional already evidenced: still a refusal (400), not a 503', async () => {
    const p = await provisionalAndDoc();
    expect((await attach(p.je, p.doc)()).status).toBe(200);
    const other = await provisionalAndDoc();
    const again = await attach(p.je, other.doc)();
    expect(again.status, JSON.stringify(again)).toBe(400);
    expect(again.body).toMatch(/already evidenced/);
  }, 40000);
});
