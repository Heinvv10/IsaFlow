/**
 * Owner's decision (Hein, 2026-09-26): the cut between BLOCKING and WARNING
 * on input-VAT support is whether the return's FIGURES would be wrong, not
 * whether a document is attached in IsaFlow.
 *
 *   NOT blocking — `no_document` (no link at all) and `unreadable_document_vat`
 *   (a document exists, its VAT just couldn't be read): only a RECORD is
 *   missing. Holding a valid tax invoice is the vendor's legal responsibility
 *   under s16(2), and it may be held outside IsaFlow, so these don't refuse
 *   locking, mark-submitted or eFiling — the row stays listed with its amount.
 *
 *   STILL blocking — `amount_mismatch` (credit note, expense claim, captured
 *   document, bank ceiling) and `document_over_claimed`: the claimed VAT does
 *   not tie to what supports it, so the return's figures ARE wrong.
 *
 * This file pins both directions end-to-end: getVatExceptions' lists and
 * totalExceptions, evaluateEfilingGate, and assertVatGateClear for BOTH
 * lock and mark-submitted targets.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { sql } from '@/lib/neon';
import { createJournalEntry } from '@/modules/accounting/services/gl/journalEntryCrudService';
import { postJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostService';
import { allocateTransaction } from '@/modules/accounting/services/bank/bankAllocationService';
import { approveClaim, createClaim, postClaimToGl, submitClaim } from '@/modules/accounting/services/expense/expenseClaimService';
import { getVatExceptions } from '@/modules/accounting/services/reports/vatExceptionsService';
import { evaluateEfilingGate } from '@/modules/accounting/services/reports/sarsEfilingSubmissionService';
import { assertVatGateClear } from '@/modules/accounting/services/reports/vatGateOverrideService';
import type { JournalLineInput } from '@/modules/accounting/types/gl.types';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { inTx, seedBankTx } from './helpers/l1FifoFixture';
import { dropLateFixture, seedLateFixture, type LateFixture } from './helpers/vatLateClaimFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;
type Row = Record<string, unknown>;
let fx: LateFixture;
let reimburseId: string;
let employeeId: string;

const S = '2026-07-01';
const E = '2026-08-31';
const report = () => inTx(fx, () => getVatExceptions(fx.companyId, S, E));
const actor = () => ({ userId: fx.userId, role: 'owner' as const });

async function account(code: string, name: string, type: string, subtype: string, normal: string): Promise<string> {
  return String(((await sql`
    INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype, normal_balance, is_active, is_system_account)
    VALUES (${fx.companyId}::UUID, ${code}, ${`${name} ${fx.tag}`}, ${type}, ${subtype}, ${normal}, true, true)
    RETURNING id`) as Row[])[0]!.id);
}

async function postJournal(date: string, lines: JournalLineInput[], sourceDocumentId?: string) {
  return inTx(fx, async () => {
    const je = await createJournalEntry(fx.companyId, {
      entryDate: date, description: 'unsupported-input-warn', source: 'manual', lines,
      ...(sourceDocumentId ? { sourceDocumentId } : {}),
    }, fx.userId);
    await postJournalEntry(fx.companyId, je.id, fx.userId);
    return je.id;
  });
}

describeIfDb('unsupported input VAT: warning vs blocking (Hein, 2026-09-26)', () => {
  beforeAll(async () => {
    assertNotProductionDb('vat-unsupported-input-warn');
    fx = await seedLateFixture('VUW', DATABASE_URL!);
    reimburseId = await account('2300', 'Employee reimbursements', 'liability', 'other_current_liability', 'credit');
    employeeId = randomUUID();
    await sql`INSERT INTO payroll_employees (id, company_id, employee_number, first_name, last_name, start_date, medical_aid_main_member)
      VALUES (${employeeId}::UUID, ${fx.companyId}::UUID, ${`E-${fx.tag}`.slice(0, 20)}, 'Vat', 'Warn', '2026-01-01', true)`;
  }, 240000);

  afterAll(async () => {
    if (!fx) return;
    await sql`DELETE FROM expense_claims WHERE company_id = ${fx.companyId}::UUID`;
    await sql`DELETE FROM payroll_employees WHERE company_id = ${fx.companyId}::UUID`;
    await dropLateFixture(fx);
  }, 120000);

  it('no_document alone: not blocking, gate allows, lock and mark-submitted succeed without override, row still listed', async () => {
    const je = await postJournal('2026-07-05', [
      { glAccountId: fx.expenseId, debit: 100, credit: 0, description: 'no doc', vatType: 'standard' },
      { glAccountId: fx.vatInputId, debit: 15, credit: 0, description: 'VAT', vatType: 'standard' },
      { glAccountId: fx.bankAccountId, debit: 0, credit: 115, description: 'paid' },
    ]);
    const r = await report();
    expect(r.unsupportedInputVat).toEqual([]);
    expect(r.inputVatWithoutTaxInvoice.map((l) => [l.journalEntryId, l.reason, l.claimedVat])).toEqual([[je, 'no_document', 15]]);
    expect(r.totalExceptions).toBe(0);
    expect(evaluateEfilingGate(r)).toEqual({ allowed: true, reason: null });

    const lock = await inTx(fx, () => assertVatGateClear(fx.companyId, S, E, 'vat_period_lock', null, actor(), undefined));
    expect(lock).toEqual({ overridden: false, counts: expect.objectContaining({ totalExceptions: 0 }) });
    const submit = await inTx(fx, () => assertVatGateClear(fx.companyId, S, E, 'sars_submission', null, actor(), undefined));
    expect(submit).toEqual({ overridden: false, counts: expect.objectContaining({ totalExceptions: 0 }) });
  });

  it('unreadable document VAT alone: not blocking, gate allows, lock and mark-submitted succeed without override, row still listed', async () => {
    const doc = randomUUID();
    await sql`INSERT INTO captured_documents (id, company_id, file_name, file_type, extracted_data, status)
      VALUES (${doc}::UUID, ${fx.companyId}::UUID, 'bad.jpg', 'image/jpeg', ${JSON.stringify({ vatAmount: 'fifteen', totalAmount: 230 })}::JSONB, 'processed')`;
    const je = await postJournal('2026-07-06', [
      { glAccountId: fx.expenseId, debit: 200, credit: 0, description: 'unreadable', vatType: 'standard' },
      { glAccountId: fx.vatInputId, debit: 30, credit: 0, description: 'VAT', vatType: 'standard' },
      { glAccountId: fx.bankAccountId, debit: 0, credit: 230, description: 'paid' },
    ], doc);
    const r = await report();
    expect(r.unsupportedInputVat.map((l) => l.journalEntryId)).not.toContain(je);
    expect(r.inputVatWithoutTaxInvoice.map((l) => [l.journalEntryId, l.reason])).toContainEqual([je, 'unreadable_document_vat']);
    // Isolate: no other exception is present at this point in the suite bar
    // the no_document row above, which is also non-blocking.
    expect(r.totalExceptions).toBe(0);
    expect(evaluateEfilingGate(r)).toEqual({ allowed: true, reason: null });

    const lock = await inTx(fx, () => assertVatGateClear(fx.companyId, S, E, 'vat_period_lock', null, actor(), undefined));
    expect(lock).toEqual({ overridden: false, counts: expect.objectContaining({ totalExceptions: 0 }) });
    const submit = await inTx(fx, () => assertVatGateClear(fx.companyId, S, E, 'sars_submission', null, actor(), undefined));
    expect(submit).toEqual({ overridden: false, counts: expect.objectContaining({ totalExceptions: 0 }) });
  });

  it('a document over-claim STILL blocks eFiling', async () => {
    const doc = randomUUID();
    await sql`INSERT INTO captured_documents (id, company_id, file_name, file_type, extracted_data, status)
      VALUES (${doc}::UUID, ${fx.companyId}::UUID, 'slip.jpg', 'image/jpeg', ${JSON.stringify({ vatAmount: 30, totalAmount: 230 })}::JSONB, 'processed')`;
    // First claim is fully supported by the document.
    await postJournal('2026-07-10', [
      { glAccountId: fx.expenseId, debit: 200, credit: 0, description: 'slip 1', vatType: 'standard' },
      { glAccountId: fx.vatInputId, debit: 30, credit: 0, description: 'VAT', vatType: 'standard' },
      { glAccountId: fx.bankAccountId, debit: 0, credit: 230, description: 'paid' },
    ], doc);
    // A second, unrelated journal linked to the SAME document via an active
    // gl_journal_document_links row over-claims it (60 claimed vs its 30).
    const je2 = await postJournal('2026-07-11', [
      { glAccountId: fx.expenseId, debit: 200, credit: 0, description: 'slip 2', vatType: 'standard' },
      { glAccountId: fx.vatInputId, debit: 30, credit: 0, description: 'VAT', vatType: 'standard' },
      { glAccountId: fx.bankAccountId, debit: 0, credit: 230, description: 'paid' },
    ]);
    await sql`INSERT INTO gl_journal_document_links (company_id, journal_entry_id, captured_document_id, linked_by, reason)
      VALUES (${fx.companyId}::UUID, ${je2}::UUID, ${doc}::UUID, ${fx.userId}, 'over-claim test')`;

    const r = await report();
    const flagged = r.unsupportedInputVat.find((l) => l.journalEntryId === je2);
    expect(flagged?.reason).toBe('document_over_claimed');
    expect(r.totalExceptions).toBeGreaterThan(0);
    expect(evaluateEfilingGate(r).allowed).toBe(false);
    await expect(
      inTx(fx, () => assertVatGateClear(fx.companyId, S, E, 'vat_period_lock', null, actor(), undefined)),
    ).rejects.toThrow();

    await sql`DELETE FROM gl_journal_document_links WHERE company_id = ${fx.companyId}::UUID AND journal_entry_id = ${je2}::UUID`;
  });

  it('a bank-ceiling over-claim STILL blocks eFiling', async () => {
    const tx = await seedBankTx(fx, { date: '2026-07-16', amount: -115, description: 'bank ceiling test' });
    await inTx(fx, () => allocateTransaction(fx.companyId, tx, fx.expenseId, fx.userId, 'alloc', 'account', undefined, 'standard'));
    const [row] = (await sql`
      SELECT jl.journal_entry_id FROM bank_transactions bt JOIN gl_journal_lines jl ON jl.id = bt.matched_journal_line_id
      WHERE bt.id = ${tx}::UUID AND bt.company_id = ${fx.companyId}::UUID`) as Row[];
    const je = String(row!.journal_entry_id);
    // Ceiling for R115 at 15% is R15 — push the VAT-input line to R30 so the
    // claim exceeds what the bank line could possibly support.
    await sql`UPDATE gl_journal_lines SET debit = 30 WHERE company_id = ${fx.companyId}::UUID
      AND journal_entry_id = ${je}::UUID AND gl_account_id = ${fx.vatInputId}::UUID`;

    const r = await report();
    const flagged = r.unsupportedInputVat.find((l) => l.journalEntryId === je);
    expect(flagged).toMatchObject({ reason: 'amount_mismatch', supportKind: 'bank' });
    expect(evaluateEfilingGate(r).allowed).toBe(false);

    await sql`UPDATE bank_transactions SET matched_journal_line_id = NULL WHERE id = ${tx}::UUID`;
  });

  it('an expense-claim mismatch STILL blocks eFiling', async () => {
    const claim = await inTx(fx, () => createClaim({
      companyId: fx.companyId, employeeId, claimDate: '2026-07-18', createdBy: fx.userId,
      lines: [{
        lineDate: '2026-07-18', description: 'Taxi', merchant: 'Cab', amount: 115, vatAmount: 15, vatCode: 'standard',
        glAccountId: fx.expenseId, costCentreId: null, projectId: null, sourceDocumentId: null,
        kmTravelled: null, kmRate: null, mileageFrom: null, mileageTo: null,
      }],
    }));
    await inTx(fx, async () => {
      await submitClaim(claim.id, fx.companyId);
      await approveClaim(claim.id, fx.companyId, fx.userId);
      await postClaimToGl(claim.id, fx.companyId, { userId: fx.userId, reimbursementAccountId: reimburseId, vatInputAccountId: fx.vatInputId });
    });
    // Corrupt the claim's OWN record after posting so it disagrees with what
    // the (unchanged) GL journal actually claimed — an amount_mismatch.
    await sql`UPDATE expense_claim_lines SET vat_amount = 25 WHERE claim_id = ${claim.id}::UUID`;

    const r = await report();
    const flagged = r.unsupportedInputVat.find((l) => l.supportKind === 'expense_claim');
    expect(flagged).toMatchObject({ reason: 'amount_mismatch', supportKind: 'expense_claim' });
    expect(evaluateEfilingGate(r).allowed).toBe(false);
  });
});
