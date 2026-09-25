/**
 * Shared seed for the late input-VAT claim tests (gl/vatLateClaimSplit.ts): the
 * L1 fixture company plus the clearing account migration 701 gives every real
 * company, and a VAT period LOCKED the way the product locks one — with the
 * figures computeVatLockFigures snapshots.
 */
import { sql } from '@/lib/neon';
import { computeVatLockFigures } from '@/modules/accounting/services/reports/vatPeriodLockFigures';
import { clearSystemAccountCache } from '@/modules/accounting/services/gl/systemAccountResolver';
import { createSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceService';
import { dropFixture, inTx, seedFixture, type Fixture } from './l1FifoFixture';

type Row = Record<string, unknown>;

export const P = { start: '2026-05-01', end: '2026-06-30' } as const;
export const NEXT = { start: '2026-07-01', end: '2026-08-31' } as const;

export interface LateFixture extends Fixture {
  clearingId: string;
  vatInputId: string;
  expenseId: string;
  apId: string;
}

async function accountBySubtype(companyId: string, subtype: string): Promise<string> {
  return String(((await sql`
    SELECT id FROM gl_accounts WHERE company_id = ${companyId}::UUID AND account_subtype = ${subtype}
    LIMIT 1`) as Row[])[0]!.id);
}

export async function seedLateFixture(prefix: string, databaseUrl: string): Promise<LateFixture> {
  const fx = await seedFixture(prefix, databaseUrl);
  const clearingId = String(((await sql`
    INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype,
                             normal_balance, is_active, is_system_account)
    VALUES (${fx.companyId}::UUID, '1145', ${`Input VAT - late claims ${fx.tag}`}, 'asset',
            'vat_input_late_claim', 'debit', true, true)
    RETURNING id`) as Row[])[0]!.id);
  clearSystemAccountCache(fx.companyId);
  return {
    ...fx, clearingId,
    vatInputId: await accountBySubtype(fx.companyId, 'vat_input'),
    expenseId: await accountBySubtype(fx.companyId, 'default_expense'),
    apId: await accountBySubtype(fx.companyId, 'payable'),
  };
}

export async function dropLateFixture(fx: LateFixture): Promise<void> {
  const c = fx.companyId;
  clearSystemAccountCache(c);
  await sql`DELETE FROM vat_period_locks WHERE company_id = ${c}::UUID`;
  await sql`DELETE FROM approval_requests WHERE company_id = ${c}::UUID`;
  await sql`DELETE FROM supplier_coding_history WHERE company_id = ${c}::UUID`;
  await sql`DELETE FROM supplier_invoice_items WHERE supplier_invoice_id IN (
    SELECT id FROM supplier_invoices WHERE company_id = ${c}::UUID)`;
  await sql`UPDATE supplier_invoices SET gl_journal_entry_id = NULL WHERE company_id = ${c}::UUID`;
  await sql`UPDATE gl_journal_entries SET late_claim_of_id = NULL, reversal_of_id = NULL WHERE company_id = ${c}::UUID`;
  await dropFixture(fx);
}

/** Lock a VAT period exactly as the product does: snapshot, then record. */
export async function lockPeriod(fx: Fixture, start: string, end: string): Promise<void> {
  await inTx(fx, async () => {
    const { figures } = await computeVatLockFigures(fx.companyId, start, end);
    await sql`
      INSERT INTO vat_period_locks
        (company_id, period_start, period_end, output_tax, input_tax, net_vat, posted_through, locked_by)
      VALUES (${fx.companyId}::UUID, ${start}::DATE, ${end}::DATE, ${figures.outputTax}, ${figures.inputTax},
              ${figures.netVat}, ${figures.postedThrough}, ${fx.userId})`;
  });
}

/** The VAT201 figures a lock would record for the period, now. */
export async function vatFigures(fx: Fixture, start: string, end: string) {
  return inTx(fx, async () => (await computeVatLockFigures(fx.companyId, start, end)).figures);
}

/** Posted balance (debit − credit) of one account. */
export async function balanceOf(fx: Fixture, accountId: string): Promise<number> {
  const [r] = (await sql`
    SELECT COALESCE(SUM(jl.debit - jl.credit), 0)::NUMERIC AS b
    FROM gl_journal_lines jl JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
    WHERE jl.company_id = ${fx.companyId}::UUID AND je.company_id = ${fx.companyId}::UUID
      AND je.status = 'posted' AND jl.gl_account_id = ${accountId}::UUID`) as Row[];
  return Number(r!.b);
}

let n = 0;
/** A draft bill for R1 000 + 15% VAT, dated `date`. */
export async function draftBill(
  fx: LateFixture, date: string, over: { vatClassification?: string; glAccountId?: string } = {},
) {
  return inTx(fx, () => createSupplierInvoice(fx.companyId, {
    supplierId: fx.supplierId, invoiceNumber: `LC-${++n}-${fx.tag}`.slice(0, 50), invoiceDate: date,
    items: [{
      description: 'Consulting', quantity: 1, unitPrice: 1000, taxRate: 15,
      glAccountId: over.glAccountId ?? fx.expenseId,
      ...(over.vatClassification ? { vatClassification: over.vatClassification as never } : {}),
    }],
  }, fx.userId));
}

export async function countRows(fx: Fixture): Promise<{ entries: number; lines: number }> {
  const [r] = (await sql`
    SELECT (SELECT COUNT(*)::INT FROM gl_journal_entries WHERE company_id = ${fx.companyId}::UUID) AS entries,
           (SELECT COUNT(*)::INT FROM gl_journal_lines WHERE company_id = ${fx.companyId}::UUID) AS lines`) as Row[];
  return { entries: Number(r!.entries), lines: Number(r!.lines) };
}
