/**
 * ADVERSARIAL repros against the late input-VAT claim (s16(3)). Each `it`
 * asserts the CORRECT behaviour; a red test is a finding.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { createJournalEntry, postJournalEntry } from '@/modules/accounting/services/gl/journalEntryService';
import { VatPeriodLockedError } from '@/modules/accounting/services/gl/journalVatLockGuard';
import { approveSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { getVat201Report } from '@/modules/accounting/services/reports/vat201ReportService';
import { generateVAT201 } from '@/modules/accounting/services/reports/vat201Service';
import { getVatExceptions } from '@/modules/accounting/services/reports/vatExceptionsService';
import { assertAccountChangesKeepVatLocks } from '@/modules/accounting/services/gl/vatLockLineClassification';
import { mergeAccounts } from '@/modules/accounting/services/gl/accountMergeService';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { inTx } from './helpers/l1FifoFixture';
import {
  NEXT, P, draftBill, dropLateFixture, lockPeriod, seedLateFixture, vatFigures, type LateFixture,
} from './helpers/vatLateClaimFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;
type Row = Record<string, unknown>;
type L = { glAccountId: string; debit: number; credit: number; vatType?: string };
let fx: LateFixture;
const acc: Record<string, string> = {};

async function addAccount(code: string, name: string, type: string, subtype: string | null, denied = false) {
  return String(((await sql`
    INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype,
                             normal_balance, is_active, is_system_account, vat_input_denied)
    VALUES (${fx.companyId}::UUID, ${code}, ${name}, ${type}, ${subtype},
            ${type === 'expense' || type === 'asset' ? 'debit' : 'credit'}, true, false, ${denied})
    RETURNING id`) as Row[])[0]!.id);
}
/** Create + post, opted in (the human manual-journal route does exactly this). */
const post = (date: string, lines: L[], optIn = true) => inTx(fx, async () => {
  const je = await createJournalEntry(fx.companyId,
    { entryDate: date, description: 'BREAK', lines: lines.map((l) => ({ ...l, vatType: l.vatType as never })) },
    fx.userId, undefined, optIn ? { allowLateInputClaim: true } : undefined);
  return postJournalEntry(fx.companyId, je.id, fx.userId, optIn ? { allowLateInputClaim: true } : undefined);
});
const report = () => inTx(fx, () => getVat201Report(fx.companyId, NEXT.start, NEXT.end, { detail: 'summary' }));

