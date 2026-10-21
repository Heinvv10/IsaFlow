/**
 * How much one smart-categorize sweep may take on (Hein, 2026-10-21, decision 2: the server is overloaded).
 *
 * One sweep = one "Apply rules" click on ONE bank account (smartCategorizeForAccount). It takes only lines
 * that are still uncoded (status 'imported', no suggested account or category, and no row in the decision
 * log), dated or imported in the last RECENT_DAYS, at most MAX_LINES of them, lines an earlier sweep already
 * tried last (categorizeSweepAttempts.ts). MAX_LINES is per bank account per request, not per company: a
 * company's requests are bounded only by checkAiRateLimit (20 per company). The LLM residual pass after a
 * sweep reads only that sweep's first-attempt lines. An explicit transactionIds request is refused above
 * MAX_LINES ids but is NOT held to the recent / uncoded filters: the user picked those lines.
 *
 * Widening later: raise the env vars below (no deploy of code needed, a service restart is). Watch box load
 * and the smart-categorize request time first, then the coding metrics (auto-coded %, suggestions accepted %).
 */
import { envLimit } from '../bank/vlmLimiter';

/** Lines dated, or imported, within this many days. Env: CATEGORIZE_SWEEP_RECENT_DAYS. */
export const CATEGORIZE_SWEEP_RECENT_DAYS_DEFAULT = 30;
/** Lines per bank account per sweep request (and per explicit-id request). Env: CATEGORIZE_SWEEP_MAX_LINES. */
export const CATEGORIZE_SWEEP_MAX_LINES_DEFAULT = 200;

export interface CategorizeSweepScope {
  recentDays: number;
  maxLines: number;
}

/** The scope in force now: a positive integer from the environment, else the default. */
export function categorizeSweepScope(): CategorizeSweepScope {
  return {
    recentDays: envLimit('CATEGORIZE_SWEEP_RECENT_DAYS', CATEGORIZE_SWEEP_RECENT_DAYS_DEFAULT),
    maxLines: envLimit('CATEGORIZE_SWEEP_MAX_LINES', CATEGORIZE_SWEEP_MAX_LINES_DEFAULT),
  };
}
