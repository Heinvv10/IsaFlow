// tests/integration/k064-batch-reversal.int.test.ts
//
// Reverse a PROCESSED supplier payment batch (batch-payments-action `reverse`).
// A batch of 3 members across 2 bills — bill X carries two of them — processed,
// then a LATER separate payment part-pays bill Y. Reversing the batch must put
// AP, the bank GL, both bills, every member and the batch back to where they
// were before the batch was processed, with the later payment still standing,
// one contra and no more, and the trial balance still balanced.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { SignJWT } from 'jose';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import batchPaymentsAction from '../../pages/api/accounting/batch-payments-action';
import { ids, setUpFixture, tearDownFixture, type Fixture } from './supplier-ownership-fence.helpers';
import { bill, billState } from './ap-allocation-guards.helpers';
import { flow, text } from './ap-payment-flow.helpers';

const describeIfDb = process.env.DATABASE_URL && process.env.JWT_SECRET ? describe : describe.skip;

describeIfDb('K-064 — reverse a processed payment batch', () => {
  let fx: Fixture;
  const f = flow(() => fx);
  const q = (s: string, p: unknown[]) => fx.pool.query(s, p);
  const net = async (gl: string) => Number((await q(`SELECT COALESCE(SUM(l.debit - l.credit), 0) AS n
    FROM gl_journal_lines l JOIN gl_journal_entries e ON e.id = l.journal_entry_id
    WHERE l.gl_account_id = $1 AND e.status = 'posted'`, [gl])).rows[0].n);
  const trialBalanced = async () => {
    const { rows } = await q(`SELECT COALESCE(SUM(l.debit), 0) AS dr, COALESCE(SUM(l.credit), 0) AS cr
      FROM gl_journal_lines l JOIN gl_journal_entries e ON e.id = l.journal_entry_id
      WHERE e.company_id = $1 AND e.status = 'posted'`, [ids.A]);
    return Number(rows[0].dr) === Number(rows[0].cr);
  };
  const contras = async (batchId: string) => Number((await q(`SELECT count(*) AS n FROM gl_journal_entries r
    JOIN supplier_payment_batches b ON b.gl_journal_entry_id = r.reversal_of_id
    WHERE b.id = $1 AND r.status = 'posted'`, [batchId])).rows[0].n);
  const statuses = async (batchId: string) => ({
    batch: await f.batchStatus(batchId),
    members: (await q('SELECT DISTINCT status FROM supplier_payments WHERE batch_id = $1', [batchId])).rows.map((r) => r.status),
  });

  /** Create + approve a batch of `lines`, with one extra member seeded on `extra` (the legacy two-on-one-bill shape). */
  async function approvedBatchOf3(x: string, y: string): Promise<string> {
    const made = await f.createBatch([{ billId: x, amount: 300 }, { billId: y, amount: 200 }]);
    expect(made.statusCode, text(made)).toBe(200);
    const batchId = f.idOf(made);
    const third = randomUUID();
    await q(`INSERT INTO supplier_payments (id, company_id, supplier_id, payment_date, total_amount, payment_method,
      status, batch_id, created_by) VALUES ($1, $2, $3, CURRENT_DATE, 100, 'eft', 'draft', $4, $5)`,
    [third, ids.A, ids.SUP_A, batchId, ids.USER]);
    await q('INSERT INTO payment_allocations (payment_id, invoice_id, amount_allocated) VALUES ($1, $2, 100)', [third, x]);
    await q('UPDATE supplier_payment_batches SET total_amount = 600, payment_count = 3 WHERE id = $1', [batchId]);
    expect((await f.batchAction('approve', batchId)).statusCode).toBe(200);
    return batchId;
  }
  const approvedBill = () => bill(fx.pool, { supplier: ids.SUP_A, status: 'approved' });

  beforeAll(async () => {
    assertDisposable();
    fx = await setUpFixture('K064 reverse');
    const y = new Date().getFullYear();
    await q(`INSERT INTO fiscal_periods (company_id, period_name, period_number, fiscal_year, start_date, end_date, status)
      VALUES ($1, $2, 1, $3, $4, $5, 'open')`, [ids.A, `FY${y}`, y, `${y}-01-01`, `${y}-12-31`]);
  });
  afterAll(() => tearDownFixture(fx?.pool));

  it('puts everything back as it was before the batch, except a later payment, which stands', async () => {
    const [x, y] = [await approvedBill(), await approvedBill()];
    const batchId = await approvedBatchOf3(x, y);
    const before = { ap: await net(ids.AP_GL), bank: await net(ids.BANK_GL) };

    expect((await f.batchAction('process', batchId)).statusCode).toBe(200);
    expect(await billState(fx.pool, x)).toEqual({ paid: 400, status: 'partially_paid' });
    const later = await f.approvedPayment(y, 400);
    expect((await f.paymentAction('process', later)).statusCode).toBe(200);
    expect(await billState(fx.pool, y)).toEqual({ paid: 600, status: 'partially_paid' });

    const state = await f.batchAction('reverse', batchId);

    expect(state.statusCode, text(state)).toBe(200);
    expect(await billState(fx.pool, x)).toEqual({ paid: 0, status: 'approved' });
    expect(await billState(fx.pool, y)).toEqual({ paid: 400, status: 'partially_paid' });
    expect(await net(ids.AP_GL)).toBe(before.ap + 400);       // only the later 400 remains on AP
    expect(await net(ids.BANK_GL)).toBe(before.bank - 400);   // and on the bank
    expect(await statuses(batchId)).toEqual({ batch: 'reversed', members: ['cancelled'] });
    expect(await f.paymentStatus(later)).toBe('processed');
    expect(await contras(batchId)).toBe(1);
    expect(await trialBalanced()).toBe(true);
    // Released: nothing of the batch reserves X any more, so it takes its full 1000.
    expect((await f.createPayment(x, 1000)).statusCode).toBe(201);
  });

  it('double-click: exactly one reversal, the other 409, one contra', async () => {
    const [x, y] = [await approvedBill(), await approvedBill()];
    const batchId = await approvedBatchOf3(x, y);
    expect((await f.batchAction('process', batchId)).statusCode).toBe(200);
    const [a, b] = await Promise.all([f.batchAction('reverse', batchId), f.batchAction('reverse', batchId)]);
    expect([a.statusCode, b.statusCode].sort(), `${text(a)} / ${text(b)}`).toEqual([200, 409]);
    expect(await contras(batchId)).toBe(1);
    expect(await billState(fx.pool, x)).toEqual({ paid: 0, status: 'approved' });
  });

  it('racing a new payment on the same bill: no deadlock, no 500, the bill ends consistent', async () => {
    const [x, y] = [await approvedBill(), await approvedBill()];
    const batchId = await approvedBatchOf3(x, y);
    expect((await f.batchAction('process', batchId)).statusCode).toBe(200);
    const [rev, pay] = await Promise.all([f.batchAction('reverse', batchId), f.createPayment(y, 900)]);
    expect(rev.statusCode, text(rev)).toBe(200);
    expect([201, 400], text(pay)).toContain(pay.statusCode);
    expect(await billState(fx.pool, y)).toEqual({ paid: 0, status: 'approved' });
    expect(await contras(batchId)).toBe(1);
  });

  it('unmatches a bank line matched to the batch journal', async () => {
    const [x, y] = [await approvedBill(), await approvedBill()];
    const batchId = await approvedBatchOf3(x, y);
    expect((await f.batchAction('process', batchId)).statusCode).toBe(200);
    const line = (await q(`SELECT l.id FROM gl_journal_lines l JOIN supplier_payment_batches b
      ON b.gl_journal_entry_id = l.journal_entry_id WHERE b.id = $1 AND l.credit > 0`, [batchId])).rows[0].id;
    await q("UPDATE bank_transactions SET status = 'matched', matched_journal_line_id = $1 WHERE id = $2", [line, ids.BANK_TX_SEL]);

    expect((await f.batchAction('reverse', batchId)).statusCode).toBe(200);
    const { rows } = await q('SELECT status, matched_journal_line_id FROM bank_transactions WHERE id = $1', [ids.BANK_TX_SEL]);
    expect(rows[0]).toEqual({ status: 'imported', matched_journal_line_id: null });
  });

  it.each([
    ['its bank line is reconciled', async (batchId: string) => {
      const line = (await q(`SELECT l.id FROM gl_journal_lines l JOIN supplier_payment_batches b
        ON b.gl_journal_entry_id = l.journal_entry_id WHERE b.id = $1 AND l.credit > 0`, [batchId])).rows[0].id;
      await q("UPDATE bank_transactions SET status = 'reconciled', matched_journal_line_id = $1 WHERE id = $2", [line, ids.BANK_TX_PAY]);
    }, 'reconciled in the Sage import', 400],
    ['its bank line is on a COMPLETED reconciliation', async (batchId: string) => {
      const line = (await q(`SELECT l.id FROM gl_journal_lines l JOIN supplier_payment_batches b
        ON b.gl_journal_entry_id = l.journal_entry_id WHERE b.id = $1 AND l.credit > 0`, [batchId])).rows[0].id;
      const rec = randomUUID();
      await q(`INSERT INTO bank_reconciliations (id, company_id, bank_account_id, statement_date, status, started_by)
        VALUES ($1, $2, $3, CURRENT_DATE, 'completed', $4)`, [rec, ids.A, ids.BANK_GL, ids.USER]);
      await q("UPDATE bank_transactions SET status = 'reconciled', matched_journal_line_id = $1, reconciliation_id = $2 WHERE id = $3",
        [line, rec, ids.BANK_TX_PAY]);
    // D12: a COMPLETED reconciliation is the shared 409, decided before any write.
    }, `The bank reconciliation of R068 Bank to ${new Date().toISOString().slice(0, 10)} is completed — reopen it first`, 409],
    ['the reversal date falls in a closed period', async () => {
      await q("UPDATE fiscal_periods SET status = 'closed' WHERE company_id = $1", [ids.A]);
    }, 'not in an open fiscal period', 400],
  ])('refuses (4xx) and writes nothing when %s', async (_why, arrange, words, status) => {
    const [x, y] = [await approvedBill(), await approvedBill()];
    const batchId = await approvedBatchOf3(x, y);
    expect((await f.batchAction('process', batchId)).statusCode).toBe(200);
    const ap = await net(ids.AP_GL);
    await arrange(batchId);
    try {
      const state = await f.batchAction('reverse', batchId);
      expect(state.statusCode, text(state)).toBe(status);
      expect(text(state)).toContain(words);
      expect(await statuses(batchId)).toEqual({ batch: 'processed', members: ['processed'] });
      expect(await billState(fx.pool, x)).toEqual({ paid: 400, status: 'partially_paid' });
      expect(await contras(batchId)).toBe(0);
      expect(await net(ids.AP_GL)).toBe(ap);
    } finally {
      await q("UPDATE fiscal_periods SET status = 'open' WHERE company_id = $1", [ids.A]);
      await q("UPDATE bank_transactions SET status = 'imported', matched_journal_line_id = NULL, reconciliation_id = NULL WHERE company_id = $1", [ids.A]);
      await q('DELETE FROM bank_reconciliations WHERE company_id = $1', [ids.A]);
    }
  });

  it('is gated as void is: a viewer gets 403 and the batch stays processed', async () => {
    const viewer = randomUUID();
    await q("INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'viewer', true)", [viewer, `k064-rv-${viewer}@isaflow.test`]);
    await q("INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, 'viewer')", [ids.A, viewer]);
    try {
      const [x, y] = [await approvedBill(), await approvedBill()];
      const batchId = await approvedBatchOf3(x, y);
      expect((await f.batchAction('process', batchId)).statusCode).toBe(200);
      const token = await new SignJWT({ sub: viewer, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' })
        .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
      const req = request({ 'sb-access-token': token, active_company_id: ids.A }, 'POST') as never as { body: unknown; url: string };
      req.body = { action: 'reverse', id: batchId };
      req.url = '/api/accounting/k064-reverse-fixture';
      const out = response();
      await batchPaymentsAction(req as never, out.res as never);
      expect(out.state.statusCode, JSON.stringify(out.state.body)).toBe(403);
      expect(await f.batchStatus(batchId)).toBe('processed');
    } finally {
      await q('DELETE FROM company_users WHERE user_id = $1', [viewer]);
      await q('DELETE FROM users WHERE id = $1', [viewer]);
    }
  });

  it('refuses a batch that is not processed, and a member void points at the batch reversal', async () => {
    const [x, y] = [await approvedBill(), await approvedBill()];
    const batchId = await approvedBatchOf3(x, y);
    const notYet = await f.batchAction('reverse', batchId);
    expect(notYet.statusCode, text(notYet)).toBe(400);
    expect((await f.batchAction('process', batchId)).statusCode).toBe(200);
    const voided = await f.paymentAction('void', await f.memberOf(batchId));
    expect(voided.statusCode, text(voided)).toBe(400);
    expect(text(voided)).toContain('reverse the batch');
  });
});
