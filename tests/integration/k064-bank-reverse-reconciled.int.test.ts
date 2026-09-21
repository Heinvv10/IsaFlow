// tests/integration/k064-bank-reverse-reconciled.int.test.ts
//
// Review r8 MEDIUM-1 (Hein: lock now, reopen later — R-111). Bank reverse
// (`reverseReconciledTransaction`: the bank screen's `reverse`, and MCP
// void_payment through it) reversed a line on a COMPLETED reconciliation with
// 200 — payment cancelled, bill reopened, contra posted, line detached — while
// the reconciliation still read "completed". It now refuses such a line, and a
// Sage-imported reconciled line, by the shared rule (`bank/reconciledCash.ts`)
// void and batch reversal use: 400, nothing written, no pointer to a remedy
// that does not exist. A line in an in-progress session is not refused here.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { ids, setUpFixture, tearDownFixture, type Fixture } from './supplier-ownership-fence.helpers';
import { bill, billState } from './ap-allocation-guards.helpers';
import { flow, text } from './ap-payment-flow.helpers';
import { als } from '../../src/lib/als';
import { getPoolForTests } from '../../src/lib/neon';
import { voidPaymentDocument } from '../../src/modules/accounting/services/core/paymentVoidService';
import bankTransactionsAction from '../../pages/api/accounting/bank-transactions-action';
import bankReconciliationsAction from '../../pages/api/accounting/bank-reconciliations-action';

const describeIfDb = process.env.DATABASE_URL && process.env.JWT_SECRET ? describe : describe.skip;

