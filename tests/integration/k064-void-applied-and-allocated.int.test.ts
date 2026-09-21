// tests/integration/k064-void-applied-and-allocated.int.test.ts
//
// Round 8 (Hein): a FULLY APPLIED supplier payment — status 'reconciled', which
// on a supplier payment means "nothing left unapplied", not "bank-reconciled" —
// can be voided. What stays refused is cash on a completed bank reconciliation,
// decided by the BANK LINE (one rule, shared with batch reversal). And a payment
// whose journal a bank ALLOCATION posted is voided through the app route the
// way MCP void_payment does it: bills, payment, contra and bank line together.

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
import supplierAllocations from '../../pages/api/accounting/supplier-allocations';

const describeIfDb = process.env.DATABASE_URL && process.env.JWT_SECRET ? describe : describe.skip;

describeIfDb('K-064 round 8 — voiding applied and bank-allocated supplier payments', () => {
  let fx: Fixture;
  const f = flow(() => fx);
  const q = (s: string, p: unknown[]) => fx.pool.query(s, p);
  const net = async (gl: string) => Number((await q(`SELECT COALESCE(SUM(l.debit - l.credit), 0) AS n
    FROM gl_journal_lines l JOIN gl_journal_entries e ON e.id = l.journal_entry_id
    WHERE l.gl_account_id = $1 AND e.status = 'posted'`, [gl])).rows[0].n);
  const balanced = async () => {
    const { rows } = await q(`SELECT SUM(l.debit) AS dr, SUM(l.credit) AS cr FROM gl_journal_lines l
      JOIN gl_journal_entries e ON e.id = l.journal_entry_id WHERE e.company_id = $1 AND e.status = 'posted'`, [ids.A]);
    return Number(rows[0].dr) === Number(rows[0].cr);
  };
  const journalOf = async (paymentId: string) => String((await q(
    'SELECT gl_journal_entry_id FROM supplier_payments WHERE id = $1', [paymentId])).rows[0].gl_journal_entry_id);
  const contras = async (journalId: string) => Number((await q(
    "SELECT count(*) AS n FROM gl_journal_entries WHERE reversal_of_id = $1 AND status = 'posted'", [journalId])).rows[0].n);
  const bankState = async (id: string) => (await q(
    'SELECT status, matched_journal_line_id, reconciliation_id FROM bank_transactions WHERE id = $1', [id])).rows[0];
  async function bankLine(amount: number): Promise<string> {
    const id = randomUUID();
    await q(`INSERT INTO bank_transactions (id, company_id, bank_account_id, transaction_date, amount, description, status)
      VALUES ($1, $2, $3, CURRENT_DATE, $4, 'K064 round 8', 'imported')`, [id, ids.A, ids.BANK_GL, amount]);
    return id;
  }
  const act = (body: Record<string, unknown>) => fx.call(bankTransactionsAction, 'POST', body);

  /** A 1000 payment, processed against X (600), then applied to Y (400): fully applied, 'reconciled'. */
  async function fullyApplied(): Promise<{ paymentId: string; x: string; y: string; bankTx: string }> {
    const [x, y] = [await bill(fx.pool, { supplier: ids.SUP_A, status: 'approved' }),
      await bill(fx.pool, { supplier: ids.SUP_A, status: 'approved' })];
    const made = await fx.call((await import('../../pages/api/accounting/supplier-payments')).default, 'POST', {
      supplierId: ids.SUP_A, paymentDate: new Date().toISOString().slice(0, 10), totalAmount: 1000,
      reference: 'K064-R8', allocations: [{ invoiceId: x, amount: 600 }] });
    expect(made.statusCode, text(made)).toBe(201);
    const paymentId = f.idOf(made);
    expect((await f.paymentAction('approve', paymentId)).statusCode).toBe(200);
    expect((await f.paymentAction('process', paymentId)).statusCode).toBe(200);
    const applied = await fx.call(supplierAllocations, 'POST', { paymentId, allocations: [{ invoiceId: y, amount: 400 }] });
    expect(applied.statusCode, text(applied)).toBe(200);
    expect(await f.paymentStatus(paymentId)).toBe('reconciled');
    const bankTx = await bankLine(-1000);
    const line = (await q('SELECT id FROM gl_journal_lines WHERE journal_entry_id = $1 AND credit > 0', [await journalOf(paymentId)])).rows[0].id;
    expect((await act({ action: 'match', bankTransactionId: bankTx, journalLineId: line })).statusCode).toBe(200);
    return { paymentId, x, y, bankTx };
  }

  beforeAll(async () => {
    assertDisposable();
    fx = await setUpFixture('K064 r8');
    const yr = new Date().getFullYear();
    await q(`INSERT INTO fiscal_periods (company_id, period_name, period_number, fiscal_year, start_date, end_date, status)
      VALUES ($1, $2, 1, $3, $4, $5, 'open')`, [ids.A, `FY${yr}`, yr, `${yr}-01-01`, `${yr}-12-31`]);
  });
  afterAll(async () => {
    await fx?.pool.query('UPDATE bank_transactions SET reconciliation_id = NULL WHERE company_id = $1', [ids.A]);
    await fx?.pool.query('DELETE FROM bank_reconciliations WHERE company_id = $1', [ids.A]);
    await tearDownFixture(fx?.pool);
  });

  it('voids a fully applied payment across 2 bills: each reopens by its share, one contra, books and bank line restored', async () => {
    const before = { ap: await net(ids.AP_GL), bank: await net(ids.BANK_GL) };
    const { paymentId, x, y, bankTx } = await fullyApplied();
    expect(await net(ids.AP_GL)).toBe(before.ap + 1000);

    const voided = await f.paymentAction('void', paymentId);

    expect(voided.statusCode, text(voided)).toBe(200);
    expect(await billState(fx.pool, x)).toEqual({ paid: 0, status: 'approved' });
    expect(await billState(fx.pool, y)).toEqual({ paid: 0, status: 'approved' });
    expect(await f.paymentStatus(paymentId)).toBe('cancelled');
    expect(await contras(await journalOf(paymentId))).toBe(1);
    expect(await net(ids.AP_GL)).toBe(before.ap);
    expect(await net(ids.BANK_GL)).toBe(before.bank);
    expect(await balanced()).toBe(true);
    expect(await bankState(bankTx)).toEqual({ status: 'imported', matched_journal_line_id: null, reconciliation_id: null });
    // Released: X takes a fresh full payment.
    expect((await f.createPayment(x, 1000)).statusCode).toBe(201);
  });

  it.each(['completed', 'in_progress'])('refuses when the bank line is on a %s bank reconciliation, writing nothing', async (recStatus) => {
    const { paymentId, x, bankTx } = await fullyApplied();
    const recId = randomUUID();
    await q(`INSERT INTO bank_reconciliations (id, company_id, bank_account_id, statement_date, status, started_by)
      VALUES ($1, $2, $3, CURRENT_DATE, $4, $5)`, [recId, ids.A, ids.BANK_GL, recStatus, ids.USER]);
    await q(`UPDATE bank_transactions SET reconciliation_id = $1, status = $2 WHERE id = $3`,
      [recId, recStatus === 'completed' ? 'reconciled' : 'matched', bankTx]);
    const ap = await net(ids.AP_GL);

    const state = await f.paymentAction('void', paymentId);

    expect(state.statusCode, text(state)).toBe(400);
    expect(text(state)).toContain(recStatus === 'completed' ? 'completed bank reconciliation' : 'open bank reconciliation session');
    expect(await f.paymentStatus(paymentId)).toBe('reconciled');
    expect(await billState(fx.pool, x)).toEqual({ paid: 600, status: 'partially_paid' });
    expect(await contras(await journalOf(paymentId))).toBe(0);
    expect(await net(ids.AP_GL)).toBe(ap);
  });

  it('refuses a MATCHED line whose reconciliation_id names a completed reconciliation (the id arm, not the status)', async () => {
    const { paymentId, x, bankTx } = await fullyApplied();
    const recId = randomUUID();
    await q(`INSERT INTO bank_reconciliations (id, company_id, bank_account_id, statement_date, status, started_by)
      VALUES ($1, $2, $3, CURRENT_DATE, 'completed', $4)`, [recId, ids.A, ids.BANK_GL, ids.USER]);
    // Status stays 'matched': attached to the session, matched after it completed.
    await q('UPDATE bank_transactions SET reconciliation_id = $1 WHERE id = $2', [recId, bankTx]);
    const state = await f.paymentAction('void', paymentId);
    expect(state.statusCode, text(state)).toBe(400);
    expect(text(state)).toContain('completed bank reconciliation');
    expect(await billState(fx.pool, x)).toEqual({ paid: 600, status: 'partially_paid' });
    expect(await contras(await journalOf(paymentId))).toBe(0);
  });

  /** A supplier bank ALLOCATION of a 115 line against one 115 bill → the payment and its journal. */
  async function allocatedPayment(): Promise<{ bankTx: string; billId: string; paymentId: string }> {
    const billId = await bill(fx.pool, { supplier: ids.SUP_A2, status: 'approved', total: 115 });
    const bankTx = await bankLine(-115);
    const r = await act({ action: 'allocate', bankTransactionId: bankTx, allocationType: 'supplier',
      entityId: ids.SUP_A2, description: 'K064 r8 allocation' });
    expect(r.statusCode, text(r)).toBe(200);
    expect((await bankState(bankTx)).status).toBe('allocated');
    const paymentId = String((await q(`SELECT sp.id FROM supplier_payments sp JOIN gl_journal_lines l
      ON l.journal_entry_id = sp.gl_journal_entry_id JOIN bank_transactions bt ON bt.matched_journal_line_id = l.id
      WHERE bt.id = $1`, [bankTx])).rows[0].id);
    return { bankTx, billId, paymentId };
  }
  const endState = async (a: { bankTx: string; billId: string; paymentId: string }) => ({
    bank: await bankState(a.bankTx), bill: await billState(fx.pool, a.billId),
    payment: await f.paymentStatus(a.paymentId), contras: await contras(await journalOf(a.paymentId)),
  });

  it('refuses a journal claimed by TWO bank lines (allocated + another), as MCP void_payment does', async () => {
    const a = await allocatedPayment();
    const apLine = (await q('SELECT id FROM gl_journal_lines WHERE journal_entry_id = $1 AND debit > 0 LIMIT 1',
      [await journalOf(a.paymentId)])).rows[0].id;
    const second = await bankLine(-115);
    await q("UPDATE bank_transactions SET status = 'allocated', matched_journal_line_id = $1 WHERE id = $2", [apLine, second]);
    const state = await f.paymentAction('void', a.paymentId);
    expect(state.statusCode, text(state)).toBe(400);
    expect(text(state)).toContain('more than one bank line');
    expect((await bankState(a.bankTx)).status).toBe('allocated');
    expect(await f.paymentStatus(a.paymentId)).not.toBe('cancelled');
    expect(await contras(await journalOf(a.paymentId))).toBe(0);
    await q("UPDATE bank_transactions SET status = 'imported', matched_journal_line_id = NULL WHERE id = $1", [second]);
  });

  it("review r7's repro: a -1500 allocation over one 1000 bill (500 unapplied) voids with the line FREE to re-allocate", async () => {
    const supplier = randomUUID();
    await q("INSERT INTO suppliers (id, company_id, name) VALUES ($1, $2, 'K064 r8 repro supplier')", [supplier, ids.A]);
    const billId = await bill(fx.pool, { supplier, status: 'approved', total: 1000 });
    const bankTx = await bankLine(-1500);
    const before = { ap: await net(ids.AP_GL), bank: await net(ids.BANK_GL) };
    const r = await act({ action: 'allocate', bankTransactionId: bankTx, allocationType: 'supplier',
      entityId: supplier, description: 'K064 r8 repro' });
    expect(r.statusCode, text(r)).toBe(200);
    const paymentId = String((await q(`SELECT sp.id FROM supplier_payments sp JOIN gl_journal_lines l
      ON l.journal_entry_id = sp.gl_journal_entry_id JOIN bank_transactions bt ON bt.matched_journal_line_id = l.id
      WHERE bt.id = $1`, [bankTx])).rows[0].id);
    expect(await f.paymentStatus(paymentId)).toBe('processed'); // 500 left unapplied
    expect(await billState(fx.pool, billId)).toEqual({ paid: 1000, status: 'paid' });

    const voided = await f.paymentAction('void', paymentId);

    expect(voided.statusCode, text(voided)).toBe(200);
    expect(await bankState(bankTx)).toEqual({ status: 'imported', matched_journal_line_id: null, reconciliation_id: null });
    expect(await billState(fx.pool, billId)).toEqual({ paid: 0, status: 'approved' });
    expect(await f.paymentStatus(paymentId)).toBe('cancelled');
    expect(await net(ids.AP_GL)).toBe(before.ap);
    expect(await net(ids.BANK_GL)).toBe(before.bank);
    // Not stuck: the same statement line allocates again.
    const again = await act({ action: 'allocate', bankTransactionId: bankTx, allocationType: 'supplier',
      entityId: supplier, description: 'K064 r8 repro again' });
    expect(again.statusCode, text(again)).toBe(200);
    expect((await bankState(bankTx)).status).toBe('allocated');
  });

  it('voids a bank-ALLOCATED payment through the app route to the same end state as MCP void_payment', async () => {
    const viaRoute = await allocatedPayment();
    const apBefore = await net(ids.AP_GL);
    const voided = await f.paymentAction('void', viaRoute.paymentId);
    expect(voided.statusCode, text(voided)).toBe(200);
    const apAfterRoute = await net(ids.AP_GL);

    const viaMcp = await allocatedPayment();
    const client: PoolClient = await getPoolForTests().connect();
    try {
      await client.query('BEGIN');
      await als.run({ client, userId: ids.USER, companyId: ids.A, claims: { sub: ids.USER } } as never,
        () => voidPaymentDocument(ids.A, 'supplier', viaMcp.paymentId, ids.USER));
      await client.query('COMMIT');
    } finally { client.release(); }

    const expected = { bank: { status: 'imported', matched_journal_line_id: null, reconciliation_id: null },
      bill: { paid: 0, status: 'approved' }, payment: 'cancelled', contras: 1 };
    expect(await endState(viaRoute)).toEqual(expected);
    expect(await endState(viaMcp)).toEqual(expected);
    expect(apAfterRoute).toBe(apBefore - 115);
    expect(await balanced()).toBe(true);
  });
});
