/**
 * Soft-deleting a bill takes it out of the AP subledger and reverses its
 * approval journal — the same effect as cancelling it. So the delete must
 * refuse everything the cancel plan refuses, or it is a way around Cancel.
 * Each refusal leaves the bill undeleted and the ledger untouched.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from '@/lib/neon';
import { softDelete } from '@/modules/accounting/services/core/softDeleteService';
import { SoftDeleteRefusalError } from '@/modules/accounting/services/core/softDeleteErrors';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { dropFixture, inTx, seedBill, seedFixture, type Fixture } from './helpers/l1FifoFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

type Row = Record<string, unknown>;
let fx: Fixture;
let apAccount: string;
let expenseAccount: string;
let seq = 0;

async function accountId(subtype: string): Promise<string> {
  return String(((await sql`
    SELECT id FROM gl_accounts WHERE company_id = ${fx.companyId}::UUID AND account_subtype = ${subtype}
    LIMIT 1`) as Row[])[0]!.id);
}

async function seedJournal(amount: number, date: string, opts: {
  status?: string; sourceRecordId?: string; source?: string;
} = {}): Promise<string> {
  const je = String(((await sql`
    INSERT INTO gl_journal_entries
      (company_id, entry_number, entry_date, description, status, created_by, fiscal_period_id, posted_at,
       source, source_record_id)
    VALUES (${fx.companyId}::UUID, ${`JE-D${++seq}-${fx.tag}`}, ${date}::DATE, 'seed',
            ${opts.status ?? 'posted'}, ${fx.userId}::UUID,
            (SELECT id FROM fiscal_periods WHERE company_id = ${fx.companyId}::UUID LIMIT 1),
            ${opts.status === 'draft' ? null : new Date().toISOString()}::TIMESTAMPTZ,
            ${opts.source ?? 'auto_supplier_invoice'}, ${opts.sourceRecordId ?? null}::UUID)
    RETURNING id`) as Row[])[0]!.id);
  await sql`
    INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit, description)
    VALUES (${fx.companyId}::UUID, ${je}::UUID, ${expenseAccount}::UUID, ${amount}, 0, 'dr'),
           (${fx.companyId}::UUID, ${je}::UUID, ${apAccount}::UUID, 0, ${amount}, 'cr')`;
  return je;
}

async function postedBill(total: number, date = '2026-05-01'): Promise<string> {
  const bill = await seedBill(fx, { number: `SD${++seq}`, date, total });
  const je = await seedJournal(total, date);
  await sql`UPDATE supplier_invoices SET gl_journal_entry_id = ${je}::UUID WHERE id = ${bill}::UUID`;
  return bill;
}

/** The bill row and every journal this company holds that reverses something. */
async function state(bill: string): Promise<Row> {
  const row = ((await sql`
    SELECT status, deleted_at, gl_journal_entry_id FROM supplier_invoices WHERE id = ${bill}::UUID`) as Row[])[0]!;
  const reversals = Number(((await sql`
    SELECT COUNT(*)::INT AS n FROM gl_journal_entries
    WHERE company_id = ${fx.companyId}::UUID AND reversal_of_id IS NOT NULL`) as Row[])[0]!.n);
  return { ...row, reversals };
}

const del = (bill: string) =>
  inTx(fx, () => softDelete(fx.companyId, 'supplier_invoice', bill, fx.userId));

async function refusedLeavingItAlone(bill: string, message: RegExp): Promise<void> {
  const before = await state(bill);
  const err = await del(bill).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(SoftDeleteRefusalError);
  expect((err as Error).message).toMatch(message);
  expect(await state(bill)).toEqual(before);
}

describeIfDb('softDelete(supplier_invoice) — held to the cancel plan', () => {
  beforeAll(async () => {
    assertNotProductionDb('This test posts and reverses journals.');
    fx = await seedFixture('SDB', DATABASE_URL!);
    apAccount = await accountId('payable');
    expenseAccount = await accountId('default_expense');
  }, 120000);

  afterAll(async () => {
    await sql`DELETE FROM soft_delete_journal_reversals WHERE company_id = ${fx.companyId}::UUID`;
    await sql`UPDATE supplier_invoices SET gl_journal_entry_id = NULL WHERE company_id = ${fx.companyId}::UUID`;
    await sql`DELETE FROM gl_journal_lines WHERE company_id = ${fx.companyId}::UUID`;
    await sql`UPDATE gl_journal_entries SET reversal_of_id = NULL, reversed_by = NULL
              WHERE company_id = ${fx.companyId}::UUID`;
    await sql`DELETE FROM gl_journal_entries WHERE company_id = ${fx.companyId}::UUID`;
    await dropFixture(fx);
  }, 120000);

  it('refuses a bank-matched bill', async () => {
    const bill = await postedBill(60);
    await sql`UPDATE supplier_invoices SET payment_matched = true WHERE id = ${bill}::UUID`;
    await refusedLeavingItAlone(bill, /matched to a bank payment/);
  });

  it('refuses while another posted journal sourced from the bill stands', async () => {
    const bill = await postedBill(115);
    await seedJournal(15, '2026-05-01', { sourceRecordId: bill, source: 'auto_vat_adjustment' });
    await refusedLeavingItAlone(bill, /other posted journal/);
  });

  it('refuses a bill whose linked journal is still a draft', async () => {
    const bill = await seedBill(fx, { number: `SD${++seq}`, date: '2026-05-07', total: 40, status: 'draft' });
    const je = await seedJournal(40, '2026-05-07', { status: 'draft' });
    await sql`UPDATE supplier_invoices SET gl_journal_entry_id = ${je}::UUID WHERE id = ${bill}::UUID`;
    await refusedLeavingItAlone(bill, /draft journal/);
  });

  it('refuses an approved bill with no approval journal to reverse', async () => {
    const bill = await seedBill(fx, { number: `SD${++seq}`, date: '2026-05-06', total: 80 });
    await refusedLeavingItAlone(bill, /no approval journal/);
  });

  it('still deletes a clean approved bill, a draft and a cancelled bill', async () => {
    const approved = await postedBill(230);
    const je = String((await state(approved)).gl_journal_entry_id);
    await del(approved);
    expect((await state(approved)).deleted_at).not.toBeNull();
    expect(Number(((await sql`
      SELECT COUNT(*)::INT AS n FROM gl_journal_entries
      WHERE company_id = ${fx.companyId}::UUID AND reversal_of_id = ${je}::UUID AND status = 'posted'`) as Row[])[0]!.n)).toBe(1);

    const draft = await seedBill(fx, { number: `SD${++seq}`, date: '2026-05-02', total: 50, status: 'draft' });
    await del(draft);
    expect((await state(draft)).deleted_at).not.toBeNull();

    // A cancelled bill is past the plan (it refuses "already cancelled");
    // deleting one is housekeeping and must stay possible.
    const cancelled = await seedBill(fx, { number: `SD${++seq}`, date: '2026-05-03', total: 70, status: 'cancelled' });
    await del(cancelled);
    expect((await state(cancelled)).deleted_at).not.toBeNull();
  });
});
