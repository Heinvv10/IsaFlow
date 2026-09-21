// tests/integration/k064-bank-leg-and-void.int.test.ts
//
// Round 7: the bank leg of a reversed payment journal, and single void brought
// onto the same pre-write rules as batch reversal (`paymentJournalReversal.ts`).
//
// 1. Void of a processed payment whose bank line is MATCHED unmatches it, so
//    the statement line is free to match again.
// 2. Matching refuses a line of a reversed journal, and a match racing a batch
//    reversal never leaves a statement line matched to reversed cash.
// 3. Void in a closed period is a 400 with nothing written (it was a 500).
// Plus the reconciled-status message and the batch reversal's anomaly refusal.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { ids, setUpFixture, tearDownFixture, type Fixture } from './supplier-ownership-fence.helpers';
import { bill, billState } from './ap-allocation-guards.helpers';
import { flow, text, type State } from './ap-payment-flow.helpers';
import bankTransactionsAction from '../../pages/api/accounting/bank-transactions-action';

const describeIfDb = process.env.DATABASE_URL && process.env.JWT_SECRET ? describe : describe.skip;

describeIfDb('K-064 round 7 — the bank leg of a reversed payment journal', () => {
  let fx: Fixture;
  const f = flow(() => fx);
  const q = (s: string, p: unknown[]) => fx.pool.query(s, p);
  const approved = () => bill(fx.pool, { supplier: ids.SUP_A, status: 'approved' });
  const bankNet = async () => Number((await q(`SELECT COALESCE(SUM(l.debit - l.credit), 0) AS n
    FROM gl_journal_lines l JOIN gl_journal_entries e ON e.id = l.journal_entry_id
    WHERE l.gl_account_id = $1 AND e.status = 'posted'`, [ids.BANK_GL])).rows[0].n);
  async function bankLine(amount: number): Promise<string> {
    const id = randomUUID();
    await q(`INSERT INTO bank_transactions (id, company_id, bank_account_id, transaction_date, amount, description, status)
      VALUES ($1, $2, $3, CURRENT_DATE, $4, 'K064 round 7', 'imported')`, [id, ids.A, ids.BANK_GL, amount]);
    return id;
  }
  const bankState = async (id: string) => (await q(
    'SELECT status, matched_journal_line_id FROM bank_transactions WHERE id = $1', [id])).rows[0];
  const creditLineOf = async (journalId: string) => String((await q(
    'SELECT id FROM gl_journal_lines WHERE journal_entry_id = $1 AND credit > 0 LIMIT 1', [journalId])).rows[0].id);
  const match = (bankTransactionId: string, journalLineId: string): Promise<State> =>
    fx.call(bankTransactionsAction, 'POST', { action: 'match', bankTransactionId, journalLineId });
  const journalOfPayment = async (id: string) => String((await q(
    'SELECT gl_journal_entry_id FROM supplier_payments WHERE id = $1', [id])).rows[0].gl_journal_entry_id);
  const journalOfBatch = async (id: string) => String((await q(
    'SELECT gl_journal_entry_id FROM supplier_payment_batches WHERE id = $1', [id])).rows[0].gl_journal_entry_id);
  async function processedPaymentMatched(amount: number): Promise<{ paymentId: string; bankTx: string; billId: string }> {
    const billId = await approved();
    const paymentId = await f.approvedPayment(billId, amount);
    expect((await f.paymentAction('process', paymentId)).statusCode).toBe(200);
    const bankTx = await bankLine(-amount);
    const m = await match(bankTx, await creditLineOf(await journalOfPayment(paymentId)));
    expect(m.statusCode, text(m)).toBe(200);
    return { paymentId, bankTx, billId };
  }

  beforeAll(async () => {
    assertDisposable();
    fx = await setUpFixture('K064 r7');
    const y = new Date().getFullYear();
    await q(`INSERT INTO fiscal_periods (company_id, period_name, period_number, fiscal_year, start_date, end_date, status)
      VALUES ($1, $2, 1, $3, $4, $5, 'open')`, [ids.A, `FY${y}`, y, `${y}-01-01`, `${y}-12-31`]);
  });
  afterAll(() => tearDownFixture(fx?.pool));

  it('1. voiding a processed, bank-matched payment unmatches the bank line, which can then match again', async () => {
    const bankBefore = await bankNet();
    const { paymentId, bankTx, billId } = await processedPaymentMatched(450);
    expect(await bankNet()).toBe(bankBefore - 450);
    expect((await bankState(bankTx)).status).toBe('matched');

    const voided = await f.paymentAction('void', paymentId);

    expect(voided.statusCode, text(voided)).toBe(200);
    expect(await bankState(bankTx)).toEqual({ status: 'imported', matched_journal_line_id: null });
    expect(await bankNet()).toBe(bankBefore);
    expect(await billState(fx.pool, billId)).toEqual({ paid: 0, status: 'approved' });
    // Free to match again — to a live journal.
    const other = await processedPaymentMatched(450);
    const again = await match(bankTx, await creditLineOf(await journalOfPayment(other.paymentId)));
    expect(again.statusCode).toBe(400); // that journal line is already claimed by `other.bankTx`
    expect(text(again)).toContain('already matched');
    const fresh = await approved();
    const live = await f.approvedPayment(fresh, 450);
    expect((await f.paymentAction('process', live)).statusCode).toBe(200);
    expect((await match(bankTx, await creditLineOf(await journalOfPayment(live)))).statusCode).toBe(200);
  });

  it('2a. matching a line of a reversed journal is refused', async () => {
    const { paymentId, bankTx } = await processedPaymentMatched(300);
    const journal = await journalOfPayment(paymentId);
    expect((await f.paymentAction('void', paymentId)).statusCode).toBe(200);
    const state = await match(bankTx, await creditLineOf(journal));
    expect(state.statusCode, text(state)).toBe(400);
    expect(text(state)).toContain('reversed journal');
    expect(await bankState(bankTx)).toEqual({ status: 'imported', matched_journal_line_id: null });
  });

  it('2b. a match racing a batch reversal never leaves a statement line on reversed cash (5 trials)', async () => {
    for (let trial = 0; trial < 5; trial++) {
      const b = await approved();
      const made = await f.createBatch([{ billId: b, amount: 250 }]);
      const batchId = f.idOf(made);
      expect((await f.batchAction('approve', batchId)).statusCode).toBe(200);
      expect((await f.batchAction('process', batchId)).statusCode).toBe(200);
      const line = await creditLineOf(await journalOfBatch(batchId));
      const bankTx = await bankLine(-250);
      const [rev, m] = trial % 2
        ? await Promise.all([f.batchAction('reverse', batchId), match(bankTx, line)])
        : (await Promise.all([match(bankTx, line), f.batchAction('reverse', batchId)])).reverse() as [State, State];
      // A match that lands between the reversal's bank peek and its journal lock
      // makes the reversal answer 409 (retry) with its savepoint discarded; the
      // retry then sees that line and unmatches it.
      expect([200, 409], text(rev)).toContain(rev.statusCode);
      if (rev.statusCode === 409) expect((await f.batchAction('reverse', batchId)).statusCode).toBe(200);
      expect([200, 400], text(m)).toContain(m.statusCode);
      expect(await f.batchStatus(batchId)).toBe('reversed');
      expect(await bankState(bankTx)).toEqual({ status: 'imported', matched_journal_line_id: null });
    }
  }, 60000);

  it('2c. a match racing a single void: no 500, no deadlock, the line ends free (4 trials)', async () => {
    for (let trial = 0; trial < 4; trial++) {
      const b = await approved();
      const paymentId = await f.approvedPayment(b, 150);
      expect((await f.paymentAction('process', paymentId)).statusCode).toBe(200);
      const line = await creditLineOf(await journalOfPayment(paymentId));
      const bankTx = await bankLine(-150);
      const pair = [() => f.paymentAction('void', paymentId), () => match(bankTx, line)];
      const [v, m] = trial % 2 ? await Promise.all([pair[0]!(), pair[1]!()])
        : (await Promise.all([pair[1]!(), pair[0]!()])).reverse() as [State, State];
      expect([200, 409], text(v)).toContain(v.statusCode);
      if (v.statusCode === 409) expect((await f.paymentAction('void', paymentId)).statusCode).toBe(200);
      expect([200, 400], text(m)).toContain(m.statusCode);
      expect(await f.paymentStatus(paymentId)).toBe('cancelled');
      expect(await bankState(bankTx)).toEqual({ status: 'imported', matched_journal_line_id: null });
    }
  }, 60000);

  it('3. a void in a closed period is a 400 with nothing written', async () => {
    const { paymentId, bankTx, billId } = await processedPaymentMatched(200);
    const bankBefore = await bankNet();
    await q("UPDATE fiscal_periods SET status = 'closed' WHERE company_id = $1", [ids.A]);
    try {
      const state = await f.paymentAction('void', paymentId);
      expect(state.statusCode, text(state)).toBe(400);
      expect(text(state)).toContain('not in an open fiscal period');
      expect(await f.paymentStatus(paymentId)).toBe('processed');
      expect((await bankState(bankTx)).status).toBe('matched');
      expect(await billState(fx.pool, billId)).toEqual({ paid: 200, status: 'partially_paid' });
      expect(await bankNet()).toBe(bankBefore);
    } finally {
      await q("UPDATE fiscal_periods SET status = 'open' WHERE company_id = $1", [ids.A]);
    }
  });

  it('a void whose bank line is reconciled is a 400 with nothing written', async () => {
    const { paymentId, bankTx } = await processedPaymentMatched(120);
    await q("UPDATE bank_transactions SET status = 'reconciled' WHERE id = $1", [bankTx]);
    const state = await f.paymentAction('void', paymentId);
    expect(state.statusCode, text(state)).toBe(400);
    // Status 'reconciled' with no reconciliation_id: the Sage-import shape.
    expect(text(state)).toContain('reconciled in the Sage import');
    expect(text(state)).toContain('Correct it with a journal, or contact support');
    expect(await f.paymentStatus(paymentId)).toBe('processed');
  });

  // 4. (round 8) A fully applied ('reconciled') payment is now VOIDABLE — see
  // k064-void-applied-and-allocated, which pins it by outcome.

  it('5. batch reversal refuses when a bill no longer shows the batch\'s money (a constructed anomaly)', async () => {
    const b = await approved();
    const made = await f.createBatch([{ billId: b, amount: 300 }]);
    const batchId = f.idOf(made);
    expect((await f.batchAction('approve', batchId)).statusCode).toBe(200);
    expect((await f.batchAction('process', batchId)).statusCode).toBe(200);
    await q('UPDATE supplier_invoices SET amount_paid = 100 WHERE id = $1', [b]); // below the batch's 300
    const state = await f.batchAction('reverse', batchId);
    expect(state.statusCode, text(state)).toBe(400);
    expect(text(state)).toContain('no longer shows that payment');
    expect(await f.batchStatus(batchId)).toBe('processed');
  });
});
