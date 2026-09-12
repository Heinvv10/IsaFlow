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
  autoPostSkippedApprovalRequired?: number;
  autoPostSkippedBeneficiaryUnverified?: number;
  autoPostSkippedLockdown?: number;
  autoPostSkippedVatPeriodFiled?: number;
  autoPostSkippedPermissionDenied?: number;
  autoPostSkippedRefused?: number;
  autoPostRefusalReasons?: string[];
  autoPostDeferred?: number;
}

export interface ApplyToast {
  kind: 'success' | 'warn';
  message: string;
}

/**
 * Every per-line skip the sweep reports, in the order the toast lists them.
 * Each is a count of lines the rule matched but did NOT post; every one is a
 * reason the user would otherwise read as "rules aren't working".
 */
const SKIP_COUNTERS: ReadonlyArray<{ key: keyof ApplyResultParts; text: (n: number, parts: ApplyResultParts) => string }> = [
  { key: 'autoPostSkippedClosedPeriod', text: (n) => `${n} skipped (closed period)` },
  { key: 'autoPostSkippedNoPeriod', text: (n) => `${n} skipped (no fiscal period)` },
  { key: 'autoPostRulesSkippedNoBankGl', text: (n) => `${n} auto-post rule${n > 1 ? 's' : ''} skipped (bank not GL-linked)` },
  { key: 'autoPostSkippedRaced', text: (n) => `${n} skipped — allocated by another request` },
  { key: 'autoPostSkippedLocked', text: (n) => `${n} skipped — locked by another request, retry` },
  { key: 'autoPostTruncatedRules', text: (n) => `${n} rule${n > 1 ? 's' : ''} hit the 500-transaction cap — run again` },
  { key: 'autoPostSkippedApprovalRequired', text: (n) => `${n} left for approval — the company's policy requires one at this amount` },
  { key: 'autoPostSkippedBeneficiaryUnverified', text: (n) => `${n} skipped — supplier bank details not verified` },
  { key: 'autoPostSkippedLockdown', text: (n) => `${n} skipped (company lockdown)` },
  { key: 'autoPostSkippedVatPeriodFiled', text: (n) => `${n} skipped (VAT period already filed)` },
  { key: 'autoPostSkippedPermissionDenied', text: (n) => `${n} skipped — you lack permission to post` },
  { key: 'autoPostSkippedRefused', text: (n, parts) => `${n} refused${parts.autoPostRefusalReasons?.length ? `: ${parts.autoPostRefusalReasons.join('; ')}` : ''}` },
  { key: 'autoPostDeferred', text: (n) => `${n} deferred — run rules to continue` },
];

/**
 * Build the toast text for a "Run rules" / "auto-apply on create" outcome.
 * Centralised so create- and apply-paths emit consistent wording.
 *
 * Tone is `warn` when something silently dropped: bank-not-GL-linked is always
 * silent, and a no-op apply with ANY per-line skip is misleading without a
 * louder cue. Otherwise `success` — with applied > 0 a skip is informational.
 */
export function buildApplyToast(parts: ApplyResultParts): ApplyToast {
  const applied = parts.applied ?? 0;
  const count = (key: keyof ApplyResultParts) => Number(parts[key] ?? 0);
  const bits: string[] = [`${applied} categorised`];
  for (const counter of SKIP_COUNTERS) {
    const n = count(counter.key);
    if (n > 0) bits.push(counter.text(n, parts));
  }
  const hasCollateral = SKIP_COUNTERS.some(counter => count(counter.key) > 0);
  const kind = count('autoPostRulesSkippedNoBankGl') > 0 || (applied === 0 && hasCollateral) ? 'warn' : 'success';
  return { kind, message: bits.join(' · ') };
}

/** Emit the toast using the project-standard notify util. */
export function emitApplyToast(headline: string, parts: ApplyResultParts): void {
  const t = buildApplyToast(parts);
  if (t.kind === 'success') notify.success(headline, t.message);
  else notify.warning(headline, t.message);
}

/**
 * Combine two sweep results. Counters add up, reasons union, `skipped` (the
 * account's still-unsuggested lines) is the latest. `autoPostDeferred` depends
 * on what is being combined: successive ROUNDS over one account describe what
 * is left, so the last round's figure stands (`deferred: 'last'`); the FILES
 * of one bulk import each defer their own lines and commit two at a time in no
 * fixed order, so their figures are summed (`deferred: 'sum'`).
 */
export function mergeApplyResults(total: ApplyResultParts, next: ApplyResultParts,
  options: { deferred: 'last' | 'sum' } = { deferred: 'last' }): ApplyResultParts {
  const merged: ApplyResultParts = { ...total };
  for (const key of Object.keys(next) as (keyof ApplyResultParts)[]) {
    const value = next[key];
    if (key === 'autoPostRefusalReasons') merged.autoPostRefusalReasons = [...new Set([...(total.autoPostRefusalReasons ?? []), ...(next.autoPostRefusalReasons ?? [])])];
    else if (key === 'skipped' || (key === 'autoPostDeferred' && options.deferred === 'last')) (merged as Record<string, unknown>)[key] = value;
    else if (typeof value === 'number') (merged as Record<string, unknown>)[key] = Number(total[key] ?? 0) + value;
  }
  return merged;
}

/** True when the sweep has anything beyond "0 categorised" to say. */
export function hasApplyOutcome(parts: ApplyResultParts): boolean {
  return (parts.applied ?? 0) > 0 || SKIP_COUNTERS.some(counter => Number(parts[counter.key] ?? 0) > 0);
}
