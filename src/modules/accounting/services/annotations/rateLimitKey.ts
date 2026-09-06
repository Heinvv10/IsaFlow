/**
 * The annotation rate-limit bucket name.
 *
 * checkReportRateLimit already appends the company, so what this adds is the
 * USER. Both together are the bucket: per company so one tenant cannot spend
 * another's capacity, and per user so one colleague cannot spend a teammate's.
 * A company-only key made the second failure possible and is what this closes.
 */
export function annotationRateLimitKey(action: 'list' | 'create' | 'resolve', userId: string): string {
  return `annotation-${action}:u:${userId}`;
}
