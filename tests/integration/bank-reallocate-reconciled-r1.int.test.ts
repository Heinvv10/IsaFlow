/**
 * reallocate_bank_transaction, review round 1 on a real ledger:
 *  - a line MATCHED into an in-progress session hits the session-lock refusal (not the "not reconciled" one);
 *  - the auto-post run tag is cleared, so an undo of that run cannot reverse the reallocated journal;
 *  - the same supplier with auto_apply fifo over a payment left on account re-applies it (not nothing_changed);
 *  - two reallocations crossing contacts (A->B beside B->A, each contact's bill part-paid by the other line) finish
 *    without a deadlock: the documents are locked in one id-ordered pass before either journal.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from '@/lib/neon';
import { startReconciliation } from '@/modules/accounting/services/bank/bankReconciliationService';
import { undoRun } from '@/modules/accounting/services/bank/autoPostUndoService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { inTx } from './helpers/l1FifoFixture';
import { teardown, type Ctx } from './d8-r4-helpers';
import { clearExtras } from './d10-helpers';
import { cleanup } from './d12-helpers';
import {
  TOOL, apControlAndSubledger, bankGl, entry, lineRow, mcp, newBank, newSupplier, postedBill, reconciledLine, recRow,
  setupCompany, snapshot, trialBalanceGap,
} from './bank-reallocate-reconciled.helpers';

assertDisposable();
type Row = Record<string, unknown>;
let c: Ctx;
const key = () => randomUUID();
const paidOf = async (id: string) => Number(((await sql`SELECT amount_paid::float8 AS p FROM supplier_invoices
  WHERE id = ${id}::UUID`) as Row[])[0]!.p);
const deadlocks = async () => Number(((await sql`SELECT deadlocks FROM pg_stat_database
  WHERE datname = current_database()`) as Row[])[0]!.deadlocks);

describe('reallocate_bank_transaction: review round 1', () => {
  beforeAll(async () => { c = await setupCompany('REALLOC1'); }, 120000);
  afterAll(async () => { await cleanup(c); await clearExtras(c); await teardown(c); }, 120000);

  it('a line matched into an in-progress session is refused by the session lock, nothing written', async () => {
    const bank = await newBank(c);
    const [je] = (await sql`INSERT INTO gl_journal_entries (company_id, entry_date, description, status, created_by)
      VALUES (${c.fx.companyId}::UUID, '2026-06-08', 'Realloc session', 'posted', ${c.fx.userId}::UUID) RETURNING id`) as Row[];
    const [jl] = (await sql`INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit, description)
      VALUES (${c.fx.companyId}::UUID, ${je!.id}::UUID, ${bank}::UUID, 0, 45, 'bank') RETURNING id`) as Row[];
    await sql`INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit, description)
      VALUES (${c.fx.companyId}::UUID, ${je!.id}::UUID, ${c.acct.expense}::UUID, 45, 0, 'expense')`;
    const bt = String(((await sql`INSERT INTO bank_transactions (company_id, bank_account_id, transaction_date, amount,
      description, status) VALUES (${c.fx.companyId}::UUID, ${bank}::UUID, '2026-06-08', -45, 'Realloc session', 'imported')
      RETURNING id`) as Row[])[0]!.id);
    const rec = await inTx(c.fx, () => startReconciliation(c.fx.companyId, bank, '2026-06-30', -45, c.fx.userId));
    await sql`UPDATE bank_transactions SET status = 'matched', matched_journal_line_id = ${jl!.id}::UUID WHERE id = ${bt}::UUID`;
    expect(await lineRow(bt)).toMatchObject({ status: 'matched', rec: rec.id });
    const before = await snapshot(c, bt, rec.id);
    for (const dry_run of [true, false]) {
      const r = await mcp(c, TOOL, { transaction_id: bt, expected_journal_entry_id: String(je!.id),
        target: { gl_account_id: c.acct.sales }, dry_run, idempotency_key: key() });
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/in an in-progress bank reconciliation/);
    }
    expect(await snapshot(c, bt, rec.id)).toEqual(before);
  }, 120000);

  it("clears the auto-post run tag: undoing that run afterwards leaves the reallocated journal standing", async () => {
    const s = await reconciledLine(c, { amount: -55, date: '2026-06-09', statementDate: '2026-06-30', alloc: 'account', contra: c.acct.expense });
    const run = String(((await sql`INSERT INTO bank_auto_post_runs (company_id, source, min_confidence, amount_cap, posted_count, created_by)
      VALUES (${c.fx.companyId}::UUID, 'manual', 0.9, 100000, 1, ${c.fx.userId}::UUID) RETURNING id`) as Row[])[0]!.id);
    await sql`UPDATE bank_transactions SET auto_post_run_id = ${run}::UUID WHERE id = ${s.bt}::UUID`;
    const r = await mcp(c, TOOL, { transaction_id: s.bt, expected_journal_entry_id: s.je, target: { gl_account_id: c.acct.sales },
      dry_run: false, idempotency_key: key() });
    expect(r.isError, r.text).toBe(false);
    const newJe = String((r.body as Row).new_journal_entry_id);
    expect(((await sql`SELECT auto_post_run_id FROM bank_transactions WHERE id = ${s.bt}::UUID`) as Row[])[0]!.auto_post_run_id).toBeNull();
    const audit = ((await sql`SELECT changes FROM audit_log WHERE entity_id = ${s.bt}::UUID AND action = 'update'
      ORDER BY created_at DESC LIMIT 1`) as Row[])[0]!.changes as { metadata: Record<string, string> };
    expect(audit.metadata).toMatchObject({ operation: 'reallocate', clearedAutoPostRunId: run, originalReviewedBy: c.fx.userId });
    expect(audit.metadata.originalReviewedAt).not.toBe('');
    await inTx(c.fx, () => undoRun(c.fx.companyId, run, c.fx.userId));
    expect(await entry(newJe)).toMatchObject({ reversed: false });
    expect((await lineRow(s.bt)).je).toBe(newJe);
  }, 120000);

  it('the same supplier with auto_apply fifo over a payment left on account re-applies it', async () => {
    const supplier = await newSupplier(c);
    const bill = await postedBill(c, supplier, '2026-05-01', 120);
    const s = await reconciledLine(c, { amount: -120, date: '2026-06-10', statementDate: '2026-06-30', alloc: 'supplier',
      entity: supplier, autoApply: 'none' });
    expect(await paidOf(bill)).toBe(0);
    const rec0 = await recRow(s.rec);
    const r = await mcp(c, TOOL, { transaction_id: s.bt, expected_journal_entry_id: s.je, target: { supplier_id: supplier },
      auto_apply: 'fifo', dry_run: false, idempotency_key: key() });
    expect(r.isError, r.text).toBe(false);
    expect(r.body?.nothing_changed).toBeUndefined();
    expect(await paidOf(bill)).toBe(120);
    expect(await recRow(s.rec)).toBe(rec0);
    const ap = await apControlAndSubledger(c);
    expect(ap.control).toBe(ap.subledger);
  }, 120000);

  it('two reallocations crossing contacts finish without a deadlock (three rounds)', async () => {
    for (let round = 0; round < 3; round++) {
      const a = await newSupplier(c);
      const b = await newSupplier(c);
      const billA = await postedBill(c, a, '2026-05-01', 1000);
      const billB = await postedBill(c, b, '2026-05-01', 1000);
      const l1 = await reconciledLine(c, { amount: -400, date: '2026-06-10', statementDate: '2026-06-30', alloc: 'supplier', entity: a });
      const l2 = await reconciledLine(c, { amount: -300, date: '2026-06-11', statementDate: '2026-06-30', alloc: 'supplier', entity: b });
      expect([await paidOf(billA), await paidOf(billB)]).toEqual([400, 300]);
      const g = [await bankGl(c, l1.bank, '2026-06-30'), await bankGl(c, l2.bank, '2026-06-30')];
      const dl0 = await deadlocks();
      const [r1, r2] = await Promise.all([
        mcp(c, TOOL, { transaction_id: l1.bt, expected_journal_entry_id: l1.je, target: { supplier_id: b }, dry_run: false, idempotency_key: key() }),
        mcp(c, TOOL, { transaction_id: l2.bt, expected_journal_entry_id: l2.je, target: { supplier_id: a }, dry_run: false, idempotency_key: key() }),
      ]);
      expect(await deadlocks() - dl0, `round ${round}: Postgres detected a deadlock`).toBe(0);
      expect([r1.isError, r2.isError], `${r1.text}\n${r2.text}`).toEqual([false, false]);
      expect([await paidOf(billA), await paidOf(billB)]).toEqual([300, 400]);
      expect([await bankGl(c, l1.bank, '2026-06-30'), await bankGl(c, l2.bank, '2026-06-30')]).toEqual(g);
      const ap = await apControlAndSubledger(c);
      expect(ap.control).toBe(ap.subledger);
    }
    expect(Math.abs(await trialBalanceGap(c))).toBeLessThan(0.005);
  }, 180000);
});