describeIfDb('K-064 r9 — bank reverse refuses cash a completed or Sage reconciliation holds', () => {
  let fx: Fixture;
  const f = flow(() => fx);
  const q = (s: string, p: unknown[]) => fx.pool.query(s, p);
  const act = (body: Record<string, unknown>) => fx.call(bankTransactionsAction, 'POST', body);
  const bankState = async (id: string) => (await q(
    'SELECT status, reconciliation_id FROM bank_transactions WHERE id = $1', [id])).rows[0];
  const contrasOf = async (paymentId: string) => Number((await q(`SELECT count(*) AS n FROM gl_journal_entries r
    JOIN supplier_payments sp ON sp.gl_journal_entry_id = r.reversal_of_id WHERE sp.id = $1`, [paymentId])).rows[0].n);
  const today = new Date().toISOString().slice(0, 10);

  /** A supplier allocation of a -115 line over one 115 bill → the payment it created. */
  async function allocated(): Promise<{ bankTx: string; billId: string; paymentId: string }> {
    const billId = await bill(fx.pool, { supplier: ids.SUP_A2, status: 'approved', total: 115 });
    const bankTx = randomUUID();
    await q(`INSERT INTO bank_transactions (id, company_id, bank_account_id, transaction_date, amount, description, status)
      VALUES ($1, $2, $3, CURRENT_DATE, -115, 'K064 r9', 'imported')`, [bankTx, ids.A, ids.BANK_GL]);
    const r = await act({ action: 'allocate', bankTransactionId: bankTx, allocationType: 'supplier', entityId: ids.SUP_A2 });
    expect(r.statusCode, text(r)).toBe(200);
    const paymentId = String((await q(`SELECT sp.id FROM supplier_payments sp JOIN gl_journal_lines l
      ON l.journal_entry_id = sp.gl_journal_entry_id JOIN bank_transactions bt ON bt.matched_journal_line_id = l.id
      WHERE bt.id = $1`, [bankTx])).rows[0].id);
    return { bankTx, billId, paymentId };
  }
  async function onReconciliation(bankTx: string, status: 'completed' | 'in_progress'): Promise<void> {
    const rec = randomUUID();
    await q(`INSERT INTO bank_reconciliations (id, company_id, bank_account_id, statement_date, status, started_by)
      VALUES ($1, $2, $3, CURRENT_DATE, $4, $5)`, [rec, ids.A, ids.BANK_GL, status, ids.USER]);
    await q('UPDATE bank_transactions SET status = $1, reconciliation_id = $2 WHERE id = $3',
      // In a session only the lines it counts are held: 'matched' (a stamp alone is not a lock).
      [status === 'completed' ? 'reconciled' : 'matched', rec, bankTx]);
  }
  async function expectNothingWritten(a: { bankTx: string; billId: string; paymentId: string }, status: string) {
    expect((await bankState(a.bankTx)).status).toBe(status);
    expect(await billState(fx.pool, a.billId)).toEqual({ paid: 115, status: 'paid' });
    expect(await f.paymentStatus(a.paymentId)).not.toBe('cancelled');
    expect(await contrasOf(a.paymentId)).toBe(0);
  }

  beforeAll(async () => {
    assertDisposable();
    fx = await setUpFixture('K064 r9');
    const yr = new Date().getFullYear();
    await q(`INSERT INTO fiscal_periods (company_id, period_name, period_number, fiscal_year, start_date, end_date, status)
      VALUES ($1, $2, 1, $3, $4, $5, 'open')`, [ids.A, `FY${yr}`, yr, `${yr}-01-01`, `${yr}-12-31`]);
  });
  afterAll(async () => {
    await fx?.pool.query('UPDATE bank_transactions SET reconciliation_id = NULL WHERE company_id = $1', [ids.A]);
    await fx?.pool.query('DELETE FROM bank_reconciliations WHERE company_id = $1', [ids.A]);
    await tearDownFixture(fx?.pool);
  });

  it('bank reverse on a line in a COMPLETED reconciliation: 400 naming it, nothing written', async () => {
    const a = await allocated();
    await onReconciliation(a.bankTx, 'completed');
    const state = await act({ action: 'reverse', bankTransactionId: a.bankTx });
    expect(state.statusCode, text(state)).toBe(400);
    expect(text(state)).toContain(`This bank line is on the completed reconciliation of R068 Bank to ${today}`);
    expect(text(state)).toContain("A completed reconciliation can't be reopened yet");
    expect(text(state)).toContain('Correct it with a journal, or contact support');
    await expectNothingWritten(a, 'reconciled');
  });

  it('bank reverse on a Sage-imported reconciled line (no reconciliation_id): 400, names no reconciliation', async () => {
    const a = await allocated();
    await q("UPDATE bank_transactions SET status = 'reconciled' WHERE id = $1", [a.bankTx]);
    const state = await act({ action: 'reverse', bankTransactionId: a.bankTx });
    expect(state.statusCode, text(state)).toBe(400);
    expect(text(state)).toContain('was reconciled in the Sage import');
    expect(text(state)).not.toContain('completed reconciliation of');
    await expectNothingWritten(a, 'reconciled');
  });

  it("a line marked 'reconciled' on a reconciliation that isn't completed gets its own honest message", async () => {
    const a = await allocated();
    const rec = randomUUID();
    await q(`INSERT INTO bank_reconciliations (id, company_id, bank_account_id, statement_date, status, started_by)
      VALUES ($1, $2, $3, CURRENT_DATE, 'in_progress', $4)`, [rec, ids.A, ids.BANK_GL, ids.USER]);
    await q("UPDATE bank_transactions SET status = 'reconciled', reconciliation_id = $1 WHERE id = $2", [rec, a.bankTx]);
    const state = await act({ action: 'reverse', bankTransactionId: a.bankTx });
    expect(state.statusCode, text(state)).toBe(400);
    expect(text(state)).toContain("This bank line is marked reconciled on a reconciliation that isn't completed. That shouldn't happen, so contact support.");
    expect(text(state)).not.toContain("can't be reopened");
    await expectNothingWritten(a, 'reconciled');
  });

  it('MCP void_payment reaches the same refusal through bank reverse, nothing written', async () => {
    const a = await allocated();
    await onReconciliation(a.bankTx, 'completed');
    const client: PoolClient = await getPoolForTests().connect();
    let error: unknown = null;
    try {
      await client.query('BEGIN');
      await als.run({ client, userId: ids.USER, companyId: ids.A, claims: { sub: ids.USER } } as never,
        () => voidPaymentDocument(ids.A, 'supplier', a.paymentId, ids.USER)).catch((e) => { error = e; });
      await client.query('ROLLBACK');
    } finally { client.release(); }
    expect((error as { code?: string })?.code).toBe('RECONCILED_CASH');
    await expectNothingWritten(a, 'reconciled');
  });

  it('a line MATCHED in an IN-PROGRESS session is refused exactly as void refuses it; cancelling the session frees it', async () => {
    const a = await allocated();
    await onReconciliation(a.bankTx, 'in_progress');
    const rec = String((await bankState(a.bankTx)).reconciliation_id);
    const lines = async () => Number((await q('SELECT count(*) AS n FROM bank_transactions WHERE reconciliation_id = $1', [rec])).rows[0].n);
    const before = await lines();

    const state = await act({ action: 'reverse', bankTransactionId: a.bankTx });

    expect(state.statusCode, text(state)).toBe(400);
    expect(text(state)).toContain('This bank line is in an open bank reconciliation session');
    await expectNothingWritten(a, 'matched');
    expect(await lines()).toBe(before); // still in the session: not detached
    // The escape hatch: cancelling the session undoes its matching — the line is free again.
    const cancel = await fx.call(bankReconciliationsAction, 'POST', { action: 'cancel', reconciliationId: rec });
    expect(cancel.statusCode, text(cancel)).toBe(200);
    expect(await bankState(a.bankTx)).toEqual({ status: 'imported', reconciliation_id: null });
  });
});
