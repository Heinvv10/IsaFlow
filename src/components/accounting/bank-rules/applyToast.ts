/**
 * Helpers for the post-apply toast on the bank-rules page. Extracted so
 * useBankRules.ts stays under the 300-line cap. Uses the project-wide
 * `notify` utility (dark-theme styled, Lucide icons) for consistency with
 * the rest of the app.
 */
import { notify } from '@/utils/toast';

export interface ApplyResultParts {
  applied?: number;
  skipped?: number;
  autoPostRulesSkippedNoBankGl?: number;
  autoPostSkippedClosedPeriod?: number;
  autoPostSkippedNoPeriod?: number;
  autoPostSkippedVatLocked?: number;
  autoPostSkippedHeaderAccount?: number;
  autoPostSkippedRefundCeiling?: number;
  autoPostSkippedControlAccount?: number;
  autoPostSkippedRaced?: number;
  autoPostSkippedLocked?: number;
  autoPostTruncatedRules?: number;
}

export interface ApplyToast {
  kind: 'success' | 'warn';
  message: string;
}

/**
 * Build the toast text for a "Run rules" / "auto-apply on create" outcome.
 * Centralised so create- and apply-paths emit consistent wording.
 *
 * Tone is `warn` when something silently dropped (auto-post rules skipped
 * because the bank account isn't GL-linked, or zero applied with non-zero
 * skips — races included) — surfacing only `applied` would mislead the user.
 * Otherwise `success` is used.
 */
export function buildApplyToast(parts: ApplyResultParts): ApplyToast {
  const applied = parts.applied ?? 0;
  const skippedClosed = parts.autoPostSkippedClosedPeriod ?? 0;
  const skippedNoPeriod = parts.autoPostSkippedNoPeriod ?? 0;
  const skippedVatLocked = parts.autoPostSkippedVatLocked ?? 0;
  const skippedHeader = parts.autoPostSkippedHeaderAccount ?? 0;
  const skippedRefund = parts.autoPostSkippedRefundCeiling ?? 0;
  const skippedControl = parts.autoPostSkippedControlAccount ?? 0;
  const noBankGl = parts.autoPostRulesSkippedNoBankGl ?? 0;
  const raced = parts.autoPostSkippedRaced ?? 0;
  const locked = parts.autoPostSkippedLocked ?? 0;
  const truncated = parts.autoPostTruncatedRules ?? 0;
  const bits: string[] = [`${applied} categorised`];
  if (skippedClosed > 0) bits.push(`${skippedClosed} skipped (closed period)`);
  if (skippedNoPeriod > 0) bits.push(`${skippedNoPeriod} skipped (no fiscal period)`);
  if (skippedVatLocked > 0) bits.push(`${skippedVatLocked} skipped (locked VAT period)`);
  if (skippedHeader > 0) bits.push(`${skippedHeader} skipped (the rule's account is a header with sub-accounts — point the rule at one of them)`);
  if (skippedControl > 0) bits.push(`${skippedControl} skipped (the rule's account is AP/AR control — set the rule's supplier or customer instead)`);
  if (skippedRefund > 0) bits.push(`${skippedRefund} skipped (a refund larger than the contact's credit — allocate it by hand)`);
  if (noBankGl > 0) bits.push(`${noBankGl} auto-post rule${noBankGl > 1 ? 's' : ''} skipped (bank not GL-linked)`);
  if (raced > 0) bits.push(`${raced} skipped — allocated by another request`);
  if (locked > 0) bits.push(`${locked} skipped — locked by another request, retry`);
  if (truncated > 0) bits.push(`${truncated} rule${truncated > 1 ? 's' : ''} hit the 500-transaction cap — run again`);
  const message = bits.join(' · ');
  // Warn when something silently dropped: bank-not-GL-linked is always silent;
  // a no-op apply with any collateral skip (closed, no-period, no-bank-gl,
  // raced) is misleading without a louder cue. `no_period` is treated like
  // `closed_period` here — both are actionable but non-blocking, as is a race,
  // which simply means someone else got to the transaction first.
  const hasCollateral = skippedClosed > 0 || skippedNoPeriod > 0 || skippedVatLocked > 0 || skippedHeader > 0 || skippedRefund > 0 || skippedControl > 0
    || noBankGl > 0
    || raced > 0 || locked > 0 || truncated > 0;
  // A header or control-account skip recurs on every run until the rule is repointed, so it is never a quiet success.
  const kind = noBankGl > 0 || skippedHeader > 0 || skippedControl > 0 || (applied === 0 && hasCollateral) ? 'warn' : 'success';
  return { kind, message };
}

/** Emit the toast using the project-standard notify util. */
export function emitApplyToast(headline: string, parts: ApplyResultParts): void {
  const t = buildApplyToast(parts);
  if (t.kind === 'success') notify.success(headline, t.message);
  else notify.warning(headline, t.message);
}

/**
 * A rule save the server HELD for approval (forensic-controls step 2: the
 * `bank_rule` switch) answers { status: 'pending_approval', changeId } —
 * nothing changed yet, so it must never read as "saved".
 */
export const isHeldForApproval = (data: unknown): boolean =>
  (data as { status?: unknown } | null)?.status === 'pending_approval';

export function notifyHeld(what: string): void {
  notify.warning('Held for approval — another member must approve it',
    `${what} takes effect once another member approves it under Pending changes on the Bank rules page.`);
}

/**
 * The toast for a rule created (not held) by POST /api/accounting/bank-rules,
 * which may have run the new rule at once. Returns the run's counts for the
 * page's banner when it categorised anything, else null.
 */
export function reportCreated(headline: string, data: Record<string, unknown> | undefined)
  : (ApplyResultParts & { applied: number; skipped: number }) | null {
  const n = (k: keyof ApplyResultParts) => Number(data?.[k] ?? 0);
  const parts = {
    applied: n('applied'), autoPostSkippedClosedPeriod: n('autoPostSkippedClosedPeriod'),
    autoPostSkippedNoPeriod: n('autoPostSkippedNoPeriod'), autoPostSkippedVatLocked: n('autoPostSkippedVatLocked'),
    autoPostRulesSkippedNoBankGl: n('autoPostRulesSkippedNoBankGl'), autoPostSkippedRaced: n('autoPostSkippedRaced'),
    autoPostSkippedLocked: n('autoPostSkippedLocked'), autoPostTruncatedRules: n('autoPostTruncatedRules'),
    autoPostSkippedHeaderAccount: n('autoPostSkippedHeaderAccount'),
    autoPostSkippedRefundCeiling: n('autoPostSkippedRefundCeiling'),
    autoPostSkippedControlAccount: n('autoPostSkippedControlAccount'),
  };
  const anythingToReport = Object.values(parts).reduce((sum, v) => sum + v, 0);
  if (anythingToReport > 0) emitApplyToast(headline, parts);
  else notify.success(headline);
  return parts.applied > 0 ? { ...parts, skipped: 0 } : null;
}