describeIfDb('late input VAT claim: adversarial', () => {
  beforeAll(async () => {
    assertNotProductionDb('adversarial late-claim repros');
    fx = await seedLateFixture('VBK', DATABASE_URL!);
    acc.revenue = await addAccount('4000', `Sales ${fx.tag}`, 'revenue', 'default_revenue');
    acc.entertain = await addAccount('6910', `Staff functions ${fx.tag}`, 'expense', 'operating_expense', true);
    await lockPeriod(fx, P.start, P.end);
  }, 180000);

  afterAll(async () => { if (fx) await dropLateFixture(fx); }, 180000);

  it('B1: a BASELESS input-VAT journal (DR VAT Input / CR Bank) is flagged when on time but laundered when late', async () => {
    const r0 = await report();
    // Late: dated in the filed period, opted in.
    const late = await post('2026-06-10', [
      { glAccountId: fx.vatInputId, debit: 15, credit: 0, vatType: 'standard' },
      { glAccountId: fx.bankAccountId, debit: 0, credit: 15 },
    ]).then((r) => r, (e: unknown) => e);
    const r1 = await report();
    // On time: the very same journal dated in the claim period.
    await post('2026-07-10', [
      { glAccountId: fx.vatInputId, debit: 15, credit: 0, vatType: 'standard' },
      { glAccountId: fx.bankAccountId, debit: 0, credit: 15 },
    ], false);
    const r2 = await report();
    const onTimeFlagged = r2.rateCheck.entriesWithoutBaseTotal - r1.rateCheck.entriesWithoutBaseTotal;
    const lateFlagged = r1.rateCheck.entriesWithoutBaseTotal - r0.rateCheck.entriesWithoutBaseTotal;
    process.stdout.write(`B1 late=${late instanceof Error ? late.message : 'SPLIT'} lateInputDelta=${r1.totals.inputTax - r0.totals.inputTax} `
      + `lateFlagged=${lateFlagged} lateVarDelta=${r1.rateCheck.inputVariance - r0.rateCheck.inputVariance} `
      + `onTimeFlagged=${onTimeFlagged} onTimeVarDelta=${r2.rateCheck.inputVariance - r1.rateCheck.inputVariance}\n`);
    expect(onTimeFlagged).toBe(1);
    // Correct: the late claim is either refused or flagged exactly like the on-time one.
    if (!(late instanceof Error)) expect(lateFlagged).toBe(1);
  });

  it('B2: VAT on a vat_input_denied account with an UNTAGGED base line is refused non_supply', async () => {
    const x0 = await inTx(fx, () => getVatExceptions(fx.companyId, NEXT.start, NEXT.end));
    const out = await post('2026-06-11', [
      { glAccountId: acc.entertain!, debit: 100, credit: 0 },
      { glAccountId: fx.vatInputId, debit: 15, credit: 0, vatType: 'standard' },
      { glAccountId: fx.apId, debit: 0, credit: 115 },
    ]).then((r) => r, (e: unknown) => e);
    const x1 = await inTx(fx, () => getVatExceptions(fx.companyId, NEXT.start, NEXT.end));
    process.stdout.write(`B2 result=${out instanceof Error ? `${out.name}: ${out.message.slice(0, 80)}`
      : `SPLIT companion=${(out as { lateClaim?: { companionEntryNumber: string } }).lateClaim?.companionEntryNumber}`} `
      + `nextExceptionsDelta=${x1.totalExceptions - x0.totalExceptions}\n`);
    expect(out).toBeInstanceOf(VatPeriodLockedError);
    expect((out as { reason?: string }).reason).toBe('non_supply');
  });

  it('B3: a hand-made "companion" (DR VAT Input / CR clearing) in an open period claims VAT with no base and no flag', async () => {
    const r0 = await report();
    const out = await post('2026-07-12', [
      { glAccountId: fx.vatInputId, debit: 30, credit: 0, vatType: 'standard' },
      { glAccountId: fx.clearingId, debit: 0, credit: 30 },
    ], false).then((r) => r, (e: unknown) => e);
    const r1 = await report();
    process.stdout.write(`B3 posted=${!(out instanceof Error)} inputDelta=${r1.totals.inputTax - r0.totals.inputTax} `
      + `flaggedDelta=${r1.rateCheck.entriesWithoutBaseTotal - r0.rateCheck.entriesWithoutBaseTotal} `
      + `varDelta=${r1.rateCheck.inputVariance - r0.rateCheck.inputVariance} ties=${r1.rateCheck.ties}\n`);
    // Correct: the clearing account is not postable by hand, or the claim is flagged.
    if (!(out instanceof Error)) {
      expect(r1.rateCheck.entriesWithoutBaseTotal - r0.rateCheck.entriesWithoutBaseTotal).toBe(1);
    }
  });

  it('B4: a sale journal with one cent on the clearing account drops out of box 1 (standard-rated supplies)', async () => {
    const r0 = await report();
    const out = await post('2026-07-13', [
      { glAccountId: fx.bankAccountId, debit: 1149.99, credit: 0 },
      { glAccountId: fx.clearingId, debit: 0.01, credit: 0 },
      { glAccountId: acc.revenue!, debit: 0, credit: 1000, vatType: 'standard' },
      { glAccountId: String(((await sql`SELECT id FROM gl_accounts WHERE company_id = ${fx.companyId}::UUID
        AND account_subtype = 'vat_output'`) as Row[])[0]!.id), debit: 0, credit: 150, vatType: 'standard' },
    ], false).then((r) => r, (e: unknown) => e);
    const r1 = await report();
    const out0 = r0.boxes.find((b) => b.direction === 'output' && b.vatType === 'standard');
    const out1 = r1.boxes.find((b) => b.direction === 'output' && b.vatType === 'standard');
    process.stdout.write(`B4 posted=${!(out instanceof Error)} outputTaxDelta=${r1.totals.outputTax - r0.totals.outputTax} `
      + `box1BaseDelta=${(r1.totals.standardRatedSupplies) - (r0.totals.standardRatedSupplies)} `
      + `box1Variance=${out1?.variance} lateClaimTaxOnOutput=${out1?.lateClaimTax} (before ${out0?.lateClaimTax})\n`);
    if (!(out instanceof Error)) {
      expect(r1.totals.standardRatedSupplies - r0.totals.standardRatedSupplies).toBeCloseTo(1000, 2);
      expect(out1?.lateClaimTax ?? 0).toBe(0);
    }
  });

  it('B5: a draft bill in the filed period moves OUT of that period\'s generateVAT201 when approved late', async () => {
    const b = await draftBill(fx, '2026-06-20', { vatClassification: 'services' });
    // The filed figures as filing would have read them while the bill was a draft.
    const before = await inTx(fx, () => generateVAT201(fx.companyId, P.start, P.end));
    await inTx(fx, () => approveSupplierInvoice(fx.companyId, b.id, fx.userId, { allowLateInputClaim: true }));
    const after = await inTx(fx, () => generateVAT201(fx.companyId, P.start, P.end));
    process.stdout.write(`B5 P.field8 before=${before.field8_services} after=${after.field8_services} `
      + `P.field10 before=${before.field10_totalInputVAT} after=${after.field10_totalInputVAT} `
      + `inputInvoices before=${before.inputInvoices.length} after=${after.inputInvoices.length}\n`);
    expect(after.field8_services).toBe(before.field8_services);
    expect(after.field10_totalInputVAT).toBe(before.field10_totalInputVAT);
  });

  it('B6: merging the clearing account into VAT Input with a late original in the filed period is refused', async () => {
    const pBefore = await vatFigures(fx, P.start, P.end);
    const res = await inTx(fx, () => mergeAccounts(fx.companyId, fx.clearingId, fx.vatInputId, fx.userId))
      .then((r) => r, (e: unknown) => e);
    const pAfter = await vatFigures(fx, P.start, P.end);
    process.stdout.write(`B6 merge=${res instanceof Error ? `${res.name}: ${res.message.slice(0, 100)}` : 'MERGED'} `
      + `P.input before=${pBefore.inputTax} after=${pAfter.inputTax}\n`);
    expect({ ...pAfter, postedThrough: '' }).toEqual({ ...pBefore, postedThrough: '' });
    expect(res).toBeInstanceOf(Error);
  });
  it('B7: re-pointing Default Accounts "purchase VAT input" at the clearing account is refused (filed original would join P)', async () => {
    const err = await inTx(fx, () => assertAccountChangesKeepVatLocks(fx.companyId, [{
      accountId: fx.clearingId, accountCode: '1145',
      from: { accountType: 'asset', accountSubtype: 'vat_input_late_claim' },
      to: { accountType: 'asset', accountSubtype: 'vat_input' },
    }])).then(() => null, (e: unknown) => e);
    process.stdout.write(`B7 ${err instanceof Error ? err.message.slice(0, 90) : 'ALLOWED'}\n`);
    expect(err).toBeInstanceOf(VatPeriodLockedError);
  });
});
