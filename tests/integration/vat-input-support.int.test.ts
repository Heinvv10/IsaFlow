/**
 * The pre-filing exceptions against a real ledger holding every ordinary
 * source of VAT (Hein, 2026-09-25): a bill, a bank allocation, a posted
 * expense claim, a captured receipt, a late claim, a supplier credit note —
 * and on the output side a customer credit note and a bank receipt with VAT.
 * None of them blocks eFiling; the bank one is listed as "no tax invoice on
 * file". A bare manual VAT journal is exactly one blocking unsupportedInputVat.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { sql } from '@/lib/neon';
import { approveSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { allocateTransaction } from '@/modules/accounting/services/bank/bankAllocationService';
import { createCreditNote } from '@/modules/accounting/services/ar/creditNoteService';
import { approveCreditNote } from '@/modules/accounting/services/ar/creditNoteApproveService';
import { approveClaim, createClaim, postClaimToGl, submitClaim } from '@/modules/accounting/services/expense/expenseClaimService';
import { createJournalEntry } from '@/modules/accounting/services/gl/journalEntryCrudService';
import { postJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostService';
import { reverseJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostingService';
import { getVatExceptions } from '@/modules/accounting/services/reports/vatExceptionsService';
import { evaluateEfilingGate } from '@/modules/accounting/services/reports/sarsEfilingSubmissionService';
import type { JournalLineInput } from '@/modules/accounting/types/gl.types';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { inTx, seedBankTx } from './helpers/l1FifoFixture';
import {
  NEXT, P, draftBill, dropLateFixture, lockPeriod, seedLateFixture, type LateFixture,
} from './helpers/vatLateClaimFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;
type Row = Record<string, unknown>;
let fx: LateFixture;
let bankJe = '';
const report = () => inTx(fx, () => getVatExceptions(fx.companyId, NEXT.start, NEXT.end));

async function account(code: string, name: string, type: string, subtype: string, normal: string): Promise<string> {
  return String(((await sql`
    INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype, normal_balance, is_active, is_system_account)
    VALUES (${fx.companyId}::UUID, ${code}, ${`${name} ${fx.tag}`}, ${type}, ${subtype}, ${normal}, true, true)
    RETURNING id`) as Row[])[0]!.id);
}

async function postJournal(date: string, source: 'manual' | 'auto_expense_receipt', lines: JournalLineInput[], sourceDocumentId?: string) {
  return inTx(fx, async () => {
    const je = await createJournalEntry(fx.companyId, {
      entryDate: date, description: `support ${source}`, source, lines, ...(sourceDocumentId ? { sourceDocumentId } : {}),
    }, fx.userId);
    await postJournalEntry(fx.companyId, je.id, fx.userId);
    return je.id;
  });
}

async function allocate(amount: number, contra: string): Promise<string> {
  const tx = await seedBankTx(fx, { date: '2026-07-16', amount, description: 'VAT allocation' });
  await inTx(fx, () => allocateTransaction(fx.companyId, tx, contra, fx.userId, 'alloc', 'account', undefined, 'standard'));
  const [r] = (await sql`
    SELECT jl.journal_entry_id FROM bank_transactions bt JOIN gl_journal_lines jl ON jl.id = bt.matched_journal_line_id
    WHERE bt.id = ${tx}::UUID AND bt.company_id = ${fx.companyId}::UUID`) as Row[];
  return String(r!.journal_entry_id);
}

describeIfDb('pre-filing exceptions: input-VAT support', () => {
  beforeAll(async () => {
    assertNotProductionDb('This test posts journals and locks a VAT period.');
    fx = await seedLateFixture('VIS', DATABASE_URL!);
    const sales = await account('4000', 'Sales', 'revenue', 'default_revenue', 'credit');
    const reimburse = await account('2300', 'Employee reimbursements', 'liability', 'other_current_liability', 'credit');
    const employee = randomUUID();
    await sql`INSERT INTO payroll_employees (id, company_id, employee_number, first_name, last_name, start_date)
      VALUES (${employee}::UUID, ${fx.companyId}::UUID, ${`E-${fx.tag}`.slice(0, 20)}, 'Vat', 'Support', '2026-01-01')`;
    await lockPeriod(fx, P.start, P.end);

    // A bill, and a late claim (a bill dated in the filed period P).
    const bill = await draftBill(fx, '2026-07-15');
    await inTx(fx, () => approveSupplierInvoice(fx.companyId, bill.id, fx.userId));
    const late = await draftBill(fx, '2026-06-12');
    await inTx(fx, () => approveSupplierInvoice(fx.companyId, late.id, fx.userId, { allowLateInputClaim: true }));
    // A bank allocation claiming 15 of input VAT; a bank receipt with output VAT.
    bankJe = await allocate(-115, fx.expenseId);
    await allocate(230, sales);
    // A posted expense claim: R115 incl. R15 VAT.
    await inTx(fx, async () => {
      const c = await createClaim({ companyId: fx.companyId, employeeId: employee, claimDate: '2026-07-18', createdBy: fx.userId, lines: [{
        lineDate: '2026-07-18', description: 'Taxi', merchant: 'Cab', amount: 115, vatAmount: 15, vatCode: 'standard',
        glAccountId: fx.expenseId, costCentreId: null, projectId: null, sourceDocumentId: null,
        kmTravelled: null, kmRate: null, mileageFrom: null, mileageTo: null,
      }] });
      await submitClaim(c.id, fx.companyId);
      await approveClaim(c.id, fx.companyId, fx.userId);
      await postClaimToGl(c.id, fx.companyId, { userId: fx.userId, reimbursementAccountId: reimburse, vatInputAccountId: fx.vatInputId });
    });
    // A captured receipt that read R30 of VAT, posted against it.
    const doc = randomUUID();
    await sql`INSERT INTO captured_documents (id, company_id, file_name, file_type, extracted_data, status)
      VALUES (${doc}::UUID, ${fx.companyId}::UUID, 'slip.jpg', 'image/jpeg', ${JSON.stringify({ vatAmount: 30, totalAmount: 230 })}::JSONB, 'processed')`;
    await postJournal('2026-07-20', 'auto_expense_receipt', [
      { glAccountId: fx.expenseId, debit: 200, credit: 0, description: 'slip', vatType: 'standard' },
      { glAccountId: fx.vatInputId, debit: 30, credit: 0, description: 'VAT', vatType: 'standard' },
      { glAccountId: fx.bankAccountId, debit: 0, credit: 230, description: 'paid' },
    ], doc);
  }, 240000);

  afterAll(async () => {
    if (!fx) return;
    const c = fx.companyId;
    await sql`DELETE FROM expense_claims WHERE company_id = ${c}::UUID`;
    await sql`DELETE FROM payroll_employees WHERE company_id = ${c}::UUID`;
    await sql`DELETE FROM credit_notes WHERE company_id = ${c}::UUID`;
    await sql`UPDATE bank_transactions SET matched_journal_line_id = NULL WHERE company_id = ${c}::UUID`;
    await dropLateFixture(fx);
  }, 120000);

  it('every ordinary source: 0 blocking exceptions and the eFiling gate lets it through', async () => {
    const r = await report();
    expect(r.unsupportedInputVat).toEqual([]);
    expect(r.controlRecon.outputVariance).toBe(0);
    expect(r.controlRecon.inputVariance).toBe(0);
    expect(r.uncodedGlLines).toEqual([]);
    expect(r.totalExceptions).toBe(0);
    expect(evaluateEfilingGate(r)).toEqual({ allowed: true, reason: null });
  });

  it('the bank-only claim is listed as no tax invoice on file, and only it', async () => {
    const r = await report();
    expect(r.inputVatWithoutTaxInvoice.map((l) => [l.journalEntryId, l.supportKind, l.claimedVat]))
      .toEqual([[bankJe, 'bank', 15]]);
    expect(r.inputVatWithoutTaxInvoiceCount).toBe(1);
  });

  it('credit notes (supplier and customer): still 0 blocking exceptions and the gate lets it through', async () => {
    await inTx(fx, async () => {
      const scn = await createCreditNote(fx.companyId, { type: 'supplier', supplierId: fx.supplierId, creditDate: '2026-07-22', subtotal: 100, taxRate: 15 }, fx.userId);
      const ccn = await createCreditNote(fx.companyId, { type: 'customer', clientId: fx.customerId, creditDate: '2026-07-23', subtotal: 200, taxRate: 15 }, fx.userId);
      await approveCreditNote(fx.companyId, scn.id, fx.userId);
      await approveCreditNote(fx.companyId, ccn.id, fx.userId);
    });
    const r = await report();
    expect(r.unsupportedInputVat).toEqual([]);
    expect(r.controlRecon.outputVariance).toBe(0);
    expect(r.controlRecon.inputVariance).toBe(0);
    // approveCreditNote codes its VAT leg (2026-09-25), so no uncoded line either.
    expect(r.uncodedGlLines).toEqual([]);
    expect(r.totalExceptions).toBe(0);
    expect(evaluateEfilingGate(r)).toEqual({ allowed: true, reason: null });
  });

  it('a PARTIAL supplier credit note (less than the original bill\'s VAT) is still supported', async () => {
    const bill = await draftBill(fx, '2026-07-24');
    await inTx(fx, () => approveSupplierInvoice(fx.companyId, bill.id, fx.userId));
    // The bill claims R150; this credit note reverses only R50 of it — a
    // genuine partial credit, not a mismatch, because its own reduction
    // matches its own tax exactly. The bill's chain is excluded from this
    // query (findInputVatSupport looks only at non-bill chains); the credit
    // note's OWN chain is what is classified here.
    const pcn = await inTx(fx, () => createCreditNote(fx.companyId,
      { type: 'supplier', supplierId: fx.supplierId, creditDate: '2026-07-24', subtotal: 333.33, taxRate: 15 },
      fx.userId));
    await inTx(fx, () => approveCreditNote(fx.companyId, pcn.id, fx.userId));
    const r = await report();
    expect(r.unsupportedInputVat).toEqual([]);
    expect(r.totalExceptions).toBe(0);
    expect(evaluateEfilingGate(r)).toEqual({ allowed: true, reason: null });
  });

  // Captured directly from the journal this test posts — never re-derived by
  // reading it back out of a later report(), so the two tests below do not
  // depend on running (or having run) straight after this one.
  let manualBareJe = '';

  it('a bare manual VAT journal is exactly one blocking unsupportedInputVat, and the gate refuses', async () => {
    const je = await postJournal('2026-07-25', 'manual', [
      { glAccountId: fx.expenseId, debit: 100, credit: 0, description: 'no document', vatType: 'standard' },
      { glAccountId: fx.vatInputId, debit: 15, credit: 0, description: 'VAT', vatType: 'standard' },
      { glAccountId: fx.bankAccountId, debit: 0, credit: 115, description: 'paid' },
    ]);
    manualBareJe = je;
    const r = await report();
    expect(r.unsupportedInputVat.map((l) => [l.journalEntryId, l.reason, l.claimedVat])).toEqual([[je, 'no_document', 15]]);
    expect(r.unsupportedInputVatCount).toBe(1);
    expect(r.totalExceptions).toBe(1);
    expect(evaluateEfilingGate(r).allowed).toBe(false);
  });

  // A reversed pair nets, as the per-journal over-claim nets it (JE-2026-04873
  // on dev: manual R1 VAT, reversed the same day). The claim stands in its own
  // period only while its reversal is dated AFTER that period.
  const bareVat = () => [
    { glAccountId: fx.expenseId, debit: 100, credit: 0, description: 'no document', vatType: 'standard' as const },
    { glAccountId: fx.vatInputId, debit: 15, credit: 0, description: 'VAT', vatType: 'standard' as const },
    { glAccountId: fx.bankAccountId, debit: 0, credit: 115, description: 'paid' },
  ];
  it('a claim reversed in the same period is not unsupported', async () => {
    const je = await postJournal('2026-07-26', 'manual', bareVat());
    await inTx(fx, () => reverseJournalEntry(fx.companyId, je, fx.userId));
    const r = await report();
    expect(r.unsupportedInputVat.map((l) => l.journalEntryId)).toEqual([manualBareJe]);
  });

  it('a claim reversed only in a LATER period still blocks in its own period', async () => {
    const je = await postJournal('2026-07-27', 'manual', bareVat());
    await inTx(fx, () => reverseJournalEntry(fx.companyId, je, fx.userId, { reversalDate: '2026-09-02' }));
    const r = await report();
    expect(r.unsupportedInputVat.map((l) => l.journalEntryId)).toEqual([manualBareJe, je]);
    const sep = await inTx(fx, () => getVatExceptions(fx.companyId, '2026-09-01', '2026-10-31'));
    expect(sep.unsupportedInputVat).toEqual([]); // the reversal alone is a reduction, never a claim
  });
});
