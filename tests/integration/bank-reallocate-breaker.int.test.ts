/**
 * Breaker repros for reallocate_bank_transaction (dea1573148).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from '@/lib/neon';
import { allocateTransaction } from '@/modules/accounting/services/bank/bankAllocationService';
import { completeReconciliation } from '@/modules/accounting/services/bank/bankReconciliationService';
import { reopenReconciliation } from '@/modules/accounting/services/bank/bankReconciliationReopenService';
import { cancelReconciliation } from '@/modules/accounting/services/bank/bankReconciliationCancelService';
import { getVat201Report } from '@/modules/accounting/services/reports/vat201ReportService';
import { getCustomerOnAccountCredit } from '@/modules/accounting/services/ar/customerRefundDocument';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { inTx } from './helpers/l1FifoFixture';
import { postedInvoice, processedPayment, settle, teardown, type Ctx } from './d8-r4-helpers';
import { clearExtras } from './d10-helpers';
import { cleanup } from './d12-helpers';
import {
  TOOL, apControlAndSubledger, bankGl, lineRow, mcp, newBank, newSupplier, postedBill,
  reconciledLine, recRow, setupCompany, trialBalanceGap,
} from './bank-reallocate-reconciled.helpers';

assertDisposable();
type Row = Record<string, unknown>;
let c: Ctx;
const key = () => randomUUID();
const curJe = async (bt: string) => String((await lineRow(bt)).je);
const realloc = async (bt: string, target: Record<string, string>, extra: Record<string, unknown> = {}) => {
  const r = await mcp(c, TOOL, { transaction_id: bt, expected_journal_entry_id: await curJe(bt), target,
    dry_run: false, idempotency_key: key(), ...extra });
  return r;
};
const dates = ['2026-01-01', '2026-06-09', '2026-06-10', '2026-06-11', '2026-06-30', '2026-09-09', '2026-09-10',
  '2026-09-11', '2026-09-30', '2026-12-31'];
const glAll = async (bank: string) => Promise.all(dates.map((d) => bankGl(c, bank, d)));

async function arControlAndSubledger(): Promise<{ control: number; subledger: number }> {
  const control = Number(((await sql`SELECT COALESCE(SUM(l.debit - l.credit), 0)::float8 AS n FROM gl_journal_lines l
    JOIN gl_journal_entries e ON e.id = l.journal_entry_id
    WHERE l.company_id = ${c.fx.companyId}::UUID AND e.status = 'posted' AND l.gl_account_id = ${c.acct.ar}::UUID`) as Row[])[0]!.n);
  const inv = Number(((await sql`SELECT COALESCE(SUM(total_amount - COALESCE(amount_paid, 0)), 0)::float8 AS n
    FROM customer_invoices WHERE company_id = ${c.fx.companyId}::UUID AND status <> 'cancelled' AND gl_journal_entry_id IS NOT NULL`) as Row[])[0]!.n);
  const unapplied = Number(((await sql`SELECT COALESCE(SUM(p.total_amount - COALESCE((SELECT SUM(a.amount_allocated)
      FROM customer_payment_allocations a WHERE a.payment_id = p.id), 0)), 0)::float8 AS n
    FROM customer_payments p WHERE p.company_id = ${c.fx.companyId}::UUID AND p.status NOT IN ('cancelled', 'draft')
      AND p.gl_journal_entry_id IS NOT NULL`) as Row[])[0]!.n);
  return { control: Math.round(control * 100) / 100, subledger: Math.round((inv - unapplied) * 100) / 100 };
}

async function vat(from: string, to: string) {
  const r = await getVat201Report(c.fx.companyId, from, to);
  return { out: r.totals.outputTax, in: r.totals.inputTax, net: r.totals.netVat };
}

/** A line allocated with a VAT code and reconciled by a completed reconciliation. */
async function reconciledVatLine(amount: number, date: string, statementDate: string, contra: string, vatCode: string) {
  const bank = await newBank(c);
  const bt = String(((await sql`INSERT INTO bank_transactions (company_id, bank_account_id, transaction_date, amount,
      description, status) VALUES (${c.fx.companyId}::UUID, ${bank}::UUID, ${date}::DATE, ${amount},
      ${`Brk ${++c.seq}`}, 'imported') RETURNING id`) as Row[])[0]!.id);
  await inTx(c.fx, () => allocateTransaction(c.fx.companyId, bt, contra, c.fx.userId, undefined, 'account', undefined, vatCode));
  const balance = await bankGl(c, bank, statementDate);
  const { startReconciliation } = await import('@/modules/accounting/services/bank/bankReconciliationService');
  const rec = await inTx(c.fx, () => startReconciliation(c.fx.companyId, bank, statementDate, balance, c.fx.userId));
  await sql`UPDATE bank_transactions SET reviewed_at = NOW(), reviewed_by = ${c.fx.userId}::UUID WHERE id = ${bt}::UUID`;
  await inTx(c.fx, () => completeReconciliation(c.fx.companyId, rec.id, c.fx.userId));
  return { bank, bt, rec: rec.id };
}

