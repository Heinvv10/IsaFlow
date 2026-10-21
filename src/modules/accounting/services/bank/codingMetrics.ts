/**
 * Learning-loop coding metrics — pure computation. No imports, no I/O; the counts come from
 * codingMetricsService.ts. Definitions (Hein's design answers 2026-10-21):
 *
 *  1. autoCoded (headline, "no clicks"): bank lines coded in the period that ISAFlow posted without a
 *     person clicking, over all bank lines coded in the period. Backfilled from bank_transactions.
 *  2. suggestionsAccepted: decisions a PERSON made on an ISAFlow suggestion in the period that landed on the
 *     suggested target, over all such decisions (accepted + recoded + rejected). Auto-posted decisions, and
 *     suggestions ISAFlow itself superseded (decided_by NULL), are excluded. Matches count, judged by what
 *     the matched journal posts. Decision log only, so it starts the day the log shipped.
 *  3. firstThirtyDays: of the bank lines whose FIRST decision fell in the client's first 30 days (from its
 *     first bank import), the share whose first suggestion was accepted as-is (a person accepted it, or it
 *     was auto-posted and still stands). Decision log only.
 *  4. autoPostRecodeRate: auto-posted decisions in the period (by auto-post time) that were later undone or
 *     re-coded (hand-corrected, reversed, unmatched, run undo), over all auto-posted decisions in the period.
 *     Decision log only.
 * Rates 2–4 read "not enough data yet" below MIN_DECISIONS_FOR_RATE decisions; 1 is shown whenever a line
 * was coded. Bureau totals pool the counts across clients (sum of numerators over sum of denominators), so
 * each client weighs in by its line / decision count, not one vote per client.
 */

/** Below this many decisions, a decision-log rate is "not enough data yet". */
export const MIN_DECISIONS_FOR_RATE = 20;
/** A client's first-days window, from its first bank import. */
export const FIRST_WINDOW_DAYS = 30;

export interface Ratio {
  numerator: number;
  denominator: number;
  /** 0–100, one decimal; null when the denominator is 0 or below the minimum. */
  pct: number | null;
  enoughData: boolean;
}

export function ratio(numerator: number, denominator: number, min = 1): Ratio {
  const enoughData = denominator > 0 && denominator >= min;
  return {
    numerator,
    denominator,
    pct: enoughData ? Math.round((numerator / denominator) * 1000) / 10 : null,
    enoughData,
  };
}

export type FirstWindowSource = 'import_batch' | 'bank_transaction';

/** Raw counts for one company, as codingMetricsService reads them. */
export interface CompanyCodingCounts {
  companyId: string;
  linesCoded: number;
  linesAutoCoded: number;
  suggestionsDecided: number;
  suggestionsAccepted: number;
  autoPosted: number;
  autoPostedReversed: number;
  /** Earliest bank_import_batches.created_at, and earliest bank_transactions.created_at (read only when no batch). */
  firstBatchAt: string | null;
  firstLineAt: string | null;
  firstWindowDecided: number;
  firstWindowAccepted: number;
  /** created_at of the company's earliest decision-log row: when its rates 2–4 start. */
  decisionLogSince: string | null;
}

export interface CodingMetrics {
  autoCoded: Ratio;
  suggestionsAccepted: Ratio;
  firstThirtyDays: Ratio & { windowStart: string | null; windowEnd: string | null; windowSource: FirstWindowSource | null };
  autoPostRecodeRate: Ratio;
  decisionLogSince: string | null;
}

/**
 * The first-days window. The first bank import (earliest bank_import_batches.created_at) when the company
 * has one; else, for a company with lines but no batch rows (lines written by paths that record no batch),
 * the earliest bank_transactions.created_at; else none.
 */
export function firstWindow(firstBatchAt: string | null, firstLineAt: string | null): {
  start: string | null; end: string | null; source: FirstWindowSource | null;
} {
  const start = firstBatchAt ?? firstLineAt;
  if (!start) return { start: null, end: null, source: null };
  const end = new Date(new Date(start).getTime() + FIRST_WINDOW_DAYS * 86_400_000).toISOString();
  return { start: new Date(start).toISOString(), end, source: firstBatchAt ? 'import_batch' : 'bank_transaction' };
}

export function computeCodingMetrics(c: CompanyCodingCounts): CodingMetrics {
  const w = firstWindow(c.firstBatchAt, c.firstLineAt);
  return {
    autoCoded: ratio(c.linesAutoCoded, c.linesCoded),
    suggestionsAccepted: ratio(c.suggestionsAccepted, c.suggestionsDecided, MIN_DECISIONS_FOR_RATE),
    firstThirtyDays: {
      ...ratio(c.firstWindowAccepted, c.firstWindowDecided, MIN_DECISIONS_FOR_RATE),
      windowStart: w.start,
      windowEnd: w.end,
      windowSource: w.source,
    },
    autoPostRecodeRate: ratio(c.autoPostedReversed, c.autoPosted, MIN_DECISIONS_FOR_RATE),
    decisionLogSince: c.decisionLogSince,
  };
}

const earliest = (a: string | null, b: string | null): string | null =>
  a === null ? b : b === null ? a : (new Date(a) <= new Date(b) ? a : b);

/** Bureau total: counts pooled over the clients (line- / decision-weighted). */
export function aggregateCodingMetrics(clients: CompanyCodingCounts[]): CodingMetrics {
  type CountKey = 'linesCoded' | 'linesAutoCoded' | 'suggestionsDecided' | 'suggestionsAccepted'
    | 'autoPosted' | 'autoPostedReversed' | 'firstWindowDecided' | 'firstWindowAccepted';
  const sum = (k: CountKey) => clients.reduce((n, c) => n + c[k], 0);
  return {
    autoCoded: ratio(sum('linesAutoCoded'), sum('linesCoded')),
    suggestionsAccepted: ratio(sum('suggestionsAccepted'), sum('suggestionsDecided'), MIN_DECISIONS_FOR_RATE),
    // Each client's own first 30 days, pooled; the windows differ per client, so the total names none.
    firstThirtyDays: {
      ...ratio(sum('firstWindowAccepted'), sum('firstWindowDecided'), MIN_DECISIONS_FOR_RATE),
      windowStart: null, windowEnd: null, windowSource: null,
    },
    autoPostRecodeRate: ratio(sum('autoPostedReversed'), sum('autoPosted'), MIN_DECISIONS_FOR_RATE),
    decisionLogSince: clients.reduce<string | null>((d, c) => earliest(d, c.decisionLogSince), null),
  };
}

export interface MonthPeriod { month: string; from: string; to: string }

/** 'YYYY-MM' -> [first day, first day of next month). Invalid input -> null. */
export function monthPeriod(month: string): MonthPeriod | null {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const pad = (n: number) => String(n).padStart(2, '0');
  const next = mo === 12 ? `${y + 1}-01-01` : `${y}-${pad(mo + 1)}-01`;
  return { month, from: `${y}-${pad(mo)}-01`, to: next };
}

/** The current month in South Africa (UTC+2, no DST) as 'YYYY-MM'. */
export function currentSaMonth(now: Date = new Date()): string {
  const sa = new Date(now.getTime() + 2 * 3_600_000);
  return `${sa.getUTCFullYear()}-${String(sa.getUTCMonth() + 1).padStart(2, '0')}`;
}
