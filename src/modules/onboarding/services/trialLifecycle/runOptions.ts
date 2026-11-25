/** The run's batch limit and kill switch (no imports, so the cron route can parse without the run). */
export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

/** `limit` query value → 1..MAX_LIMIT; anything unparseable is DEFAULT_LIMIT. */
export function clampLimit(raw: unknown): number {
  const n = Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, n));
}

/** Real sends happen only with env TRIAL_LIFECYCLE_EMAILS_ENABLED=1. */
export function sendsEnabled(): boolean {
  return process.env.TRIAL_LIFECYCLE_EMAILS_ENABLED === '1';
}
