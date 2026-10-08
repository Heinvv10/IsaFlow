// src/lib/auth/adminFailureAudit.ts
/**
 * The audit trace of an admin request that did not commit (Hein, 2026-10-08).
 *
 * withPlatformAdmin rolls a failed admin action back whole: its own admin_audit_log row goes with it. So the attempt
 * is recorded here, AFTER the rollback, as one 'admin_request_failed' row on a separate pooled connection: a single
 * autocommit INSERT that names the request (method, path without its query, status, why; target_id = the first uuid
 * in the path) and nothing the action wrote,
 * so it can never resurrect the action. Best-effort: a failure is logged and never changes the answer, which has
 * already gone out. A GET / HEAD / OPTIONS changed nothing and is not recorded.
 */
import type { NextApiRequest } from 'next';
import { log } from '@/lib/logger';
import { getClientIp } from '@/lib/rateLimit';
import { sanitizeRoute } from '@/lib/sentry/tags';
import { getPlatformAdminPool } from './withPlatformAdmin.pools';

export type AdminFailureReason = 'rolled_back' | 'rollback_only' | 'audit_write_failed' | 'threw';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const UUID_IN_PATH = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export async function auditFailedAdminRequest(
  req: NextApiRequest, adminUserId: string, status: number, reason: AdminFailureReason,
): Promise<void> {
  const method = String(req.method ?? 'GET').toUpperCase();
  if (SAFE_METHODS.has(method)) return;
  const route = sanitizeRoute(req.url);
  const details = { method, route, status, reason };
  // The rolled-back action's own row (e.g. user.reset_password, target = the user) is gone with it: the id in the
  // path is kept as target_id, so a view filtered by target still shows the attempt (rev-nrfb-blind LOW-2).
  const targetId = route?.match(UUID_IN_PATH)?.[0] ?? null;
  try {
    await getPlatformAdminPool().query(
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
