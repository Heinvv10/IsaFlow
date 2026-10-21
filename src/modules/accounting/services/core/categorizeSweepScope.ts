/**
 * How much one smart-categorize sweep may take on (Hein, 2026-10-21, decision 2: the server is overloaded).
 *
 * One sweep = one "Apply rules" click on a bank account (smartCategorizeForAccount), for one company. It takes
 * only lines that are still uncoded (status 'imported', no suggested account or category, and no row in the
 * decision log), dated or imported in the last RECENT_DAYS, newest first, at most MAX_LINES of them. The same
 * MAX_LINES caps an explicit transactionIds request and the LLM residual pass that follows a sweep, so no
 * single request categorizes more than MAX_LINES lines, whichever path it takes.
 *
 * Widening later: raise the env vars below (no deploy of code needed, a service restart is). Watch box load
 * and the smart-categorize request time first, then the coding metrics (auto-coded %, suggestions accepted %).
 */
import { envLimit } from '../bank/vlmLimiter';

/** Lines dated, or imported, within this many days. Env: CATEGORIZE_SWEEP_RECENT_DAYS. */
export const CATEGORIZE_SWEEP_RECENT_DAYS_DEFAULT = 30;
/** Lines per company per sweep (and per explicit-id request). Env: CATEGORIZE_SWEEP_MAX_LINES. */
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
