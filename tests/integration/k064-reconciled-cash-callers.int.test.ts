// tests/integration/k064-reconciled-cash-callers.int.test.ts
//
// Hein, option (b): cash on a COMPLETED reconciliation is locked like a closed
// period until R-111 builds a reopen. The rule lives once, in
// `reverseReconciledTransaction` via `bank/reconciledCash.ts`, and every caller
// must SURFACE it properly: REST void → 400; an MCP agent → the message, not
// "the operation failed"; auto-post undo → a `reconciled` skip on the line, not
// a failed row. Each case also proves nothing was written.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
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
import { reverseBankAllocationTool } from '../../src/lib/mcp/tools/writeBankAllocate';
import { log } from '../../src/lib/logger';
import { undoRun } from '../../src/modules/accounting/services/bank/autoPostUndoService';
import bankTransactionsAction from '../../pages/api/accounting/bank-transactions-action';

const describeIfDb = process.env.DATABASE_URL && process.env.JWT_SECRET ? describe : describe.skip;

describeIfDb('reconciled cash is locked on every caller of bank reverse', () => {
  let fx: Fixture;
  const f = flow(() => fx);
  const q = (s: string, p: unknown[]) => fx.pool.query(s, p);
  const act = (body: Record<string, unknown>) => fx.call(bankTransactionsAction, 'POST', body);
  const today = new Date().toISOString().slice(0, 10);
  const contrasOf = async (paymentId: string) => Number((await q(`SELECT count(*) AS n FROM gl_journal_entries r
    JOIN supplier_payments sp ON sp.gl_journal_entry_id = r.reversal_of_id WHERE sp.id = $1`, [paymentId])).rows[0].n);

  const mcpCtx = (scopes: string[]) => ({
    userId: ids.USER, companyId: ids.A, scopes, companyRole: 'owner', tokenJti: 'k064', oauthAppId: null,
  }) as never;

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
   * A -115 supplier allocation over one bill, then its line put on a
   * reconciliation as a figure it counts: 'reconciled' on a completed one, or
   * 'matched' (the session's own set). A stamp alone never locks — see
   * k064-stamp-is-not-a-lock.int.test.ts.
   */
  async function lockedAllocation(opts: { status?: 'reconciled' | 'matched'; recStatus?: string } = {}) {
    const billId = await bill(fx.pool, { supplier: ids.SUP_A2, status: 'approved', total: 115 });
    const bankTx = randomUUID();
    await q(`INSERT INTO bank_transactions (id, company_id, bank_account_id, transaction_date, amount, description, status)
      VALUES ($1, $2, $3, CURRENT_DATE, -115, 'K064 callers', 'imported')`, [bankTx, ids.A, ids.BANK_GL]);
    expect((await act({ action: 'allocate', bankTransactionId: bankTx, allocationType: 'supplier', entityId: ids.SUP_A2 })).statusCode).toBe(200);
    const paymentId = String((await q(`SELECT sp.id FROM supplier_payments sp JOIN gl_journal_lines l
      ON l.journal_entry_id = sp.gl_journal_entry_id JOIN bank_transactions bt ON bt.matched_journal_line_id = l.id
      WHERE bt.id = $1`, [bankTx])).rows[0].id);
    const rec = randomUUID();
    await q(`INSERT INTO bank_reconciliations (id, company_id, bank_account_id, statement_date, status, started_by)
      VALUES ($1, $2, $3, CURRENT_DATE, $4, $5)`, [rec, ids.A, ids.BANK_GL, opts.recStatus ?? 'completed', ids.USER]);
    await q('UPDATE bank_transactions SET reconciliation_id = $1, status = $2 WHERE id = $3',
      [rec, opts.status ?? 'reconciled', bankTx]);
    return { billId, bankTx, paymentId };
  }
  async function untouched(a: { billId: string; bankTx: string; paymentId: string }, status: string) {
    expect((await q('SELECT status FROM bank_transactions WHERE id = $1', [a.bankTx])).rows[0].status).toBe(status);
    expect(await billState(fx.pool, a.billId)).toEqual({ paid: 115, status: 'paid' });
    expect(await f.paymentStatus(a.paymentId)).not.toBe('cancelled');
    expect(await contrasOf(a.paymentId)).toBe(0);
  }

  beforeAll(async () => {
    assertDisposable();
    fx = await setUpFixture('K064 callers');
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

  // D12: a COMPLETED reconciliation is the shared 409 on every caller, naming it; reopen is the remedy.
  it('REST void → 409 naming the reconciliation, nothing written', async () => {
    const a = await lockedAllocation();
    const state = await f.paymentAction('void', a.paymentId);
    expect(state.statusCode, text(state)).toBe(409);
    expect(text(state)).toContain(`The bank reconciliation of R068 Bank to ${today} is completed — reopen it first`);
    await untouched(a, 'reconciled');
  });

  it("REST bank reverse → 409 for a 'matched' line on a completed reconciliation (the fail-closed arm)", async () => {
    const a = await lockedAllocation({ status: 'matched' });
    const state = await act({ action: 'reverse', bankTransactionId: a.bankTx });
    expect(state.statusCode, text(state)).toBe(409);
    expect(text(state)).toContain('The bank reconciliation of R068 Bank');
    expect(text(state)).toContain('is completed — reopen it first');
    await untouched(a, 'matched');
  });

  it('MCP void_payment through the registry → the agent reads the refusal, not a generic failure', async () => {
    const a = await lockedAllocation();
    const registry = new McpRegistry();
    registry.register(voidPaymentTool);
    const result = await inRequest(() => registry.call('void_payment',
      { payment_id: a.paymentId, idempotency_key: randomUUID() }, mcpCtx(['write:invoices', 'write:post'])));
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain(`The bank reconciliation of R068 Bank to ${today} is completed — reopen it first`);
    await untouched(a, 'reconciled');
  });

  it('MCP reverse_bank_allocation through the registry → the agent reads the refusal', async () => {
    const a = await lockedAllocation();
    const registry = new McpRegistry();
    registry.register(reverseBankAllocationTool);
    const result = await inRequest(() => registry.call('reverse_bank_allocation',
      { transaction_id: a.bankTx, idempotency_key: randomUUID() }, mcpCtx(['write:bank-tx', 'write:post'])));
    expect(result.isError, JSON.stringify(result)).toBe(true);
    expect(result.content[0]!.text).toContain(`The bank reconciliation of R068 Bank to ${today} is completed — reopen it first`);
    await untouched(a, 'reconciled');
  });

  it('an unclassified Error or a pg error thrown by a tool still comes back GENERIC, and is logged', async () => {
    const registry = new McpRegistry();
    const thrower = (err: Error) => ({ name: 'k064_thrower', description: 'x', scope: 'write:invoices', write: true,
      requiresPost: false, inputSchema: { type: 'object', properties: { idempotency_key: { type: 'string' } } },
      handler: async () => { throw err; } });
    const logged = vi.spyOn(log, 'error');
    for (const err of [new Error('internal detail'),
      Object.assign(new Error('duplicate key value violates unique constraint "x"'), { code: '23505' })]) {
      const reg = new McpRegistry();
      reg.register(thrower(err) as never);
      const r = await inRequest(() => reg.call('k064_thrower', { idempotency_key: randomUUID() }, mcpCtx(['write:invoices'])));
      expect(r.isError).toBe(true);
      expect(r.content[0]!.text).not.toContain(err.message);
    }
    expect(logged.mock.calls.some((c) => c[0] === 'MCP tool handler failed')).toBe(true);
    logged.mockRestore();
    void registry;
  });

  it("auto-post undo's LOCKED re-check: a completion that commits after the fast path still makes it a 'reconciled' skip", async () => {
    // Allocated, NOT yet on a reconciliation: the unlocked fast path lets it through.
    const billId = await bill(fx.pool, { supplier: ids.SUP_A2, status: 'approved', total: 115 });
    const bankTx = randomUUID();
    await q(`INSERT INTO bank_transactions (id, company_id, bank_account_id, transaction_date, amount, description, status)
      VALUES ($1, $2, $3, CURRENT_DATE, -115, 'K064 race', 'imported')`, [bankTx, ids.A, ids.BANK_GL]);
    expect((await act({ action: 'allocate', bankTransactionId: bankTx, allocationType: 'supplier', entityId: ids.SUP_A2 })).statusCode).toBe(200);
    const run = String((await q(`INSERT INTO bank_auto_post_runs (company_id, source, min_confidence, amount_cap,
      created_by, posted_count, total_amount) VALUES ($1, 'categorization', 0.9, 0, $2, 1, 115) RETURNING id`,
    [ids.A, ids.USER])).rows[0].id);
    await q('UPDATE bank_transactions SET auto_post_run_id = $1 WHERE id = $2', [run, bankTx]);
    const rec = randomUUID();
    await q(`INSERT INTO bank_reconciliations (id, company_id, bank_account_id, statement_date, status, started_by)
      VALUES ($1, $2, $3, CURRENT_DATE, 'completed', $4)`, [rec, ids.A, ids.BANK_GL, ids.USER]);

    // A "completion" holds the row, writes the reconciliation onto it, and
    // commits only after the undo has read the line in its fast path.
    // D12: the stamp MOVED while the undo waited on the line (peeked NULL, locked as `rec`), so its session could no
    // longer be taken in order — the undo is refused as contention with nothing written, and the retry skips it.
    const holder: PoolClient = await getPoolForTests().connect();
    try {
      await holder.query('BEGIN');
      await holder.query("UPDATE bank_transactions SET status = 'reconciled', reconciliation_id = $1 WHERE id = $2", [rec, bankTx]);
      const undo = inRequest(() => undoRun(ids.A, run, ids.USER)).then(() => null, (e: unknown) => e);
      await new Promise((r) => setTimeout(r, 400));
      await holder.query('COMMIT');
      expect((await undo as { code?: string } | null)?.code).toBe('BANK_TX_LOCK_TIMEOUT');
    } finally { holder.release(); }
    const result = await inRequest(() => undoRun(ids.A, run, ids.USER));
    expect(result.skippedBy).toMatchObject({ reconciled: 1, failed: 0 });
    expect(await billState(fx.pool, billId)).toEqual({ paid: 115, status: 'paid' });
    expect((await q('SELECT status FROM bank_transactions WHERE id = $1', [bankTx])).rows[0].status).toBe('reconciled');
  }, 20000);

  it("auto-post undo on a line MATCHED in an IN-PROGRESS session skips it — not detached, one rule with bank reverse", async () => {
    const a = await lockedAllocation({ status: 'matched', recStatus: 'in_progress' });
    const run = String((await q(`INSERT INTO bank_auto_post_runs (company_id, source, min_confidence, amount_cap,
      created_by, posted_count, total_amount) VALUES ($1, 'categorization', 0.9, 0, $2, 1, 115) RETURNING id`,
    [ids.A, ids.USER])).rows[0].id);
    await q('UPDATE bank_transactions SET auto_post_run_id = $1 WHERE id = $2', [run, a.bankTx]);
    const result = await inRequest(() => undoRun(ids.A, run, ids.USER));
    expect(result.skippedBy).toMatchObject({ reconciled: 1, failed: 0 });
    expect((await q('SELECT reconciliation_id FROM bank_transactions WHERE id = $1', [a.bankTx])).rows[0].reconciliation_id).not.toBeNull();
    await untouched(a, 'matched');
  });

  it("auto-post undo → a reconciled SKIP for a 'matched' line on a completed reconciliation, not a failed row", async () => {
    const a = await lockedAllocation({ status: 'matched' });
    const run = String((await q(`INSERT INTO bank_auto_post_runs (company_id, source, min_confidence, amount_cap,
      created_by, posted_count, total_amount) VALUES ($1, 'categorization', 0.9, 0, $2, 1, 115) RETURNING id`,
    [ids.A, ids.USER])).rows[0].id);
    await q('UPDATE bank_transactions SET auto_post_run_id = $1 WHERE id = $2', [run, a.bankTx]);
    const result = await inRequest(() => undoRun(ids.A, run, ids.USER));
    expect(result.skippedBy).toMatchObject({ reconciled: 1, failed: 0 });
    await untouched(a, 'matched');
  });
});
