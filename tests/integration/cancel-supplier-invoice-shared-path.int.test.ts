/**
 * The UI Cancel button and the bulk cancel action call `cancelSupplierInvoice`
 * directly, without the MCP tool's plan. Every refusal the plan makes must hold
 * on that shared path too, and leave the bill and the ledger untouched.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from '@/lib/neon';
import { SupplierInvoiceCancelRefusal } from '@/modules/accounting/services/ap/supplierInvoiceCancelPlan';
import { cancelSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
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
  status?: string; sourceRecordId?: string; source?: string; extraAccount?: string;
} = {}): Promise<string> {
  const je = String(((await sql`
    INSERT INTO gl_journal_entries
      (company_id, entry_number, entry_date, description, status, created_by, fiscal_period_id, posted_at,
       source, source_record_id)
    VALUES (${fx.companyId}::UUID, ${`JE-S${++seq}-${fx.tag}`}, ${date}::DATE, 'seed',
            ${opts.status ?? 'posted'}, ${fx.userId}::UUID,
            (SELECT id FROM fiscal_periods WHERE company_id = ${fx.companyId}::UUID LIMIT 1),
            ${opts.status === 'draft' ? null : new Date().toISOString()}::TIMESTAMPTZ,
            ${opts.source ?? 'auto_supplier_invoice'}, ${opts.sourceRecordId ?? null}::UUID)
    RETURNING id`) as Row[])[0]!.id);
  await sql`
    INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit, description)
    VALUES (${fx.companyId}::UUID, ${je}::UUID, ${opts.extraAccount ?? expenseAccount}::UUID, ${amount}, 0, 'dr'),
           (${fx.companyId}::UUID, ${je}::UUID, ${apAccount}::UUID, 0, ${amount}, 'cr')`;
  return je;
}

async function postedBill(total: number, date = '2026-05-01'): Promise<string> {
  const bill = await seedBill(fx, { number: `SP${++seq}`, date, total });
  const je = await seedJournal(total, date);
  await sql`UPDATE supplier_invoices SET gl_journal_entry_id = ${je}::UUID WHERE id = ${bill}::UUID`;
  return bill;
}

async function state(bill: string): Promise<Row> {
  const row = ((await sql`
    SELECT status, gl_journal_entry_id FROM supplier_invoices WHERE id = ${bill}::UUID`) as Row[])[0]!;
  const contras = Number(((await sql`
    SELECT COUNT(*)::INT AS n FROM gl_journal_entries
    WHERE company_id = ${fx.companyId}::UUID AND reversal_of_id = ${row.gl_journal_entry_id ?? null}::UUID`) as Row[])[0]!.n);
  return { ...row, contras };
}

async function refusedLeavingItAlone(bill: string, message: RegExp): Promise<void> {
  const before = await state(bill);
  const err = await inTx(fx, () => cancelSupplierInvoice(fx.companyId, bill, fx.userId)).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(SupplierInvoiceCancelRefusal);
  expect((err as Error).message).toMatch(message);
  expect(await state(bill)).toEqual(before);
}

describeIfDb('cancelSupplierInvoice — the shared path the UI and bulk cancel use', () => {
  beforeAll(async () => {
    assertNotProductionDb('This test posts and reverses journals.');
    fx = await seedFixture('CSP', DATABASE_URL!);
    apAccount = await accountId('payable');
    expenseAccount = await accountId('default_expense');
  }, 120000);

  afterAll(async () => {
    await sql`DELETE FROM vat_period_locks WHERE company_id = ${fx.companyId}::UUID`;
    await sql`DELETE FROM payment_allocations WHERE payment_id IN (
      SELECT id FROM supplier_payments WHERE company_id = ${fx.companyId}::UUID)`;
    await sql`UPDATE supplier_invoices SET gl_journal_entry_id = NULL WHERE company_id = ${fx.companyId}::UUID`;
    await sql`DELETE FROM gl_journal_lines WHERE company_id = ${fx.companyId}::UUID`;
    await sql`UPDATE gl_journal_entries SET reversal_of_id = NULL, reversed_by = NULL
              WHERE company_id = ${fx.companyId}::UUID`;
    await sql`DELETE FROM gl_journal_entries WHERE company_id = ${fx.companyId}::UUID`;
    await dropFixture(fx);
  }, 120000);

  it('refuses credit applied to a bill whose status was never recomputed', async () => {
    const bill = await postedBill(100);
    await sql`UPDATE supplier_invoices SET amount_paid = 40 WHERE id = ${bill}::UUID`;
    await refusedLeavingItAlone(bill, /R40\.00/);
  });

  it('refuses a bank-matched bill', async () => {
    const bill = await postedBill(60);
    await sql`UPDATE supplier_invoices SET payment_matched = true WHERE id = ${bill}::UUID`;
    await refusedLeavingItAlone(bill, /matched to a bank payment/);
  });

  it('refuses a bill a draft or approved payment still plans to pay', async () => {
    const bill = await postedBill(100);
    const payNumber = `PS${seq}-${fx.tag}`.slice(0, 30);
    const pay = String(((await sql`
      INSERT INTO supplier_payments (company_id, supplier_id, payment_number, payment_date, total_amount, status, created_by)
      VALUES (${fx.companyId}::UUID, ${fx.supplierId}::UUID, ${payNumber}, '2026-05-05', 100, 'draft', ${fx.userId}::UUID)
      RETURNING id`) as Row[])[0]!.id);
    await sql`INSERT INTO payment_allocations (payment_id, invoice_id, amount_allocated) VALUES (${pay}::UUID, ${bill}::UUID, 100)`;
    await refusedLeavingItAlone(bill, new RegExp(payNumber));
  });

  it('refuses while another posted journal sourced from the bill stands', async () => {
    const bill = await postedBill(115);
    await seedJournal(15, '2026-05-01', { sourceRecordId: bill, source: 'auto_vat_adjustment' });
    await refusedLeavingItAlone(bill, /other posted journal/);
  });

  it('refuses a bill whose linked journal is still a draft', async () => {
    const bill = await seedBill(fx, { number: `SP${++seq}`, date: '2026-05-07', total: 40, status: 'draft' });
    const je = await seedJournal(40, '2026-05-07', { status: 'draft' });
    await sql`UPDATE supplier_invoices SET gl_journal_entry_id = ${je}::UUID WHERE id = ${bill}::UUID`;
    await refusedLeavingItAlone(bill, /draft journal/);
  });

  it('refuses an approved bill with no approval journal to reverse', async () => {
    const bill = await seedBill(fx, { number: `SP${++seq}`, date: '2026-05-06', total: 80 });
    await refusedLeavingItAlone(bill, /no approval journal/);
  });

  // Ruling for reversals (central VAT lock, #491): a contra whose default date
  // is inside a locked VAT period rolls FORWARD past the lock rather than
  // refusing — so the UI cancel succeeds and its contra lands after the lock.
  it('rolls a VAT-carrying reversal past a locked VAT period instead of refusing', async () => {
    const bill = await seedBill(fx, { number: `SP${++seq}`, date: '2026-06-10', total: 115 });
    const je = await seedJournal(115, '2026-06-10', { extraAccount: await accountId('vat_input') });
    await sql`UPDATE supplier_invoices SET gl_journal_entry_id = ${je}::UUID WHERE id = ${bill}::UUID`;
    await sql`
      INSERT INTO vat_period_locks
        (company_id, period_start, period_end, output_tax, input_tax, net_vat, posted_through, locked_by)
      VALUES (${fx.companyId}::UUID, '2026-06-01', '2026-06-30', 0, 0, 0, '2026-06-30', ${fx.userId}::UUID)`;
    try {
      await inTx(fx, () => cancelSupplierInvoice(fx.companyId, bill, fx.userId));
      expect((await state(bill)).status).toBe('cancelled');
      const contra = ((await sql`
        SELECT entry_date::TEXT AS d FROM gl_journal_entries
        WHERE company_id = ${fx.companyId}::UUID AND reversal_of_id = ${je}::UUID`) as Row[])[0]!;
      expect(contra.d > '2026-06-30').toBe(true);
    } finally {
      await sql`DELETE FROM vat_period_locks WHERE company_id = ${fx.companyId}::UUID`;
    }
  });

  it('still cancels a clean approved bill and a draft', async () => {
    const approved = await postedBill(230);
    const je = String((await state(approved)).gl_journal_entry_id);
    await inTx(fx, () => cancelSupplierInvoice(fx.companyId, approved, fx.userId));
    expect((await state(approved)).status).toBe('cancelled');
    expect(Number(((await sql`
      SELECT COUNT(*)::INT AS n FROM gl_journal_entries
      WHERE company_id = ${fx.companyId}::UUID AND reversal_of_id = ${je}::UUID AND status = 'posted'`) as Row[])[0]!.n)).toBe(1);
    const draft = await seedBill(fx, { number: `SP${++seq}`, date: '2026-05-02', total: 50, status: 'draft' });
    await inTx(fx, () => cancelSupplierInvoice(fx.companyId, draft, fx.userId));
    expect((await state(draft)).status).toBe('cancelled');
  });
});
