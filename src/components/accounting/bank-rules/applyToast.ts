/**
 * Helpers for the post-apply toast on the bank-rules page. Extracted so
 * useBankRules.ts stays under the 300-line cap.
 */
import toast from 'react-hot-toast';

export interface ApplyResultParts {
  applied?: number;
  skipped?: number;
  autoPostRulesSkippedNoBankGl?: number;
  autoPostSkippedClosedPeriod?: number;
}

/**
 * Build the toast text for a "Run rules" / "auto-apply on create" outcome.
 * Centralised so create- and apply-paths emit consistent wording.
 */
export function buildApplyToast(parts: ApplyResultParts): { kind: 'success' | 'warn'; message: string } {
  const applied = parts.applied ?? 0;
  const skippedClosed = parts.autoPostSkippedClosedPeriod ?? 0;
  const noBankGl = parts.autoPostRulesSkippedNoBankGl ?? 0;
  const bits: string[] = [`${applied} categorised`];
  if (skippedClosed > 0) bits.push(`${skippedClosed} skipped (closed period)`);
  if (noBankGl > 0) bits.push(`${noBankGl} auto-post rule${noBankGl > 1 ? 's' : ''} skipped (bank not GL-linked)`);
  const message = bits.join(' · ');
  // Warn tone when something silently dropped — applied count alone is misleading.
  const kind = noBankGl > 0 || (applied === 0 && (skippedClosed > 0 || noBankGl > 0)) ? 'warn' : 'success';
  return { kind, message };
}

/** Emit the toast using the right tone. */
export function emitApplyToast(headline: string, parts: ApplyResultParts): void {
  const t = buildApplyToast(parts);
  const message = `${headline} — ${t.message}`;
  if (t.kind === 'success') toast.success(message);
  else toast(message, { icon: '⚠️' });
}
