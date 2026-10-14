/**
 * Route categories that get per-company rate limiting from the auth wrappers
 * without each handler having to opt in. Pentest M23.
 *
 * ONE table, used by both `withAuth` (cookie) and the bearer pipeline. They
 * used to hold a hand-copied table each. Both write the same counter row
 * (`reports:<company>`), and one row has one window: had the copies ever
 * disagreed, each path would have kept resetting the other's count (R-175, the
 * same defect as the shared `portal-auth:` key).
 *
 * The table is intentionally small — add a pattern here, not a one-off in each
 * handler.
 *
 * `perUser`: the bucket is each member's own (`<key>:<company>:<user>`), so one
 * member — a viewer whose every request is refused, too — cannot use up the
 * company's allowance and lock the others out.
 */

import { checkRateLimit } from '@/lib/rateLimit';

export interface AutoBucket {
  prefix: string; key: string; max: number; windowSecs: number; perUser?: boolean;
  /** Which requests under the prefix are charged; every one when absent. */
  charges?: (method: string, query: URLSearchParams, path: string) => boolean;
}

// The audit jobs that read a whole ledger (forensic step 4): taking a snapshot or a check run, verifying a snapshot,
// its chain or a pack, comparing, building a pack, and downloading one (verified before it is served). Browsing a
// snapshot's rows, the audit log and the trail export are ordinary reads and are not charged.
const audit = (prefix: string, charges?: AutoBucket['charges']): AutoBucket =>
  ({ prefix: `/api/accounting/${prefix}`, key: 'audit', max: 30, windowSecs: 60, perUser: true, charges });

export const AUTO_RATE_LIMIT: ReadonlyArray<AutoBucket> = [
  { prefix: '/api/accounting/reports-', key: 'reports', max: 60, windowSecs: 60 },
  audit('audit-snapshots', (m, q) => m === 'POST' || q.has('verify') || q.has('chain')),
  audit('audit-comparisons'),
  audit('audit-check-runs', (m) => m === 'POST'),
  audit('audit-exports', (m, q, path) => m === 'POST' || q.has('verify') || path.endsWith('/download')),
];

/** False when the request has a bucket and the company (or, per user, the member) is over it. */
export async function checkAutoRateLimit(url: string | undefined, companyId: string, userId?: string, method = 'GET'): Promise<boolean> {
  const [path = '', query = ''] = (url ?? '').split('?');
  const bucket = AUTO_RATE_LIMIT.find((b) => path.startsWith(b.prefix));
  if (!bucket || (bucket.charges && !bucket.charges(method.toUpperCase(), new URLSearchParams(query), path))) return true;
  const key = bucket.perUser ? `${bucket.key}:${companyId}:${userId ?? 'anonymous'}` : `${bucket.key}:${companyId}`;
  return checkRateLimit(key, { max: bucket.max, windowSecs: bucket.windowSecs });
}

/**
 * Charges one whole-ledger audit job to the member's audit bucket — the same bucket the web routes charge by URL —
 * for callers no URL describes (the MCP audit tools all arrive on /api/mcp). False when the member is over it.
 */
export async function chargeAuditJob(companyId: string, userId: string): Promise<boolean> {
  const bucket = AUTO_RATE_LIMIT.find((b) => b.key === 'audit')!;
  return checkRateLimit(`audit:${companyId}:${userId}`, { max: bucket.max, windowSecs: bucket.windowSecs });
}
