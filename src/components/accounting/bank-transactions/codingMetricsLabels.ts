/**
 * Plain-English labels for the learning-loop coding metrics (codingMetrics.ts). Pure; shared by the bank
 * transactions strip and the bureau panel so both say the same thing.
 */
import type { Ratio } from '@/modules/accounting/services/bank/codingMetrics';

export function fmtPct(r: Ratio): string {
  return r.pct === null ? '—' : `${Number.isInteger(r.pct) ? r.pct : r.pct.toFixed(1)}%`;
}

export function fmtDay(iso: string | null): string {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Africa/Johannesburg' });
}

/**
 * "Auto-coded by ISAFlow: 78% of lines this month (no line-by-line coding)". Not "no clicks": a bank-rule
 * run posts many lines from one click, and those lines count here.
 */
export function autoCodedLabel(r: Ratio): string {
  if (r.denominator === 0) return 'Auto-coded by ISAFlow: no lines coded this month yet';
  return `Auto-coded by ISAFlow: ${fmtPct(r)} of lines this month (no line-by-line coding)`;
}

/** "Suggestions accepted: 64% this month (log started 21 Oct 2026)", or the not-enough-data form. */
export function acceptedLabel(r: Ratio, since: string | null, min: number): string {
  const sinceText = since ? ` (log started ${fmtDay(since)})` : '';
  if (!r.enoughData) {
    return `Suggestions accepted: not enough data yet (${r.denominator} of ${min} decisions this month)${sinceText}`;
  }
  return `Suggestions accepted: ${fmtPct(r)} this month${sinceText}`;
}

/** A rate cell for the bureau table: the percentage, or "Not enough data yet". */
export function rateCell(r: Ratio): string {
  return r.enoughData ? fmtPct(r) : 'Not enough data yet';
}
