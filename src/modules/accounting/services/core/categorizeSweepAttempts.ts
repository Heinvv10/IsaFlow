/**
 * Which lines a smart-categorize sweep already tried, per bank account, for RETRY_HOURS.
 *
 * Why: a line that matches no rule, pattern or history gets no suggestion and no decision-log row, so the
 * sweep's SQL alone would pick the same newest MAX_LINES unmatchable lines on every click and never reach the
 * older ones (and re-send them to the LLM residual pass each time). selectSweepLineIds orders lines tried
 * here LAST, so each click reaches untried lines first and still retries the tried ones once nothing else is
 * left (a new rule still applies to them). The route sends only first attempts to the LLM.
 *
 * In-process and bounded: a restart or a second process just forgets, which costs one re-attempt, never a
 * wrong suggestion. No schema change.
 */
import { envLimit } from '../bank/vlmLimiter';

/** How long a tried line stays at the back of the queue. Env: CATEGORIZE_SWEEP_RETRY_HOURS. */
export const CATEGORIZE_SWEEP_RETRY_HOURS_DEFAULT = 24;
/** Tried lines remembered per bank account (oldest dropped first). */
export const MAX_ATTEMPTS_PER_ACCOUNT = 5000;
/** Bank accounts remembered (least recently swept dropped first). */
export const MAX_ACCOUNTS = 2000;

const attempts = new Map<string, Map<string, number>>();
const keyOf = (companyId: string, bankAccountId: string) => `${companyId}:${bankAccountId}`;

function live(companyId: string, bankAccountId: string, now: number): Map<string, number> | undefined {
  const tried = attempts.get(keyOf(companyId, bankAccountId));
  if (!tried) return undefined;
  const ttl = envLimit('CATEGORIZE_SWEEP_RETRY_HOURS', CATEGORIZE_SWEEP_RETRY_HOURS_DEFAULT) * 3_600_000;
  // Insertion order is attempt order, so the expired entries are at the front.
  for (const [id, at] of tried) {
    if (now - at < ttl) break;
    tried.delete(id);
  }
  return tried;
}

/** The lines on this account tried within RETRY_HOURS. */
export function recentlyAttempted(companyId: string, bankAccountId: string, now = Date.now()): string[] {
  return [...(live(companyId, bankAccountId, now)?.keys() ?? [])];
}

/** Records a sweep's lines as tried now; returns those not tried within RETRY_HOURS before (first attempts). */
export function markAttempted(companyId: string, bankAccountId: string, ids: string[], now = Date.now()): string[] {
  const key = keyOf(companyId, bankAccountId);
  const tried = live(companyId, bankAccountId, now) ?? new Map<string, number>();
  attempts.delete(key);
  attempts.set(key, tried); // most recently swept last
  const first: string[] = [];
  for (const id of ids) {
    if (!tried.has(id)) first.push(id);
    tried.delete(id);
    tried.set(id, now);
  }
  for (const id of tried.keys()) {
    if (tried.size <= MAX_ATTEMPTS_PER_ACCOUNT) break;
    tried.delete(id);
  }
  for (const k of attempts.keys()) {
    if (attempts.size <= MAX_ACCOUNTS) break;
    attempts.delete(k);
  }
  return first;
}

/** Tests only. */
export function resetSweepAttempts(): void {
  attempts.clear();
}
