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
 * skips) — surfacing only `applied` would mislead the user. Otherwise
 * `success` is used.
 */
export function buildApplyToast(parts: ApplyResultParts): ApplyToast {
  const applied = parts.applied ?? 0;
  const skippedClosed = parts.autoPostSkippedClosedPeriod ?? 0;
  const noBankGl = parts.autoPostRulesSkippedNoBankGl ?? 0;
  const bits: string[] = [`${applied} categorised`];
  if (skippedClosed > 0) bits.push(`${skippedClosed} skipped (closed period)`);
  if (noBankGl > 0) bits.push(`${noBankGl} auto-post rule${noBankGl > 1 ? 's' : ''} skipped (bank not GL-linked)`);
  const message = bits.join(' · ');
  const kind = noBankGl > 0 || (applied === 0 && (skippedClosed > 0 || noBankGl > 0)) ? 'warn' : 'success';
  return { kind, message };
}

/** Emit the toast using the project-standard notify util. */
export function emitApplyToast(headline: string, parts: ApplyResultParts): void {
  const t = buildApplyToast(parts);
  if (t.kind === 'success') notify.success(headline, t.message);
  else notify.warning(headline, t.message);
}
