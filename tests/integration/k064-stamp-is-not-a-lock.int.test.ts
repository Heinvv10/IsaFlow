// tests/integration/k064-stamp-is-not-a-lock.int.test.ts
//
// Final review HIGH: `startReconciliation` stamps its id on every imported line
// of the account, allocating the line later does not clear the stamp, and
// completion marks only `matched` lines reconciled. A lock keyed on the stamp
// therefore froze every line allocated while a session was open — forever,
// since nothing reopens a completed reconciliation (R-111). The reviewer's exact
// sequence, through the real routes: a completed session's stamp on an
// allocated line it did not count → reverse gives 200 with the line freed; so
// do REST void, MCP void_payment and auto-post undo, and a reverse while the
// session is open. Since 2026-09-30 a line allocated INSIDE a session is counted
// (self-matched) and completion reconciles it — that one IS locked.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { ids, setUpFixture, tearDownFixture, type Fixture } from './supplier-ownership-fence.helpers';
import { bill, billState } from './ap-allocation-guards.helpers';
import { flow, text } from './ap-payment-flow.helpers';
import { als } from '../../src/lib/als';
import { getPoolForTests } from '../../src/lib/neon';
import { McpRegistry } from '../../src/lib/mcp/registry';
import { voidPaymentTool } from '../../src/lib/mcp/tools/writeVoidPayments';
import { undoRun } from '../../src/modules/accounting/services/bank/autoPostUndoService';
import bankTransactionsAction from '../../pages/api/accounting/bank-transactions-action';
import bankReconciliations from '../../pages/api/accounting/bank-reconciliations';
import bankReconciliationsAction from '../../pages/api/accounting/bank-reconciliations-action';

const describeIfDb = process.env.DATABASE_URL && process.env.JWT_SECRET ? describe : describe.skip;

