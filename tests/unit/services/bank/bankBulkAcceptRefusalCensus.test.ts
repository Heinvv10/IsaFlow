// Every error class thrown under allocateTransaction is either passed through to the person (a typed refusal), labelled, held
// ("busy"), or named here as a fault. A class added to the allocation path without a decision fails this (WP6 R2-1).
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PASS_THROUGH, BUSY, LABELLED, LEDGER_LOCKS, NOT_REFUSALS, refusalReason, GENERIC_REFUSAL } from '@/modules/accounting/services/bank/bankBulkAcceptRefusals';
import { ClosedFiscalPeriodError, InactiveAccountError } from '@/modules/accounting/services/gl/journalEntryPostingGuards';
import { JournalDateRefusedError } from '@/modules/accounting/utils/journalDateWindow';
import { MissingSystemAccountError } from '@/modules/accounting/services/gl/systemAccountKeys';
import { FiscalPeriodNotGeneratedError } from '@/modules/accounting/services/gl/fiscalPeriodAutoCreate';

const S = 'src/modules/accounting/services';
/**
 * EVERY .ts file under bank/ and gl/ (recursively), plus the few files elsewhere the allocation path calls: not a hand list,
 * so a new file under those directories is scanned. Broader than the path on purpose (a class thrown only by an unrelated
 * service must still be named below). LIMIT: only a literal `throw new X(` is seen; a throw via a variable (`throw err`,
 * `throw makeError()`) or an inherited constructor call is not detected.
 * (bankReallocationGuards throws only for `opts.reallocation`, which a bulk accept never passes: named in NOT_ON_PATH.)
 */
const EXTRA_FILES = ['core/companySettingsService.ts', 'core/rowLockBudget.ts', '../utils/journalDateWindow.ts'];
const listTs = (dir: string): string[] => readdirSync(resolve(process.cwd(), S, dir), { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? listTs(`${dir}/${e.name}`) : e.name.endsWith('.ts') ? [`${dir}/${e.name}`] : []));
const ALLOCATION_PATH = [...listTs('bank'), ...listTs('gl'), ...EXTRA_FILES];
/**
 * Classes thrown by files under bank/ and gl/ that the allocation path does not reach (approvals admin, imports, merges, the
 * reconciliation and MCP-side services, ...). Each is DECIDED as "not a line's refusal": if one of them starts being thrown
 * under allocateTransaction it must move into PASS_THROUGH / BUSY / LABELLED. A new class anywhere in those directories fails
 * the census until it is placed in one list or the other.
 */
const NOT_ON_PATH = [
  'AccountMergeError', 'ApprovalActiveFlagInvalidError', 'ApprovalAmountInvalidError', 'ApprovalDecisionError', 'ApprovalDocumentChangedError',
  'ApprovalDocumentNotDraftError', 'ApprovalDocumentNotFoundError', 'ApprovalDocumentTypeInvalidError', 'ApprovalEnforcementAuthorityError',
  'ApprovalEnforcementUnavailableError', 'ApprovalExpectedDigestRequiredError', 'ApprovalFieldInvalidError', 'ApprovalImportAuthorityError',
  'ApprovalNameInvalidError', 'ApprovalNotRequiredError', 'ApprovalOperatorInvalidError', 'ApprovalRequestLockTimeoutError',
  'ApprovalRequestNotFoundError', 'ApprovalRoleInvalidError', 'ApprovalRuleAuthorityError', 'ApprovalRuleLegacyTypeError',
  'ApprovalRuleNotFoundError', 'AutoPostSettingsInvalidError', 'BankAccountGuardRefusal', 'BankAccountRefusedError', 'BankImportLockTimeoutError',
  'BankIngestionRefusal', 'BankLineChangedError', 'BankRequestRefusal', 'BankMatchTargetError', 'BankMatchUnavailableError', 'BankReallocationRefusal',
  'BankTransactionAllocatedError', 'BankTransferRefusedError', 'BulkAcceptRefusal', 'ChartRefusal', 'CloseRunNotFoundError', 'ClosingChainTooLong',
  'DefaultAccountsRefusal', 'DocumentLineAccountRefusal',
  'FinancialYearStartLockedError', 'FinancialYearStartScopeError', 'FiscalPeriodsInUseError', 'FiscalYearLabelUnknownError',
  'GlAccountLockTimeoutError', 'HandCorrectionRefusedError', 'ImportValidationError', 'InvalidCursorError',
  'InvalidFinancialYearStartError', 'JournalDocumentLinkRefusal', 'JournalReversalLockTimeoutError',
  'LedgerAccountNotFoundError', 'LineRefused', 'MissingAssetAccountError', 'OpeningBalanceValidationError',
  'ParentAccountError', 'PeriodCloseBlockedError', 'PeriodNotCloseableError', 'PossibleDuplicateTransferError', 'ProposalDecisionError',
  'ReclassLineLockTimeoutError', 'ReclassifyError', 'ReconciliationNotBalancedError', 'ReconciliationNotCancellableError',
  'ReconciliationNotReopenableError', 'ReconciliationReviewRequiredError', 'RecurringJournalLockTimeoutError', 'RecurringJournalNotFoundError',
  'RecurringJournalRequestError', 'ReversalBeforeOriginalError', 'ReversalPeriodError', 'RunAlreadyUndoneError', 'ShareHasLiveUndosError',
  'StartMonthAssumedError', 'StatementNotImportableError', 'StatementReadError', 'SupplierBankVerificationError', 'SystemRoleInvariantError',
  'SystemRoleLockTimeoutError', 'TooManyRecloses', 'TransferLinkUndoError', 'YearCloseBlockedError', 'YearEndChangeRefusedError',
  'YearEndPeriodsNotClosedError'
];
const decided = new Set([...PASS_THROUGH, ...BUSY, ...LABELLED, ...LEDGER_LOCKS].map((C) => C.name).concat(NOT_REFUSALS, NOT_ON_PATH));
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
    expect(refusalReason(new JournalDateRefusedError('the date is outside the ledger window'))).toMatch(/outside the ledger window/);
    const missing = new MissingSystemAccountError('vat_input', '11111111-2222-4333-8444-555555555555');
    const reason = refusalReason(missing);
    expect(reason).toContain("'vat_input' system account role is not configured");
    expect(reason).toContain(missing.remedy);
    expect(reason).not.toContain('11111111-2222-4333-8444-555555555555'); // no company id in the line's reason
    expect(refusalReason(new TypeError('boom'))).toBe(GENERIC_REFUSAL);
  });
});
