// tests/integration/k064-reconciled-cash-callers.int.test.ts
//
// Hein, option (b): cash on a COMPLETED reconciliation is locked like a closed
// period until R-111 builds a reopen. The rule lives once, in
// `reverseReconciledTransaction` via `bank/reconciledCash.ts`, and every caller
// must SURFACE it properly: REST void → 400; an MCP agent → the message, not
// "the operation failed"; auto-post undo → a `reconciled` skip on the line, not
// a failed row. Each case also proves nothing was written.

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

const describeIfDb = process.env.DATABASE_URL && process.env.JWT_SECRET ? describe : describe.skip;

describeIfDb('reconciled cash is locked on every caller of bank reverse', () => {
  let fx: Fixture;
  const f = flow(() => fx);
  const q = (s: string, p: unknown[]) => fx.pool.query(s, p);
  const act = (body: Record<string, unknown>) => fx.call(bankTransactionsAction, 'POST', body);
  const today = new Date().toISOString().slice(0, 10);
  const contrasOf = async (paymentId: string) => Number((await q(`SELECT count(*) AS n FROM gl_journal_entries r
    JOIN supplier_payments sp ON sp.gl_journal_entry_id = r.reversal_of_id WHERE sp.id = $1`, [paymentId])).rows[0].n);

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

  /** A -115 supplier allocation over one bill, then its line put on a completed reconciliation. */
  async function lockedAllocation(opts: { byIdOnly?: boolean } = {}) {
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
      VALUES ($1, $2, $3, CURRENT_DATE, 'completed', $4)`, [rec, ids.A, ids.BANK_GL, ids.USER]);
    // byIdOnly: still 'allocated' by status, but attached to the completed rec.
    await q('UPDATE bank_transactions SET reconciliation_id = $1, status = $2 WHERE id = $3',
      [rec, opts.byIdOnly ? 'allocated' : 'reconciled', bankTx]);
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

  it('REST void → 400 naming the reconciliation, nothing written', async () => {
    const a = await lockedAllocation();
    const state = await f.paymentAction('void', a.paymentId);
    expect(state.statusCode, text(state)).toBe(400);
    expect(text(state)).toContain(`is on the completed reconciliation of R068 Bank to ${today}`);
    expect(text(state)).toContain("can't be reopened yet");
    await untouched(a, 'reconciled');
  });

  it('REST bank reverse → 400 for a line attached to a completed reconciliation by id only', async () => {
    const a = await lockedAllocation({ byIdOnly: true });
    const state = await act({ action: 'reverse', bankTransactionId: a.bankTx });
    expect(state.statusCode, text(state)).toBe(400);
    expect(text(state)).toContain('This bank line is on the completed reconciliation of R068 Bank');
    await untouched(a, 'allocated');
  });

  it('MCP void_payment through the registry → the agent reads the refusal, not a generic failure', async () => {
    const a = await lockedAllocation();
    const registry = new McpRegistry();
    registry.register(voidPaymentTool);
    const result = await inRequest(() => registry.call('void_payment', { payment_id: a.paymentId, idempotency_key: randomUUID() }, {
      userId: ids.USER, companyId: ids.A, scopes: ['write:invoices', 'write:post'], tokenJti: 'k064', oauthAppId: null,
    } as never));
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('is on the completed reconciliation of R068 Bank');
    expect(result.content[0]!.text).toContain('Correct it with a journal, or contact support');
    await untouched(a, 'reconciled');
  });

  it('auto-post undo → a reconciled SKIP on the line (by id, not only by status), not a failed row', async () => {
    const a = await lockedAllocation({ byIdOnly: true });
    const run = String((await q(`INSERT INTO bank_auto_post_runs (company_id, source, min_confidence, amount_cap,
      created_by, posted_count, total_amount) VALUES ($1, 'categorization', 0.9, 0, $2, 1, 115) RETURNING id`,
    [ids.A, ids.USER])).rows[0].id);
    await q('UPDATE bank_transactions SET auto_post_run_id = $1 WHERE id = $2', [run, a.bankTx]);
    const result = await inRequest(() => undoRun(ids.A, run, ids.USER));
    expect(result.skippedBy).toMatchObject({ reconciled: 1, failed: 0 });
    await untouched(a, 'allocated');
  });
});