/** Every public table's row count + content hash, and every sequence's last_value. */
async function dbFingerprint(): Promise<Record<string, string>> {
  const tables = (await sql`SELECT c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') ORDER BY 1`) as Row[];
  const out: Record<string, string> = {};
  for (const { t } of tables) {
    const q = `SELECT COUNT(*)::TEXT || ':' || COALESCE(md5(string_agg(md5(x::TEXT), '' ORDER BY md5(x::TEXT))), '') AS h
      FROM public."${String(t)}" x`;
    const r = (await c.fx.pool.query(q)).rows[0] as Row;
    out[String(t)] = String(r!.h);
  }
  const seqs = (await sql`SELECT schemaname || '.' || sequencename AS s, COALESCE(last_value, 0)::TEXT AS v
    FROM pg_sequences ORDER BY 1`) as Row[];
  for (const s of seqs) out[`seq:${String(s.s)}`] = String(s.v);
  return out;
}

describe('reallocate_bank_transaction breaker', () => {
  beforeAll(async () => { c = await setupCompany('RABRK'); }, 120000);
  afterAll(async () => { await cleanup(c); await clearExtras(c); await teardown(c); }, 120000);

  it('ATTACK 2: VAT201 nets old VAT out and new VAT in, inflow and outflow, all inside the period; bank GL unchanged at every date', async () => {
    const before = await vat('2026-09-01', '2026-09-30');
    const out = await reconciledVatLine(-115, '2026-09-10', '2026-09-30', c.acct.expense!, 'standard');
    const inn = await reconciledVatLine(230, '2026-09-11', '2026-09-30', c.acct.sales!, 'standard');
    const v0 = await vat('2026-09-01', '2026-09-30');
    expect(v0.in - before.in).toBeCloseTo(15, 2);
    expect(v0.out - before.out).toBeCloseTo(30, 2);
    const g0 = [await glAll(out.bank), await glAll(inn.bank)];
    const r0 = [await recRow(out.rec), await recRow(inn.rec)];

    const a = await realloc(out.bt, { gl_account_id: c.acct.expense! }, { vat_type: 'none' });
    expect(a.isError, a.text).toBe(false);
    const b = await realloc(inn.bt, { customer_id: c.fx.customerId });
    expect(b.isError, b.text).toBe(false);
    const v1 = await vat('2026-09-01', '2026-09-30');
    expect(v1.in, 'input VAT back to before').toBeCloseTo(before.in, 2);
    expect(v1.out, 'output VAT back to before').toBeCloseTo(before.out, 2);
    // The other months must not have picked anything up.
    const aug = await vat('2026-08-01', '2026-08-31');
    const oct = await vat('2026-10-01', '2026-10-31');
    expect([aug.in, aug.out, oct.in, oct.out]).toEqual([0, 0, 0, 0]);

    // and back again with VAT: output returns.
    const back = await realloc(inn.bt, { gl_account_id: c.acct.sales! }, { vat_type: 'standard' });
    expect(back.isError, back.text).toBe(false);
    const v2 = await vat('2026-09-01', '2026-09-30');
    expect(v2.out - before.out).toBeCloseTo(30, 2);
    expect(v2.in).toBeCloseTo(before.in, 2);

    expect([await glAll(out.bank), await glAll(inn.bank)]).toEqual(g0);
    expect([await recRow(out.rec), await recRow(inn.rec)]).toEqual(r0);
    expect(Math.abs(await trialBalanceGap(c))).toBeLessThan(0.005);
    const ar = await arControlAndSubledger();
    expect(ar.control).toBe(ar.subledger);
  }, 180000);

  it('ATTACK 3: A -> S1 -> S2 -> A: every intermediate journal reversed exactly once, documents end where they started', async () => {
    const s1 = await newSupplier(c);
    const s2 = await newSupplier(c);
    const b1 = await postedBill(c, s1, '2026-05-01', 400);
    const b2 = await postedBill(c, s1, '2026-05-02', 800);
    const b3 = await postedBill(c, s2, '2026-05-03', 300);
    const s = await reconciledLine(c, { amount: -1000, date: '2026-06-10', statementDate: '2026-06-30', alloc: 'account', contra: c.acct.expense });
    const g0 = await glAll(s.bank);
    const r0 = await recRow(s.rec);
    const journals: string[] = [s.je];
    for (const target of [{ supplier_id: s1 }, { supplier_id: s2 }, { gl_account_id: c.acct.expense! }]) {
      const r = await realloc(s.bt, target);
      expect(r.isError, r.text).toBe(false);
      journals.push(String((r.body as Row).new_journal_entry_id));
      const ap = await apControlAndSubledger(c);
      expect(ap.control, JSON.stringify(target)).toBe(ap.subledger);
    }
    const revCounts = (await sql`SELECT j.id::TEXT AS id, (SELECT COUNT(*)::int FROM gl_journal_entries r
        WHERE r.reversal_of_id = j.id AND r.status = 'posted') AS n, j.status, j.reversed_at IS NOT NULL AS rev
      FROM gl_journal_entries j WHERE j.id = ANY(${journals}::UUID[])`) as Row[];
    const byId = new Map(revCounts.map((r) => [String(r.id), r]));
    journals.slice(0, -1).forEach((j) => expect(byId.get(j), j).toMatchObject({ n: 1, rev: true, status: 'posted' }));
    expect(byId.get(journals[3]!)).toMatchObject({ n: 0, rev: false });
    const bills = (await sql`SELECT id::TEXT AS id, amount_paid::float8 AS p FROM supplier_invoices
      WHERE id = ANY(${[b1, b2, b3]}::UUID[]) ORDER BY id`) as Row[];
    expect(bills.map((b) => b.p)).toEqual([0, 0, 0]);
    const live = (await sql`SELECT COUNT(*)::int AS n FROM supplier_payments WHERE gl_journal_entry_id = ANY(${journals}::UUID[])
      AND status <> 'cancelled'`) as Row[];
    expect(live[0]!.n).toBe(0);
    const allocs = (await sql`SELECT COUNT(*)::int AS n FROM payment_allocations a JOIN supplier_payments p ON p.id = a.payment_id
      WHERE p.gl_journal_entry_id = ANY(${journals}::UUID[])`) as Row[];
    expect(allocs[0]!.n).toBe(0);
    expect(await glAll(s.bank)).toEqual(g0);
    expect(await recRow(s.rec)).toBe(r0);
    expect(await lineRow(s.bt)).toMatchObject({ status: 'reconciled', rec: s.rec, je: journals[3] });
    expect(Math.abs(await trialBalanceGap(c))).toBeLessThan(0.005);
  }, 180000);

  it('ATTACK 5a: FIFO across two bills, one since part-paid by another source: unapply takes back only what this line applied', async () => {
    const b1 = await postedBill(c, c.fx.supplierId, '2026-05-01', 400);
    const b2 = await postedBill(c, c.fx.supplierId, '2026-05-02', 800);
    const s = await reconciledLine(c, { amount: -1000, date: '2026-06-10', statementDate: '2026-06-30', alloc: 'supplier', entity: c.fx.supplierId });
    const paid = async () => ((await sql`SELECT amount_paid::float8 AS p, status FROM supplier_invoices WHERE id = ANY(${[b1, b2]}::UUID[])
      ORDER BY invoice_date`) as Row[]);
    expect((await paid()).map((r) => r.p)).toEqual([400, 600]);
    await processedPayment(c, b2, 200); // another source settles the rest of b2
    expect((await paid()).map((r) => r.p)).toEqual([400, 800]);
    const r = await realloc(s.bt, { gl_account_id: c.acct.expense! });
    expect(r.isError, r.text).toBe(false);
    expect((await paid()).map((x) => x.p)).toEqual([0, 200]);
    const ap = await apControlAndSubledger(c);
    expect(ap.control).toBe(ap.subledger);
    const back = await realloc(s.bt, { supplier_id: c.fx.supplierId });
    expect(back.isError, back.text).toBe(false);
    expect((await paid()).map((x) => x.p)).toEqual([400, 800]);
    const ap2 = await apControlAndSubledger(c);
    expect(ap2.control).toBe(ap2.subledger);
    expect(Math.abs(await trialBalanceGap(c))).toBeLessThan(0.005);
  }, 180000);

  it('ATTACK 5b: a receipt whose on-account remainder a later customer refund paid out cannot be cancelled into negative credit', async () => {
    const inv = await postedInvoice(c, '2026-05-10'); // R1,150
    const s = await reconciledLine(c, { amount: 2000, date: '2026-06-12', statementDate: '2026-06-30', alloc: 'customer', entity: c.fx.customerId });
    expect((await getCustomerOnAccountCredit(c.fx.companyId, c.fx.customerId, '2026-06-30')).credit).toBeCloseTo(850, 2);
    // The 850 on account goes back to the customer as a refund (another bank line, not reconciled).
    const bank = await newBank(c);
    const refundBt = String(((await sql`INSERT INTO bank_transactions (company_id, bank_account_id, transaction_date, amount,
      description, status) VALUES (${c.fx.companyId}::UUID, ${bank}::UUID, '2026-06-20', -850, 'Brk refund', 'imported') RETURNING id`) as Row[])[0]!.id);
    await inTx(c.fx, () => allocateTransaction(c.fx.companyId, refundBt, null, c.fx.userId, undefined, 'customer', c.fx.customerId, 'none'));
    expect((await getCustomerOnAccountCredit(c.fx.companyId, c.fx.customerId, '2026-12-31')).credit).toBeCloseTo(0, 2);
    const r = await realloc(s.bt, { gl_account_id: c.acct.sales! });
    const credit = (await getCustomerOnAccountCredit(c.fx.companyId, c.fx.customerId, '2026-12-31')).credit;
    // Supplier mirror (assertVoidKeepsCredit) refuses this; the customer side must refuse too or keep credit >= 0.
    expect({ refused: r.isError, credit }, r.text).toMatchObject({ refused: true });
    expect(credit).toBeGreaterThanOrEqual(0);
    void inv;
  }, 180000);
  it('ATTACK 5b-ledger: after that, AR control vs subledger', async () => {
    const ar = await arControlAndSubledger();
    expect(ar.control).toBe(ar.subledger);
  }, 180000);

  it('ATTACK 4: reopen after a reallocation, re-complete: stored figures equal the originals; cancel leaves the line allocated', async () => {
    const sup = await newSupplier(c);
    await postedBill(c, sup, '2026-05-01', 250);
    const s = await reconciledLine(c, { amount: -250, date: '2026-06-10', statementDate: '2026-06-30', alloc: 'account', contra: c.acct.expense });
    const fig = async () => ((await sql`SELECT statement_balance::float8 AS sb, gl_balance::float8 AS gl, reconciled_balance::float8 AS rb,
      difference::float8 AS d, status FROM bank_reconciliations WHERE id = ${s.rec}::UUID`) as Row[])[0]!;
    const f0 = await fig();
    const r = await realloc(s.bt, { supplier_id: sup });
    expect(r.isError, r.text).toBe(false);
    const re = await inTx(c.fx, () => reopenReconciliation(c.fx.companyId, s.rec, c.fx.userId));
    expect(re).toMatchObject({ restoredAllocated: 1, restoredMatched: 0 });
    await inTx(c.fx, () => completeReconciliation(c.fx.companyId, s.rec, c.fx.userId));
    expect(await fig()).toEqual(f0);
    expect((await lineRow(s.bt)).status).toBe('reconciled');
    await inTx(c.fx, () => reopenReconciliation(c.fx.companyId, s.rec, c.fx.userId));
    const can = await settle(inTx(c.fx, () => cancelReconciliation(c.fx.companyId, s.rec, c.fx.userId)));
    expect(can.ok, JSON.stringify(can)).toBe(true);
    expect(await lineRow(s.bt)).toMatchObject({ status: 'allocated' });
    expect(Math.abs(await trialBalanceGap(c))).toBeLessThan(0.005);
  }, 180000);

  it('ATTACK 6: a dry run leaves no trace anywhere in the database', async () => {
    const sup = await newSupplier(c);
    await postedBill(c, sup, '2026-05-01', 90);
    const s = await reconciledLine(c, { amount: -90, date: '2026-06-10', statementDate: '2026-06-30', alloc: 'account', contra: c.acct.expense });
    const before = await dbFingerprint();
    const r = await mcp(c, TOOL, { transaction_id: s.bt, expected_journal_entry_id: s.je, target: { supplier_id: sup },
      dry_run: true, idempotency_key: key() });
    expect(r.isError, r.text).toBe(false);
    const after = await dbFingerprint();
    const changed = Object.keys(after).filter((k) => after[k] !== before[k]);
    // mcp_tool_calls is the registry's per-call log (idempotency_key NULL, written for every call): not a ledger trace.
    expect(changed.filter((t) => t !== 'mcp_tool_calls')).toEqual([]);
  }, 180000);

  it('ATTACK 7a: two reallocations of the same line race: exactly one wins, the chain stays single', async () => {
    const s1 = await newSupplier(c);
    const s2 = await newSupplier(c);
    const s = await reconciledLine(c, { amount: -70, date: '2026-06-10', statementDate: '2026-06-30', alloc: 'account', contra: c.acct.expense });
    const g0 = await glAll(s.bank);
    const mk = (sup: string) => mcp(c, TOOL, { transaction_id: s.bt, expected_journal_entry_id: s.je, target: { supplier_id: sup },
      dry_run: false, idempotency_key: key() });
    const [a, b] = await Promise.all([mk(s1), mk(s2)]);
    expect([a.isError, b.isError].filter((e) => !e).length, `${a.text}\n${b.text}`).toBe(1);
    const reversals = (await sql`SELECT COUNT(*)::int AS n FROM gl_journal_entries WHERE reversal_of_id = ${s.je}::UUID AND status = 'posted'`) as Row[];
    expect(reversals[0]!.n).toBe(1);
    const live = (await sql`SELECT COUNT(*)::int AS n FROM supplier_payments WHERE supplier_id = ANY(${[s1, s2]}::UUID[])
      AND status <> 'cancelled'`) as Row[];
    expect(live[0]!.n).toBe(1);
    expect(await glAll(s.bank)).toEqual(g0);
    expect((await lineRow(s.bt)).status).toBe('reconciled');
    expect(Math.abs(await trialBalanceGap(c))).toBeLessThan(0.005);
  }, 180000);

  it('ATTACK 7b: a reallocation racing reopen_bank_reconciliation leaves a consistent state', async () => {
    const s = await reconciledLine(c, { amount: -65, date: '2026-06-10', statementDate: '2026-06-30', alloc: 'account', contra: c.acct.expense });
    const [a, b] = await Promise.all([
      mcp(c, TOOL, { transaction_id: s.bt, expected_journal_entry_id: s.je, target: { gl_account_id: c.acct.sales! },
        dry_run: false, idempotency_key: key() }),
      settle(inTx(c.fx, () => reopenReconciliation(c.fx.companyId, s.rec, c.fx.userId))),
    ]);
    const line = await lineRow(s.bt);
    const rec = ((await sql`SELECT status FROM bank_reconciliations WHERE id = ${s.rec}::UUID`) as Row[])[0]!;
    // Either order is fine; a half state is not.
    if (rec.status === 'in_progress') expect(line.status, `${a.text} ${JSON.stringify(b)}`).toBe('allocated');
    else expect(line.status).toBe('reconciled');
    const posted = (await sql`SELECT COUNT(*)::int AS n FROM gl_journal_lines l JOIN gl_journal_entries e ON e.id = l.journal_entry_id
      WHERE l.gl_account_id = ${s.bank}::UUID AND e.status = 'posted' AND e.reversed_at IS NULL AND e.reversal_of_id IS NULL`) as Row[];
    expect(posted[0]!.n).toBe(1);
    expect(Math.abs(await trialBalanceGap(c))).toBeLessThan(0.005);
  }, 180000);
});
