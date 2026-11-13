/**
 * Breaker round 2 for reallocate_bank_transaction (7ab423450e): attacks on the fixes. R2-4 asserts the safe outcome
 * of a recorded, retryable lock cycle (see the test); the others assert the fixed behaviour.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from '@/lib/neon';
import { allocateTransaction } from '@/modules/accounting/services/bank/bankAllocationService';
import { getCustomerOnAccountCredit } from '@/modules/accounting/services/ar/customerRefundDocument';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { inTx, runOn } from './helpers/l1FifoFixture';
import { postedInvoice, settle, sleep, teardown, type Ctx } from './d8-r4-helpers';
import { clearExtras } from './d10-helpers';
import { cleanup } from './d12-helpers';
import {
  TOOL, apControlAndSubledger, arControlAndSubledger, lineRow, mcp, newBank, newSupplier, postedBill,
  reconciledLine, setupCompany, trialBalanceGap,
} from './bank-reallocate-reconciled.helpers';

assertDisposable();
type Row = Record<string, unknown>;
let c: Ctx;
const key = () => randomUUID();
const realloc = async (bt: string, target: Record<string, string>, extra: Record<string, unknown> = {}) =>
  mcp(c, TOOL, { transaction_id: bt, expected_journal_entry_id: String((await lineRow(bt)).je), target,
    dry_run: false, idempotency_key: key(), ...extra });

async function plainLine(amount: number, date: string): Promise<string> {
  const bank = await newBank(c);
  return String(((await sql`INSERT INTO bank_transactions (company_id, bank_account_id, transaction_date, amount,
      description, status) VALUES (${c.fx.companyId}::UUID, ${bank}::UUID, ${date}::DATE, ${amount}, ${`R2 ${++c.seq}`},
      'imported') RETURNING id`) as Row[])[0]!.id);
}
const journalCount = async () => Number(((await sql`SELECT COUNT(*)::int AS n FROM gl_journal_entries
  WHERE company_id = ${c.fx.companyId}::UUID`) as Row[])[0]!.n);

describe('reallocate_bank_transaction breaker round 2', () => {
  beforeAll(async () => { c = await setupCompany('RABR2'); }, 120000);
  afterAll(async () => { await cleanup(c); await clearExtras(c); await teardown(c); }, 120000);

  it('R2-1 ceiling: a receipt over several invoices whose remainder was refunded is refused', async () => {
    const cust = c.fx.customerId;
    await postedInvoice(c, '2026-05-10');
    await postedInvoice(c, '2026-05-11');
    const s = await reconciledLine(c, { amount: 3000, date: '2026-06-12', statementDate: '2026-06-30', alloc: 'customer', entity: cust });
    const refund = await plainLine(-700, '2026-06-20');
    await inTx(c.fx, () => allocateTransaction(c.fx.companyId, refund, null, c.fx.userId, undefined, 'customer', cust, 'none'));
    const r = await realloc(s.bt, { gl_account_id: c.acct.sales! });
    expect(r.isError, r.text).toBe(true);
    expect((await getCustomerOnAccountCredit(c.fx.companyId, cust, '9999-12-31')).credit).toBeCloseTo(0, 2);
  }, 120000);

  it('R2-2 ceiling: a later-dated receipt satisfies the all-dates figure, but the refund is left with no credit AS AT its date', async () => {
    const cust = c.fx.customerId; // invoices from R2-1 are fully paid; anything new lands on account
    const inv = await postedInvoice(c, '2026-07-01');
    const s = await reconciledLine(c, { amount: 2000, date: '2026-07-12', statementDate: '2026-07-31', alloc: 'customer', entity: cust });
    const refund = await plainLine(-850, '2026-07-20');
    await inTx(c.fx, () => allocateTransaction(c.fx.companyId, refund, null, c.fx.userId, undefined, 'customer', cust, 'none'));
    const later = await plainLine(850, '2026-11-01'); // a later receipt, left on account
    await inTx(c.fx, () => allocateTransaction(c.fx.companyId, later, null, c.fx.userId, undefined, 'customer', cust, 'none',
      undefined, undefined, undefined, undefined, { autoApply: 'none' }));
    const atRefundBefore = (await getCustomerOnAccountCredit(c.fx.companyId, cust, '2026-07-20')).credit;
    expect(atRefundBefore).toBeGreaterThanOrEqual(0);
    const r = await realloc(s.bt, { gl_account_id: c.acct.sales! });
    const atRefund = (await getCustomerOnAccountCredit(c.fx.companyId, cust, '2026-07-20')).credit;
    // planCustomerRefund's own rule: a refund needs the credit AS AT its date.
    expect({ refused: r.isError, atRefund }, r.text).toMatchObject({ refused: true });
    void inv;
  }, 120000);

  it('R2-3 ceiling: a refund racing the reallocation (two connections) cannot both commit below zero', async () => {
    const cust = randomUUID();
    await sql`INSERT INTO customers (id, company_id, name) VALUES (${cust}::UUID, ${c.fx.companyId}::UUID, ${`R2 cust ${c.fx.tag}`})`;
    const s = await reconciledLine(c, { amount: 500, date: '2026-06-12', statementDate: '2026-06-30', alloc: 'customer', entity: cust });
    const refund = await plainLine(-500, '2026-06-20');
    const [a, b] = await Promise.all([
      realloc(s.bt, { gl_account_id: c.acct.sales! }),
      settle(inTx(c.fx, () => allocateTransaction(c.fx.companyId, refund, null, c.fx.userId, undefined, 'customer', cust, 'none'))),
    ]);
    const credit = (await getCustomerOnAccountCredit(c.fx.companyId, cust, '9999-12-31')).credit;
    expect(credit, `${a.text} | ${JSON.stringify(b)}`).toBeGreaterThanOrEqual(0);
    expect([a.isError, b.ok]).not.toEqual([false, true]);
  }, 120000);

  it('R2-4 locks: a request that already posted a journal, then FIFOs the same supplier, vs a reallocation to that supplier', async () => {
    const sup = await newSupplier(c);
    await postedBill(c, sup, '2026-05-01', 300);
    const s = await reconciledLine(c, { amount: -300, date: '2026-06-10', statementDate: '2026-06-30', alloc: 'account', contra: c.acct.expense });
    const l2 = await plainLine(-10, '2026-06-11');
    const l3 = await plainLine(-300, '2026-06-12');
    // A bulk-allocate shape on one transaction: line 2 to an account (journal number held), then line 3 to the supplier (FIFO).
    const cl = await c.fx.pool.connect();
    await cl.query('BEGIN');
    try {
      await runOn(c.fx, cl, () => allocateTransaction(c.fx.companyId, l2, c.acct.expense!, c.fx.userId, undefined, 'account'));
      const rP = realloc(s.bt, { supplier_id: sup });
      await sleep(700);
      const aP = settle(runOn(c.fx, cl, () => allocateTransaction(c.fx.companyId, l3, null, c.fx.userId, undefined, 'supplier', sup)));
      const a = await aP;
      if (a.ok) await cl.query('COMMIT'); else await cl.query('ROLLBACK');
      const r = await rP;
      // RECORDED CYCLE (bankReallocationLocks header, bank/.claude.md lock-order table): the journal-number lock vs the
      // pre-pass bills. Not moved (taking the number first would invert the refund path's contact -> number order), so
      // the SAFE outcome is asserted: at most one side is the deadlock victim, it is told to retry and wrote nothing.
      const deadlock = /deadlock|40P01/i;
      const failures = [a.ok ? null : a.error, r.isError ? r.text : null].filter((x): x is string => x !== null);
      expect(failures.length, failures.join(' | ')).toBeLessThanOrEqual(1);
      for (const f of failures) expect(f).toMatch(deadlock);
      if (r.isError) expect(r.text).toMatch(/nothing was written; retry/);
      const line = await lineRow(s.bt);
      expect(line.status).toBe('reconciled');
      if (r.isError) {
        expect(line.je, 'the refused reallocation left the line on its old journal').toBe(s.je);
        const old = ((await sql`SELECT reversed_at FROM gl_journal_entries WHERE id = ${s.je}::UUID`) as Row[])[0]!;
        expect(old.reversed_at).toBeNull();
      } else {
        expect(line.je).not.toBe(s.je);
      }
    } finally {
      cl.release();
    }
    const ap = await apControlAndSubledger(c);
    expect(ap.control).toBe(ap.subledger);
    expect(Math.abs(await trialBalanceGap(c))).toBeLessThan(0.005);
  }, 120000);

  it('R2-5 sameTarget: an on-account supplier payment re-pointed to the same supplier (fifo, nothing open) writes nothing', async () => {
    const sup = await newSupplier(c);
    const s = await reconciledLine(c, { amount: -400, date: '2026-06-10', statementDate: '2026-06-30', alloc: 'supplier', entity: sup });
    const n0 = await journalCount();
    const r = await realloc(s.bt, { supplier_id: sup });
    expect(r.isError, r.text).toBe(false);
    expect({ nothing: r.body?.nothing_changed ?? false, journalsWritten: (await journalCount()) - n0 })
      .toEqual({ nothing: true, journalsWritten: 0 });
  }, 120000);

  it('R2-6 sameTarget: a customer refund re-pointed to the same customer writes nothing', async () => {
    const cust = randomUUID();
    await sql`INSERT INTO customers (id, company_id, name) VALUES (${cust}::UUID, ${c.fx.companyId}::UUID, ${`R2 cust6 ${c.fx.tag}`})`;
    const rec = await plainLine(600, '2026-06-01');
    await inTx(c.fx, () => allocateTransaction(c.fx.companyId, rec, null, c.fx.userId, undefined, 'customer', cust, 'none'));
    const s = await reconciledLine(c, { amount: -600, date: '2026-06-10', statementDate: '2026-06-30', alloc: 'customer', entity: cust });
    const n0 = await journalCount();
    const r = await realloc(s.bt, { customer_id: cust });
    expect({ err: r.isError, nothing: r.body?.nothing_changed ?? false, journalsWritten: (await journalCount()) - n0 }, r.text)
      .toEqual({ err: false, nothing: true, journalsWritten: 0 });
    const ar = await arControlAndSubledger(c);
    expect(ar.control).toBe(ar.subledger);
    expect(Math.abs(await trialBalanceGap(c))).toBeLessThan(0.005);
  }, 120000);
});
