// src/lib/auth/adminFailureAudit.ts
/**
 * The audit trace of an admin request that did not commit (Hein, 2026-10-08).
 *
 * withPlatformAdmin rolls a failed admin action back whole: its own admin_audit_log row goes with it. So the attempt
 * is recorded here, AFTER the rollback, as one 'admin_request_failed' row: a single autocommit INSERT that names the
 * request (method, path without its query, status, why; target_id = a uuid that is a whole decoded path segment) and
 * nothing the action wrote, so it can never resurrect the action. It runs on the request's OWN connection when the
 * ROLLBACK succeeded (no new connection to queue for: under a busy pool a second one timed out and the attempt left
 * no row — brk-nrfb M-1), and on the pool only when that connection was destroyed. Best-effort: a failure is logged
 * and never changes the answer, which has already gone out. A GET / HEAD / OPTIONS changed nothing and is not recorded.
 */
import type { NextApiRequest } from 'next';
import { log } from '@/lib/logger';
import { getClientIp } from '@/lib/rateLimit';
import { sanitizeRoute } from '@/lib/sentry/tags';
import { getPlatformAdminPool } from './withPlatformAdmin.pools';

type Queryable = { query: (text: string, values: unknown[]) => Promise<unknown> };

export type AdminFailureReason = 'rolled_back' | 'rollback_only' | 'audit_write_failed' | 'threw';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The uuid the request path names as a whole segment, decoded as Next decodes it, or null. Not req.query: Next puts
 * the query string ahead of the route params there, so `?ref=<uuid>` chose the target (brk-nrfb LOW-1); not a uuid
 * found anywhere in the raw path, which percent-encoding or a suffix could point elsewhere (sec-nrfb LOW-1).
 */
function pathTarget(route: string | undefined): string | null {
  for (const segment of (route ?? '').split('/')) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      continue; // a malformed escape names nothing; Next would have refused the route anyway
    }
    if (UUID.test(decoded)) return decoded;
  }
  return null;
}

export async function auditFailedAdminRequest(
  req: NextApiRequest, adminUserId: string, status: number, reason: AdminFailureReason, client?: Queryable,
): Promise<void> {
  const method = String(req.method ?? 'GET').toUpperCase();
  if (SAFE_METHODS.has(method)) return;
  const route = sanitizeRoute(req.url);
  const details = { method, route, status, reason };
  // The rolled-back action's own row (e.g. user.reset_password, target = the user) is gone with it: the id in the
  // path is kept as target_id, so a view filtered by target still shows the attempt (rev-nrfb-blind LOW-2).
  const targetId = pathTarget(route);
  try {
    await (client ?? getPlatformAdminPool()).query(
      `INSERT INTO admin_audit_log (admin_user_id, action, target_type, target_id, details, ip_address)
       VALUES ($1, 'admin_request_failed', 'request', $2, $3::jsonb, $4)`,
      [adminUserId, targetId, JSON.stringify(details), req.socket ? getClientIp(req).slice(0, 45) : null],
    );
  } catch (err) {
    log.error('withPlatformAdmin: the failed admin request could not be audited', {
      adminUserId, ...details, message: err instanceof Error ? err.message : String(err),
    }, 'Auth');
  }
}
