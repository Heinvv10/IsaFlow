/**
 * D8 round 2: reversing a processed payment batch whose journal was reversed
 * and the reversal reversed by hand (O <- R <- R2). The GL carries the batch
 * again through R2 while O stays stamped `reversed_at`, so reading the stamp
 * refused the batch reversal as "already reversed" — the bills stayed paid and
 * the cash out stood, with no way to undo it. The reversal now takes the chain
 * HEAD (shared/journalChainHead), once.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { als } from '@/lib/als';
import { reverseJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostingService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { ids, setUpFixture, tearDownFixture, type Fixture } from './supplier-ownership-fence.helpers';
import { bill, billState } from './ap-allocation-guards.helpers';
import { flow, text } from './ap-payment-flow.helpers';

const describeIfDb = process.env.DATABASE_URL && process.env.JWT_SECRET ? describe : describe.skip;

describeIfDb('D8 round 2 — a re-reversed batch journal is reversed at its chain head', () => {
  let fx: Fixture;
  const f = flow(() => fx);
  const q = (s: string, p: unknown[]) => fx.pool.query(s, p);
  const net = async (gl: string) => Number((await q(`SELECT COALESCE(SUM(l.debit - l.credit), 0) AS n
    FROM gl_journal_lines l JOIN gl_journal_entries e ON e.id = l.journal_entry_id
    WHERE l.gl_account_id = $1 AND e.status = 'posted'`, [gl])).rows[0].n);

  /** reverseJournalEntry in a request-shaped transaction, as company A's user. */
  async function reverse(id: string): Promise<string> {
    const c = await fx.pool.connect();
    try {
      await c.query('BEGIN');
      const out = await als.run({ client: c, userId: ids.USER, companyId: ids.A, claims: {} } as never,
        () => reverseJournalEntry(ids.A, id, ids.USER));
      await c.query('COMMIT');
      return out.id;
    } catch (err) {
      await c.query('ROLLBACK');
      throw err;
    } finally {
      c.release();
    }
  }

  beforeAll(async () => {
    assertDisposable();
    fx = await setUpFixture('D8 batch');
    const y = new Date().getFullYear();
    await q(`INSERT INTO fiscal_periods (company_id, period_name, period_number, fiscal_year, start_date, end_date, status)
      VALUES ($1, $2, 1, $3, $4, $5, 'open')`, [ids.A, `FY${y}`, y, `${y}-01-01`, `${y}-12-31`]);
  });
  afterAll(async () => {
    if (fx) await q('UPDATE gl_journal_entries SET reversal_of_id = NULL WHERE company_id = $1', [ids.A]);
    await tearDownFixture(fx?.pool);
  });

  it('reverses the head once, reopens the bill and puts AP and the bank back', async () => {
    const x = await bill(fx.pool, { supplier: ids.SUP_A, status: 'approved' });
    const batchId = await f.approvedBatch([{ billId: x, amount: 300 }]);
    expect((await f.batchAction('process', batchId)).statusCode).toBe(200);
    const journal = String((await q('SELECT gl_journal_entry_id AS j FROM supplier_payment_batches WHERE id = $1',
      [batchId])).rows[0].j);
    const head = await reverse(await reverse(journal));
    const before = { ap: await net(ids.AP_GL), bank: await net(ids.BANK_GL) };

    const state = await f.batchAction('reverse', batchId);

    expect(state.statusCode, text(state)).toBe(200);
    expect(await net(ids.AP_GL)).toBeCloseTo(before.ap - 300, 2);
    expect(await net(ids.BANK_GL)).toBeCloseTo(before.bank + 300, 2);
    expect(await billState(fx.pool, x)).toEqual({ paid: 0, status: 'approved' });
    expect(await f.batchStatus(batchId)).toBe('reversed');
    const contras = (await q("SELECT id FROM gl_journal_entries WHERE reversal_of_id = $1 AND status = 'posted'",
      [head])).rows;
    expect(contras).toHaveLength(1);
  });

  it('a batch whose journal chain is already OUT is reversed as documents only: bills reopened, nothing posted (D8 round 5)', async () => {
    const x = await bill(fx.pool, { supplier: ids.SUP_A, status: 'approved' });
    const batchId = await f.approvedBatch([{ billId: x, amount: 200 }]);
    expect((await f.batchAction('process', batchId)).statusCode).toBe(200);
    const journal = String((await q('SELECT gl_journal_entry_id AS j FROM supplier_payment_batches WHERE id = $1',
      [batchId])).rows[0].j);
    const r = await reverse(journal);
    const before = { ap: await net(ids.AP_GL), bank: await net(ids.BANK_GL) };

    const state = await f.batchAction('reverse', batchId);

    expect(state.statusCode, text(state)).toBe(200);
    expect((state.body as { data: { reversalEntryId: string | null } }).data.reversalEntryId).toBeNull();
    expect({ ap: await net(ids.AP_GL), bank: await net(ids.BANK_GL) }).toEqual(before);
    expect((await q("SELECT id FROM gl_journal_entries WHERE reversal_of_id = $1 AND status = 'posted'", [r])).rows)
      .toHaveLength(0);
    expect(await billState(fx.pool, x)).toEqual({ paid: 0, status: 'approved' });
    expect(await f.batchStatus(batchId)).toBe('reversed');
    expect((await q('SELECT DISTINCT status FROM supplier_payments WHERE batch_id = $1', [batchId])).rows)
      .toEqual([{ status: 'cancelled' }]);
    // A second click is still the double-click's loser.
    expect((await f.batchAction('reverse', batchId)).statusCode).toBe(409);
  });

  // D8 round 6 (review finding 1): the out-chain branch still frees and guards the batch journal's bank line.
  async function outBatchWithLine(status: 'matched' | 'reconciled') {
    const x = await bill(fx.pool, { supplier: ids.SUP_A, status: 'approved' });
    const batchId = await f.approvedBatch([{ billId: x, amount: 150 }]);
    expect((await f.batchAction('process', batchId)).statusCode).toBe(200);
    const journal = String((await q('SELECT gl_journal_entry_id AS j FROM supplier_payment_batches WHERE id = $1',
      [batchId])).rows[0].j);
    const leg = String((await q('SELECT id FROM gl_journal_lines WHERE journal_entry_id = $1 AND gl_account_id = $2',
      [journal, ids.BANK_GL])).rows[0].id);
    const bt = String((await q(`INSERT INTO bank_transactions (company_id, bank_account_id, transaction_date, amount,
      description, status, matched_journal_line_id) VALUES ($1, $2, CURRENT_DATE, -150, 'D8R6 batch line', $3, $4) RETURNING id`,
    [ids.A, ids.BANK_GL, status, leg])).rows[0].id);
    await reverse(journal);
    return { x, batchId, bt };
  }
  const lineOf = async (bt: string) => (await q('SELECT status, matched_journal_line_id FROM bank_transactions WHERE id = $1', [bt])).rows[0];

  it('an OUT batch journal with a matched bank line: reversed, the line freed, nothing posted', async () => {
    const { batchId, bt } = await outBatchWithLine('matched');
    const before = { ap: await net(ids.AP_GL), bank: await net(ids.BANK_GL) };
    const state = await f.batchAction('reverse', batchId);
    expect(state.statusCode, text(state)).toBe(200);
    expect(await lineOf(bt)).toEqual({ status: 'imported', matched_journal_line_id: null });
    expect({ ap: await net(ids.AP_GL), bank: await net(ids.BANK_GL) }).toEqual(before);
    await q('UPDATE bank_transactions SET matched_journal_line_id = NULL WHERE id = $1', [bt]);
  });

  it('an OUT batch journal with a RECONCILED bank line: refused naming it, nothing changed', async () => {
    const { batchId, bt } = await outBatchWithLine('reconciled');
    const state = await f.batchAction('reverse', batchId);
    expect(state.statusCode, text(state)).toBe(400);
    expect(text(state)).toMatch(/reconciled in the Sage import/);
    expect((await lineOf(bt)).status).toBe('reconciled');
    expect(await f.batchStatus(batchId)).toBe('processed');
    await q('UPDATE bank_transactions SET matched_journal_line_id = NULL WHERE id = $1', [bt]);
  });

  // D8 round 9 (rev-d8-9ecdfa549 finding 1): the journals lock waits under the shared budget — 503, not a hang.
  it('the batch journal held by another request: 503 within the budget, the batch still processed', async () => {
    const x = await bill(fx.pool, { supplier: ids.SUP_A, status: 'approved' });
    const batchId = await f.approvedBatch([{ billId: x, amount: 120 }]);
    expect((await f.batchAction('process', batchId)).statusCode).toBe(200);
    const journal = String((await q('SELECT gl_journal_entry_id AS j FROM supplier_payment_batches WHERE id = $1',
      [batchId])).rows[0].j);
    const holder = await fx.pool.connect();
    await holder.query('BEGIN');
    await holder.query('SELECT id FROM gl_journal_entries WHERE id = $1 FOR UPDATE', [journal]);
    const release = setTimeout(() => { void holder.query('ROLLBACK'); }, 12000); // an unbounded mutant proceeds, late
    const started = Date.now();
    let state;
    try {
      state = await f.batchAction('reverse', batchId);
    } finally {
      clearTimeout(release);
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }
    expect(Date.now() - started).toBeLessThan(9000);
    expect(state.statusCode, text(state)).toBe(503);
    expect(text(state)).toMatch(/SERVICE_UNAVAILABLE/);
    expect(await f.batchStatus(batchId)).toBe('processed');
  }, 40000);
});

