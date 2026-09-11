// src/modules/accounting/services/gl/postingPeriodGuard.ts

/** Why a journal may not be posted on its accounting date: the period is not open, or the company is locked down. */
export type PostingPeriodBlock = { kind: 'period'; status: string } | { kind: 'lockdown'; lockdownDate: string | null };

/**
 * The period and lockdown rule every journal post obeys — the ONE copy. assertPostingGuards throws its own error
 * classes from it; a bank transfer checks it before writing its journal (a refusal inside the journal control would
 * answer 500), so the two can never disagree about what is postable.
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
