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
  const noBankGl = parts.autoPostRulesSkippedNoBankGl ?? 0;
  const raced = parts.autoPostSkippedRaced ?? 0;
  const locked = parts.autoPostSkippedLocked ?? 0;
  const truncated = parts.autoPostTruncatedRules ?? 0;
  const bits: string[] = [`${applied} categorised`];
  if (skippedClosed > 0) bits.push(`${skippedClosed} skipped (closed period)`);
  if (skippedNoPeriod > 0) bits.push(`${skippedNoPeriod} skipped (no fiscal period)`);
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
  const hasCollateral = skippedClosed > 0 || skippedNoPeriod > 0 || noBankGl > 0
    || raced > 0 || locked > 0 || truncated > 0;
  const kind = noBankGl > 0 || (applied === 0 && hasCollateral) ? 'warn' : 'success';
  return { kind, message };
}

/** Emit the toast using the project-standard notify util. */
export function emitApplyToast(headline: string, parts: ApplyResultParts): void {
  const t = buildApplyToast(parts);
  if (t.kind === 'success') notify.success(headline, t.message);
  else notify.warning(headline, t.message);
}
