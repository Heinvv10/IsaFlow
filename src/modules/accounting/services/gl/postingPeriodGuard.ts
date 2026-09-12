// src/modules/accounting/services/gl/postingPeriodGuard.ts

/** Why a journal may not be posted on its accounting date: the period is not open, or the company is locked down. */
export type PostingPeriodBlock = { kind: 'period'; status: string } | { kind: 'lockdown'; lockdownDate: string | null };
export type LockdownBlock = Extract<PostingPeriodBlock, { kind: 'lockdown' }>;

/**
 * Defined here (not journalEntryPostingService.ts, which re-exports it for callers) so journalControlService.ts —
 * which needs it for the direct-posting precheck below assertPostingGuards mirrors — can import it without a cycle
 * (journalEntryPostingService.ts already imports runJournalControl FROM journalControlService.ts).
 */
export class ClosedFiscalPeriodError extends Error {
  readonly periodStatus: string;
  constructor(periodStatus: string) { super(`Cannot post to ${periodStatus} fiscal period`); this.name = 'ClosedFiscalPeriodError'; this.periodStatus = periodStatus; }
}
/** assertPostingGuards' own lockdown throw has no dedicated class; this constant is the ONE copy of its text. */
export const LOCKDOWN_REFUSAL_MESSAGE = 'Journal date is within company lockdown';
/** assertPostingGuards' filed-VAT-period throw likewise has no class; this constant is the ONE copy of its text. */
export const VAT_PERIOD_REFUSAL_MESSAGE = 'Journal date is within a filed VAT period';
/** True for any refusal assertPostingGuards (or a precheck that mirrors it) throws: period, lockdown, filed VAT period. */
export function isPostingRefusal(error: unknown): boolean {
  return error instanceof ClosedFiscalPeriodError
    || (error instanceof Error && (error.message === LOCKDOWN_REFUSAL_MESSAGE || error.message === VAT_PERIOD_REFUSAL_MESSAGE));
}
/**
 * Throws the refusal a block (and a filed VAT period) stands for, with the exact classes and texts assertPostingGuards
 * uses — so a precheck that runs BEFORE a controlled write and the guard INSIDE it can never answer differently.
 * `vatLocked` is the caller's `journalAffectsVatReturn(...) && locks.length > 0`; a journal outside the VAT201
 * population is not refused by a filed period.
 */
export function throwPostingBlock(block: PostingPeriodBlock | null, vatLocked: boolean): void {
  if (block?.kind === 'period') throw new ClosedFiscalPeriodError(block.status);
  if (block?.kind === 'lockdown') throw new Error(LOCKDOWN_REFUSAL_MESSAGE);
  if (vatLocked) throw new Error(VAT_PERIOD_REFUSAL_MESSAGE);
}

/**
 * The company lockdown rule — the ONE copy. A company with lockdown enabled refuses every accounting date on or
 * before `lockdown_date`; enabled with NO date refuses every date (the settings writer, validateLockdownTarget,
 * rejects that state, but rows saved before it existed can still hold it). `accountingDate` and `lockdown_date` are
 * both ISO 'YYYY-MM-DD' strings (select `lockdown_date::text`), so the text compare is the date compare and no time
 * zone enters. Each caller throws its own error from the block; none may restate the predicate.
 */
export function lockdownBlock(
  company: { lockdown_enabled?: unknown; lockdown_date?: unknown },
  accountingDate: string,
): LockdownBlock | null {
  if (company.lockdown_enabled === true && (!company.lockdown_date || accountingDate <= String(company.lockdown_date))) {
    return { kind: 'lockdown', lockdownDate: company.lockdown_date ? String(company.lockdown_date) : null };
  }
  return null;
}

/**
 * The period-and-lockdown rule for a journal post: assertPostingGuards throws its own error classes from it, and the
 * bank transfer checks it before writing its journal (a refusal inside the journal control would answer 500).
 * Writers whose period rule differs (historical import accepts a closed period; cash application also refuses a
 * filed VAT period) call lockdownBlock directly and keep their own period check.
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
  return lockdownBlock(company, accountingDate);
}
