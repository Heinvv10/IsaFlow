// src/modules/accounting/services/gl/postingPeriodGuard.ts

/** Why a journal may not be posted on its accounting date: the period is not open, or the company is locked down. */
export type PostingPeriodBlock = { kind: 'period'; status: string } | { kind: 'lockdown'; lockdownDate: string | null };

/**
 * The period and lockdown rule for a journal post, shared by exactly two callers: assertPostingGuards (which throws
 * its own error classes from it) and the bank transfer, which checks it before writing its journal (a refusal inside
 * the journal control would answer 500). Those two cannot disagree. It is NOT the only copy of the lockdown rule:
 * other paths still inline their own (historicalImportCurrentFacts, controlledYearEnd, controlledAssetDepreciation,
 * depreciationRunPreview, the cashApplication* services, among others), and payrollCompensationWindows treats
 * lockdown enabled with no date as NOT locked. Consolidating them is separate work.
 */
export function postingPeriodBlock(
  periodStatus: unknown,
  company: { lockdown_enabled?: unknown; lockdown_date?: unknown },
  accountingDate: string,
  authorizedClosedPeriod = false,
): PostingPeriodBlock | null {
  if (periodStatus !== 'open' && !(authorizedClosedPeriod && periodStatus === 'closed')) {
    return { kind: 'period', status: String(periodStatus) };
  }
  if (company.lockdown_enabled === true && (!company.lockdown_date || accountingDate <= String(company.lockdown_date))) {
    return { kind: 'lockdown', lockdownDate: company.lockdown_date ? String(company.lockdown_date) : null };
  }
  return null;
}
