/**
 * reallocate_bank_transaction on a real ledger: a line in a COMPLETED reconciliation re-pointed without reopening
 * it. The reconciliation row is byte-identical afterwards, the bank GL balance as at the statement date unchanged,
 * the line still reconciled on the same reconciliation with its reviewer kept, the trial balance balances and AP
 * control equals the AP subledger. Expense -> supplier (FIFO pays the oldest bill), supplier -> expense (the bill
 * reopens, the payment is cancelled), customer -> account; refusals (closed period, stale expected journal, a line
 * of an in-progress session, the Sage import) write nothing, dry run and live alike; reopen + reverse still work.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from '@/lib/neon';
import { allocateTransaction } from '@/modules/accounting/services/bank/bankAllocationService';
import { startReconciliation } from '@/modules/accounting/services/bank/bankReconciliationService';
import { reopenReconciliation } from '@/modules/accounting/services/bank/bankReconciliationReopenService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { inTx } from './helpers/l1FifoFixture';
import { postedInvoice, teardown, type Ctx } from './d8-r4-helpers';
import { clearExtras } from './d10-helpers';
import { cleanup } from './d12-helpers';
import {
  REVIEWED_AT, TOOL, apControlAndSubledger, arControlAndSubledger, bankGl, entry, lineRow, mcp, newBank, newSupplier, postedBill,
  reconciledLine, recRow, setupCompany, snapshot, trialBalanceGap,
} from './bank-reallocate-reconciled.helpers';

assertDisposable();
type Row = Record<string, unknown>;
let c: Ctx;
const AGENT = 'mcp:reallocate_bank_transaction:v1';
const key = () => randomUUID();
const billOf = async (id: string) => ((await sql`SELECT status, amount_paid::float8 AS paid FROM supplier_invoices
  WHERE id = ${id}::UUID`) as Row[])[0]!;
const paymentsOn = async (je: string) => (await sql`SELECT status, supplier_id::TEXT AS s FROM supplier_payments
  WHERE gl_journal_entry_id = ${je}::UUID`) as Row[];

describe('reallocate_bank_transaction: a reconciled line, re-pointed in place', () => {
  beforeAll(async () => { c = await setupCompany('REALLOC'); }, 120000);
  afterAll(async () => { await cleanup(c); await clearExtras(c); await teardown(c); }, 120000);

  it('expense -> supplier (FIFO pays the oldest bill), then supplier -> expense (the bill reopens); the reconciliation never moves', async () => {
    const supplier = await newSupplier(c);
    const older = await postedBill(c, supplier, '2026-05-01', 400);
    const newer = await postedBill(c, supplier, '2026-05-05', 400);
    const s = await reconciledLine(c, { amount: -400, date: '2026-06-10', statementDate: '2026-06-30', alloc: 'account', contra: c.acct.expense });
    expect((await lineRow(s.bt)).status).toBe('reconciled');
    const rec0 = await recRow(s.rec);
    const gl0 = await bankGl(c, s.bank, '2026-06-30');
    const before = await snapshot(c, s.bt, s.rec);
    const args = { transaction_id: s.bt, expected_journal_entry_id: s.je, target: { supplier_id: supplier }, idempotency_key: key() };

    // Dry run: the whole reallocation, rolled back — then the live call on the SAME key still runs.
    const dry = await mcp(c, TOOL, { ...args, dry_run: true });
    expect(dry.isError, dry.text).toBe(false);
    expect(dry.body).toMatchObject({ dry_run: true, reconciliation_unchanged: true, new_document: { kind: 'supplier_payment' } });
    expect(await snapshot(c, s.bt, s.rec), 'the dry run wrote nothing').toEqual(before);

    const live = await mcp(c, TOOL, { ...args, dry_run: false });
    expect(live.isError, live.text).toBe(false);
    const b = live.body as Record<string, unknown> & { new_journal_entry_id: string; reversal_journal_entry_id: string };
    expect(b).toMatchObject({
      transaction_id: s.bt, reconciliation_id: s.rec, original_journal_entry_id: s.je, entry_date: '2026-06-10',
      bank_leg: { account_id: s.bank, amount: -400 }, applications: [{ document_id: older, amount: 400 }], on_account: 0,
    });
    expect(b.dry_run).toBeUndefined();
    expect(await recRow(s.rec), 'the reconciliation row is byte-identical').toBe(rec0);
    expect(await bankGl(c, s.bank, '2026-06-30')).toBeCloseTo(gl0, 2);
    const line = await lineRow(s.bt);
    expect(line).toMatchObject({ status: 'reconciled', rec: s.rec, je: b.new_journal_entry_id, allocation_type: 'supplier',
      reviewed_by: c.fx.userId });
    expect(new Date(line.reviewed_at as string).toISOString()).toBe(REVIEWED_AT);
    expect(await entry(s.je)).toMatchObject({ reversed: true });
    expect(await entry(b.reversal_journal_entry_id)).toMatchObject({ d: '2026-06-10', of: s.je, posting_agent: AGENT });
    expect(await entry(b.new_journal_entry_id)).toMatchObject({ d: '2026-06-10', reversed: false, posting_agent: AGENT });
    expect(await billOf(older)).toMatchObject({ paid: 400 });
    expect(await billOf(newer)).toMatchObject({ paid: 0 });
    expect(Math.abs(await trialBalanceGap(c))).toBeLessThan(0.005);
    const ap1 = await apControlAndSubledger(c);
    expect(ap1.control).toBe(ap1.subledger);

    // The same target again: nothing_changed, nothing written.
    const again = await mcp(c, TOOL, { ...args, expected_journal_entry_id: b.new_journal_entry_id, idempotency_key: key(), dry_run: false });
    expect(again.body).toMatchObject({ nothing_changed: true });

    // supplier -> expense: the payment is cancelled and the bill reopens.
    const back = await mcp(c, TOOL, { transaction_id: s.bt, expected_journal_entry_id: b.new_journal_entry_id,
      target: { gl_account_id: c.acct.expense }, dry_run: false, idempotency_key: key() });
    expect(back.isError, back.text).toBe(false);
    expect(back.body).toMatchObject({ unwound: { invoices_reopened: 1, amount_unapplied: 400, payments_cancelled: 1 },
      new_document: { kind: 'none', payment_id: null } });
    expect(await billOf(older)).toMatchObject({ paid: 0 });
    expect(await paymentsOn(b.new_journal_entry_id)).toEqual([{ status: 'cancelled', s: supplier }]);
    expect(await recRow(s.rec)).toBe(rec0);
    expect(await bankGl(c, s.bank, '2026-06-30')).toBeCloseTo(gl0, 2);
    expect(await lineRow(s.bt)).toMatchObject({ status: 'reconciled', rec: s.rec, allocation_type: 'account' });
    expect(Math.abs(await trialBalanceGap(c))).toBeLessThan(0.005);
    const ap2 = await apControlAndSubledger(c);
    expect(ap2.control).toBe(ap2.subledger);

    // Afterwards the ordinary path still works: reopen, then reverse_bank_allocation.
    await inTx(c.fx, () => reopenReconciliation(c.fx.companyId, s.rec, c.fx.userId));
    expect((await lineRow(s.bt)).status).toBe('allocated');
    const rev = await mcp(c, 'reverse_bank_allocation', { transaction_id: s.bt, idempotency_key: key() });
    expect(rev.isError, rev.text).toBe(false);
    expect(await lineRow(s.bt)).toMatchObject({ status: 'imported', jl: null });
    expect(await bankGl(c, s.bank, '2026-06-30')).toBeCloseTo(0, 2);
    expect(Math.abs(await trialBalanceGap(c))).toBeLessThan(0.005);
  }, 120000);

  it('customer -> account: the receipt is cancelled, the invoice reopens, the reconciliation never moves', async () => {
    const inv = await postedInvoice(c, '2026-05-10'); // R1,150 for the fixture's customer
    const s = await reconciledLine(c, { amount: 1150, date: '2026-06-12', statementDate: '2026-06-30', alloc: 'customer', entity: c.fx.customerId });
    expect(((await sql`SELECT amount_paid::float8 AS p FROM customer_invoices WHERE id = ${inv.id}::UUID`) as Row[])[0]!.p).toBe(1150);
    const rec0 = await recRow(s.rec);
    const gl0 = await bankGl(c, s.bank, '2026-06-30');
    const r = await mcp(c, TOOL, { transaction_id: s.bt, expected_journal_entry_id: s.je, target: { gl_account_id: c.acct.sales },
      dry_run: false, idempotency_key: key() });
    expect(r.isError, r.text).toBe(false);
    expect(r.body).toMatchObject({ unwound: { invoices_reopened: 1, payments_cancelled: 1 }, bank_leg: { amount: 1150 } });
    expect(((await sql`SELECT amount_paid::float8 AS p FROM customer_invoices WHERE id = ${inv.id}::UUID`) as Row[])[0]!.p).toBe(0);
    expect(((await sql`SELECT status FROM customer_payments WHERE gl_journal_entry_id = ${s.je}::UUID`) as Row[])
      .map((x) => x.status)).toEqual(['cancelled']);
    expect(await recRow(s.rec)).toBe(rec0);
    expect(await bankGl(c, s.bank, '2026-06-30')).toBeCloseTo(gl0, 2);
    expect(await lineRow(s.bt)).toMatchObject({ status: 'reconciled', rec: s.rec, allocation_type: 'account' });
    expect(Math.abs(await trialBalanceGap(c))).toBeLessThan(0.005);
    const ar = await arControlAndSubledger(c);
    expect(ar.control).toBe(ar.subledger);
  }, 120000);

  it('a stale expected_journal_entry_id is refused, dry run and live alike, nothing written', async () => {
    const s = await reconciledLine(c, { amount: -75, date: '2026-06-14', statementDate: '2026-06-30', alloc: 'account', contra: c.acct.expense });
    const before = await snapshot(c, s.bt, s.rec);
    const args = { transaction_id: s.bt, expected_journal_entry_id: randomUUID(), target: { gl_account_id: c.acct.sales } };
    const dry = await mcp(c, TOOL, { ...args, dry_run: true, idempotency_key: key() });
    const live = await mcp(c, TOOL, { ...args, dry_run: false, idempotency_key: key() });
    expect(dry.isError).toBe(true);
    expect(live.text).toBe(dry.text);
    expect(live.text).toMatch(/expected_journal_entry_id does not match/);
    expect(live.text).toContain(s.je);
    expect(await snapshot(c, s.bt, s.rec)).toEqual(before);
  }, 120000);

  it('a closed fiscal period on the original date is refused (the date is never rolled), nothing written', async () => {
    await sql`INSERT INTO fiscal_periods (company_id, period_name, period_number, fiscal_year, start_date, end_date, status)
      VALUES (${c.fx.companyId}::UUID, ${`FY25 ${c.fx.tag}`}, 1, 2025, '2025-01-01', '2025-12-31', 'open')`;
    const s = await reconciledLine(c, { amount: -60, date: '2025-12-15', statementDate: '2025-12-31', alloc: 'account', contra: c.acct.expense });
    await sql`UPDATE fiscal_periods SET status = 'closed' WHERE company_id = ${c.fx.companyId}::UUID AND fiscal_year = 2025`;
    const before = await snapshot(c, s.bt, s.rec);
    const args = { transaction_id: s.bt, expected_journal_entry_id: s.je, target: { gl_account_id: c.acct.sales } };
    const dry = await mcp(c, TOOL, { ...args, dry_run: true, idempotency_key: key() });
    const live = await mcp(c, TOOL, { ...args, dry_run: false, idempotency_key: key() });
    expect(live.isError).toBe(true);
    expect(live.text).toMatch(/fiscal period covering 2025-12-15 is closed or locked/);
    expect(dry.text).toBe(live.text);
    expect(await snapshot(c, s.bt, s.rec)).toEqual(before);
  }, 120000);

  it('a VAT-locked date is refused, whether the old journal or only the new one moves VAT; nothing written', async () => {
    const withVat = await reconciledLine(c, { amount: -115, date: '2026-08-10', statementDate: '2026-08-31', alloc: 'account', contra: c.acct.expense });
    // Re-allocated with VAT so the OLD journal moves a VAT figure (allocate's own VAT split), before the lock lands.
    const vatJe = String(((await sql`SELECT journal_entry_id::TEXT AS je FROM gl_journal_lines WHERE id =
      (SELECT matched_journal_line_id FROM bank_transactions WHERE id = ${withVat.bt}::UUID)`) as Row[])[0]!.je);
    const toVat = await mcp(c, TOOL, { transaction_id: withVat.bt, expected_journal_entry_id: vatJe,
      target: { gl_account_id: c.acct.expense }, vat_type: 'standard', dry_run: false, idempotency_key: key() });
    expect(toVat.isError, toVat.text).toBe(false);
    const vatNow = String((toVat.body as { new_journal_entry_id: string }).new_journal_entry_id);
    const plain = await reconciledLine(c, { amount: -50, date: '2026-08-12', statementDate: '2026-08-31', alloc: 'account', contra: c.acct.expense });
    await sql`INSERT INTO vat_period_locks (company_id, period_start, period_end, output_tax, input_tax, net_vat, posted_through, locked_by)
      VALUES (${c.fx.companyId}::UUID, '2026-08-01', '2026-08-31', 0, 0, 0, '2026-08-31', ${c.fx.userId}::UUID)`;
    try {
      const before = [await snapshot(c, withVat.bt, withVat.rec), await snapshot(c, plain.bt, plain.rec)];
      for (const dry_run of [true, false]) {
        const oldMoves = await mcp(c, TOOL, { transaction_id: withVat.bt, expected_journal_entry_id: vatNow,
          target: { gl_account_id: c.acct.sales }, dry_run, idempotency_key: key() });
        expect(oldMoves.text).toMatch(/inside the VAT period 2026-08-01 to 2026-08-31/);
        const newMoves = await mcp(c, TOOL, { transaction_id: plain.bt, expected_journal_entry_id: plain.je,
          target: { gl_account_id: c.acct.expense }, vat_type: 'standard', dry_run, idempotency_key: key() });
        expect(newMoves.text).toMatch(/inside the VAT period 2026-08-01 to 2026-08-31/);
      }
      expect([await snapshot(c, withVat.bt, withVat.rec), await snapshot(c, plain.bt, plain.rec)]).toEqual(before);
    } finally {
      await sql`DELETE FROM vat_period_locks WHERE company_id = ${c.fx.companyId}::UUID`;
    }
  }, 120000);

  it('under manual-journal enforcement an agent may not reallocate (its reversal half is gated), dry run and live', async () => {
    const s = await reconciledLine(c, { amount: -35, date: '2026-06-20', statementDate: '2026-06-30', alloc: 'account', contra: c.acct.expense });
    const before = await snapshot(c, s.bt, s.rec);
    await sql`INSERT INTO approval_enforcement (company_id, document_type, enabled_by)
      VALUES (${c.fx.companyId}::UUID, 'manual_journal', ${c.fx.userId})`;
    try {
      const args = { transaction_id: s.bt, expected_journal_entry_id: s.je, target: { gl_account_id: c.acct.sales } };
      for (const dry_run of [true, false]) {
        const r = await mcp(c, TOOL, { ...args, dry_run, idempotency_key: key() });
        expect(r.isError).toBe(true);
        expect(r.text).toMatch(/an agent or a job cannot/);
      }
      expect(await snapshot(c, s.bt, s.rec)).toEqual(before);
    } finally {
      await sql`DELETE FROM approval_enforcement WHERE company_id = ${c.fx.companyId}::UUID AND document_type = 'manual_journal'`;
    }
  }, 120000);

  it("allocateTransaction's reallocation gate admits only the locked line's own completed reconciliation", async () => {
    const s = await reconciledLine(c, { amount: -20, date: '2026-06-18', statementDate: '2026-06-30', alloc: 'account', contra: c.acct.expense });
    const realloc = (reconciliationId: string, bt = s.bt) => inTx(c.fx, () => allocateTransaction(c.fx.companyId, bt,
      c.acct.sales!, c.fx.userId, undefined, 'account', undefined, 'none', undefined, undefined, undefined, undefined,
      { reallocation: { reconciliationId } }));
    await expect(realloc(randomUUID())).rejects.toMatchObject({ code: 'REALLOCATION_REFUSED' });
    // Without the flag, the D12 refusal stands.
    await expect(inTx(c.fx, () => allocateTransaction(c.fx.companyId, s.bt, c.acct.sales!, c.fx.userId, undefined, 'account')))
      .rejects.toMatchObject({ code: 'RECONCILIATION_COMPLETED' });
    const imported = String(((await sql`INSERT INTO bank_transactions (company_id, bank_account_id, transaction_date, amount,
      description, status, reconciliation_id) VALUES (${c.fx.companyId}::UUID, ${s.bank}::UUID, '2026-06-19', -5, 'Realloc stale stamp',
      'imported', ${s.rec}::UUID) RETURNING id`) as Row[])[0]!.id);
    await expect(realloc(s.rec, imported)).rejects.toMatchObject({ code: 'REALLOCATION_REFUSED' });
    expect((await lineRow(s.bt)).je).toBe(s.je);
    expect((await lineRow(imported)).status).toBe('imported');
  }, 120000);

  it('an allocated line (not reconciled) in an open session, and a line reconciled in the Sage import, are refused', async () => {
    const bank = await newBank(c);
    const bt = String(((await sql`INSERT INTO bank_transactions (company_id, bank_account_id, transaction_date, amount, description,
      status) VALUES (${c.fx.companyId}::UUID, ${bank}::UUID, '2026-06-16', -30, 'Realloc open session', 'imported') RETURNING id`) as Row[])[0]!.id);
    const posted = await inTx(c.fx, () => allocateTransaction(c.fx.companyId, bt, c.acct.expense!, c.fx.userId, undefined, 'account'));
    await inTx(c.fx, () => startReconciliation(c.fx.companyId, bank, '2026-06-30', -30, c.fx.userId));
    const open = await mcp(c, TOOL, { transaction_id: bt, expected_journal_entry_id: posted.journalEntryId,
      target: { gl_account_id: c.acct.sales }, dry_run: false, idempotency_key: key() });
    expect(open.isError).toBe(true);
    expect(open.text).toMatch(/not reconciled.*reverse_bank_allocation/);
    expect((await lineRow(bt)).status).toBe('allocated');

    await sql`UPDATE bank_transactions SET status = 'reconciled', reconciliation_id = NULL WHERE id = ${bt}::UUID`;
    const sage = await mcp(c, TOOL, { transaction_id: bt, expected_journal_entry_id: posted.journalEntryId,
      target: { gl_account_id: c.acct.sales }, dry_run: true, idempotency_key: key() });
    expect(sage.text).toMatch(/Sage import/);
    expect(await entry(posted.journalEntryId)).toMatchObject({ reversed: false });
  }, 120000);
});