describeIfDb('K-064 final — a reconciliation stamp on an allocated line is not a lock', () => {
  let fx: Fixture;
  const f = flow(() => fx);
  const q = (s: string, p: unknown[]) => fx.pool.query(s, p);
  const act = (body: Record<string, unknown>) => fx.call(bankTransactionsAction, 'POST', body);
  const today = new Date().toISOString().slice(0, 10);
  const bankState = async (id: string) => (await q(
    'SELECT status, matched_journal_line_id, reconciliation_id FROM bank_transactions WHERE id = $1', [id])).rows[0];
  const FREED = { status: 'imported', matched_journal_line_id: null, reconciliation_id: null };

  async function inRequest<T>(fn: () => Promise<T>): Promise<T> {
    const client: PoolClient = await getPoolForTests().connect();
    try {
      await client.query('BEGIN');
      const out = await als.run({ client, userId: ids.USER, companyId: ids.A, claims: { sub: ids.USER } } as never, fn);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally { client.release(); }
  }

  /**
   * import → start (stamps the line) → complete → allocate; with `complete`
   * false, import → start → allocate on the still-open session.
   *
   * 2026-09-30: completion now reconciles an allocated line the session covers
   * (it is matched to its own journal line — bankReconciliationClaim.ts), so
   * allocating BEFORE completing no longer leaves a stale stamp: the line is
   * reconciled and rightly locked. The stale-stamp shape this test guards —
   * a completed session's id on an allocated line it did not count — is now
   * made by allocating AFTER completion (and is what pre-change sessions left).
   */
  async function stampedAllocation(complete: boolean) {
    const billId = await bill(fx.pool, { supplier: ids.SUP_A2, status: 'approved', total: 115 });
    const bankTx = randomUUID();
    await q(`INSERT INTO bank_transactions (id, company_id, bank_account_id, transaction_date, amount, description, status)
      VALUES ($1, $2, $3, CURRENT_DATE, -115, 'K064 stamp', 'imported')`, [bankTx, ids.A, ids.BANK_GL]);
    // The statement agrees with the GL as start will snapshot it, so completion's R0.00 check passes.
    const gl = Number((await q(`SELECT COALESCE(SUM(jl.debit) - SUM(jl.credit), 0) AS b FROM gl_journal_lines jl
      JOIN gl_journal_entries je ON je.id = jl.journal_entry_id WHERE jl.gl_account_id = $1 AND jl.company_id = $2
      AND je.status = 'posted' AND je.entry_date <= $3`, [ids.BANK_GL, ids.A, today])).rows[0].b);
    const started = await fx.call(bankReconciliations, 'POST',
      { bankAccountId: ids.BANK_GL, statementDate: today, statementBalance: gl });
    expect(started.statusCode, text(started)).toBe(201);
    const rec = String((started.body as { data: { id: string } }).data.id);
    expect((await bankState(bankTx)).reconciliation_id).toBe(rec); // stamped by start

    if (complete) {
      const done = await fx.call(bankReconciliationsAction, 'POST', { action: 'complete', reconciliationId: rec });
      expect(done.statusCode, text(done)).toBe(200);
      expect((await q('SELECT status FROM bank_reconciliations WHERE id = $1', [rec])).rows[0].status).toBe('completed');
    }
    const alloc = await act({ action: 'allocate', bankTransactionId: bankTx, allocationType: 'supplier', entityId: ids.SUP_A2 });
    expect(alloc.statusCode, text(alloc)).toBe(200);
    // Still allocated and still stamped: the reviewer's state.
    expect(await bankState(bankTx)).toMatchObject({ status: 'allocated', reconciliation_id: rec });
    const paymentId = String((await q(`SELECT sp.id FROM supplier_payments sp JOIN gl_journal_lines l
      ON l.journal_entry_id = sp.gl_journal_entry_id JOIN bank_transactions bt ON bt.matched_journal_line_id = l.id
      WHERE bt.id = $1`, [bankTx])).rows[0].id);
    return { billId, bankTx, paymentId, rec };
  }
  async function freed(a: { billId: string; bankTx: string; paymentId: string }) {
    expect(await bankState(a.bankTx)).toEqual(FREED);
    expect(await billState(fx.pool, a.billId)).toEqual({ paid: 0, status: 'approved' });
    expect(await f.paymentStatus(a.paymentId)).toBe('cancelled');
  }

  beforeAll(async () => {
    assertDisposable();
    fx = await setUpFixture('K064 stamp');
    const yr = new Date().getFullYear();
    await q(`INSERT INTO fiscal_periods (company_id, period_name, period_number, fiscal_year, start_date, end_date, status)
      VALUES ($1, $2, 1, $3, $4, $5, 'open')`, [ids.A, `FY${yr}`, yr, `${yr}-01-01`, `${yr}-12-31`]);
  });
  afterAll(async () => {
    await fx?.pool.query('UPDATE bank_transactions SET reconciliation_id = NULL, auto_post_run_id = NULL WHERE company_id = $1', [ids.A]);
    await fx?.pool.query('DELETE FROM bank_reconciliations WHERE company_id = $1', [ids.A]);
    await fx?.pool.query('DELETE FROM bank_auto_post_runs WHERE company_id = $1', [ids.A]);
    await tearDownFixture(fx?.pool);
  });

  it("the reviewer's repro: a completed session's stale stamp on an allocated line → bank reverse is 200 and frees the line", async () => {
    const a = await stampedAllocation(true);
    const state = await act({ action: 'reverse', bankTransactionId: a.bankTx });
    expect(state.statusCode, text(state)).toBe(200);
    await freed(a);
  });

  it('the same line voids through the REST route: 200, line freed', async () => {
    const a = await stampedAllocation(true);
    const state = await f.paymentAction('void', a.paymentId);
    expect(state.statusCode, text(state)).toBe(200);
    await freed(a);
  });

  it('the same line voids through MCP void_payment: no refusal, line freed', async () => {
    const a = await stampedAllocation(true);
    const registry = new McpRegistry();
    registry.register(voidPaymentTool);
    const result = await inRequest(() => registry.call('void_payment',
      { payment_id: a.paymentId, idempotency_key: randomUUID() },
      { userId: ids.USER, companyId: ids.A, scopes: ['write:invoices', 'write:post'], tokenJti: 'k064', oauthAppId: null } as never));
    expect(result.isError, JSON.stringify(result)).toBeFalsy();
    await freed(a);
  });

  it('auto-post undo reverses it — not a reconciled skip', async () => {
    const a = await stampedAllocation(true);
    const run = String((await q(`INSERT INTO bank_auto_post_runs (company_id, source, min_confidence, amount_cap,
      created_by, posted_count, total_amount) VALUES ($1, 'categorization', 0.9, 0, $2, 1, 115) RETURNING id`,
    [ids.A, ids.USER])).rows[0].id);
    await q('UPDATE bank_transactions SET auto_post_run_id = $1 WHERE id = $2', [run, a.bankTx]);
    const result = await inRequest(() => undoRun(ids.A, run, ids.USER));
    expect(result.skippedBy, JSON.stringify(result)).toMatchObject({ reconciled: 0, failed: 0 });
    await freed(a);
  });

  it('allocated INSIDE the session and then completed: the line is reconciled, and bank reverse refuses it', async () => {
    await bill(fx.pool, { supplier: ids.SUP_A2, status: 'approved', total: 115 });
    const bankTx = randomUUID();
    await q(`INSERT INTO bank_transactions (id, company_id, bank_account_id, transaction_date, amount, description, status)
      VALUES ($1, $2, $3, CURRENT_DATE, -115, 'K064 counted', 'imported')`, [bankTx, ids.A, ids.BANK_GL]);
    const gl = Number((await q(`SELECT COALESCE(SUM(jl.debit) - SUM(jl.credit), 0) AS b FROM gl_journal_lines jl
      JOIN gl_journal_entries je ON je.id = jl.journal_entry_id WHERE jl.gl_account_id = $1 AND jl.company_id = $2
      AND je.status = 'posted' AND je.entry_date <= $3`, [ids.BANK_GL, ids.A, today])).rows[0].b);
    // The statement already shows the -115 the allocation is about to post.
    const started = await fx.call(bankReconciliations, 'POST',
      { bankAccountId: ids.BANK_GL, statementDate: today, statementBalance: gl - 115 });
    expect(started.statusCode, text(started)).toBe(201);
    const rec = String((started.body as { data: { id: string } }).data.id);
    const alloc = await act({ action: 'allocate', bankTransactionId: bankTx, allocationType: 'supplier', entityId: ids.SUP_A2 });
    expect(alloc.statusCode, text(alloc)).toBe(200);
    // Completion recomputes the live GL (now gl - 115): difference R0.00.
    const done = await fx.call(bankReconciliationsAction, 'POST', { action: 'complete', reconciliationId: rec });
    expect(done.statusCode, text(done)).toBe(200);
    expect(await bankState(bankTx)).toMatchObject({ status: 'reconciled', reconciliation_id: rec });
    const state = await act({ action: 'reverse', bankTransactionId: bankTx });
    expect(state.statusCode, text(state)).toBe(400);
    expect(text(state)).toMatch(/completed reconciliation/);
  });

  it('while the session is still OPEN, bank reverse of the allocated line is 200 too', async () => {
    const a = await stampedAllocation(false);
    const state = await act({ action: 'reverse', bankTransactionId: a.bankTx });
    expect(state.statusCode, text(state)).toBe(200);
    await freed(a);
    const cancel = await fx.call(bankReconciliationsAction, 'POST', { action: 'cancel', reconciliationId: a.rec });
    expect(cancel.statusCode, text(cancel)).toBe(200);
  });
});
