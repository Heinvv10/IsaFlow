// Every error class thrown under allocateTransaction is either passed through to the person (a typed refusal), labelled, held
// ("busy"), or named here as a fault. A class added to the allocation path without a decision fails this (WP6 R2-1).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PASS_THROUGH, BUSY, LABELLED, NOT_REFUSALS, refusalReason, GENERIC_REFUSAL } from '@/modules/accounting/services/bank/bankBulkAcceptRefusals';
import { ClosedFiscalPeriodError, InactiveAccountError } from '@/modules/accounting/services/gl/journalEntryPostingGuards';
import { FiscalPeriodNotGeneratedError } from '@/modules/accounting/services/gl/fiscalPeriodAutoCreate';

const S = 'src/modules/accounting/services';
/**
 * The files whose throws can reach a bulk-accept line: allocateTransaction, its arms and plan, the journal writer and its
 * guards. (bankReallocationGuards is not here: it runs only for `opts.reallocation`, which a bulk accept never passes.)
 */
const ALLOCATION_PATH = [
  'bank/bankAllocationService.ts', 'bank/bankAllocationArms.ts', 'bank/bankAllocationPlan.ts', 'bank/bankAllocationDocuments.ts',
  'bank/bankAllocationDimensions.ts', 'bank/bankFeedStateGuard.ts', 'bank/reconciledCash.ts', 'bank/bankLineJournalGate.ts',
  'bank/bankLineImporterGate.ts', 'bank/contactControlGuard.ts', 'bank/bankTxLock.ts', 'bank/reconciliationSessionLock.ts',
  'gl/journalEntryCrudService.ts', 'gl/journalCostCentreValidation.ts', 'core/companySettingsService.ts', 'gl/journalEntryPostService.ts', 'gl/journalEntryPostingGuards.ts',
  'gl/journalVatLockGuard.ts', 'gl/vatLateClaimPlan.ts', 'gl/vatLateClaimSplit.ts', 'gl/approvalGate.ts', 'gl/manualJournalApproval.ts',
  'gl/dimensions/costCentrePick.ts', 'gl/dimensions/dimensionPolicy.ts', 'gl/dimensions/dimensionDefaultsService.ts',
  'core/rowLockBudget.ts', 'gl/fiscalPeriodAutoCreate.ts',
];
const decided = new Set([...PASS_THROUGH, ...BUSY, ...LABELLED].map((C) => C.name).concat(NOT_REFUSALS));
// A subclass is covered through its parent: these are named here only so the scan below can see them.
const SUBCLASSES = ['FiscalPeriodNotGeneratedError', 'VatLateClaimRefusal', 'PreWriteDimensionRefusal', 'CostCentrePickRefusal', 'SageReconciledLineError'];

describe('the bulk accept refusal list covers the allocation path', () => {
  it('every `throw new X` (X not Error) under the allocation path is decided', () => {
    const thrown = new Set<string>();
    for (const file of ALLOCATION_PATH) {
      const text = readFileSync(resolve(process.cwd(), S, file), 'utf8');
      for (const m of text.matchAll(/throw new ([A-Z][A-Za-z]+)\(/g)) if (m[1] !== 'Error') thrown.add(m[1]!);
    }
    const undecided = [...thrown].filter((n) => !decided.has(n) && !SUBCLASSES.includes(n)).sort();
    expect(undecided).toEqual([]);
  });

  it('a typed refusal reads as its own text; an untyped error is the generic one', () => {
    expect(refusalReason(new InactiveAccountError([{ code: '6000', name: 'Fuel' }]))).toMatch(/Fuel|6000/);
    expect(refusalReason(new ClosedFiscalPeriodError('closed'))).not.toBe(GENERIC_REFUSAL);
    expect(refusalReason(new FiscalPeriodNotGeneratedError('2026-08-31', null, false))).not.toBe(GENERIC_REFUSAL);
    expect(refusalReason(new TypeError('boom'))).toBe(GENERIC_REFUSAL);
  });
});
