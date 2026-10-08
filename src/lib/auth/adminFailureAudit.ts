// src/lib/auth/adminFailureAudit.ts
/**
 * The audit trace of an admin request that did not commit (Hein, 2026-10-08).
 *
 * withPlatformAdmin rolls a failed admin action back whole: its own admin_audit_log row goes with it. So the attempt
 * is recorded here, AFTER the rollback, as one 'admin_request_failed' row on a separate pooled connection: a single
 * autocommit INSERT that names the request (method, path without its query, status, why) and nothing the action wrote,
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

export async function auditFailedAdminRequest(
  req: NextApiRequest, adminUserId: string, status: number, reason: AdminFailureReason,
): Promise<void> {
  const method = String(req.method ?? 'GET').toUpperCase();
  if (SAFE_METHODS.has(method)) return;
  const details = { method, route: sanitizeRoute(req.url), status, reason };
  try {
    await getPlatformAdminPool().query(
      `INSERT INTO admin_audit_log (admin_user_id, action, target_type, target_id, details, ip_address)
       VALUES ($1, 'admin_request_failed', 'request', NULL, $2::jsonb, $3)`,
      [adminUserId, JSON.stringify(details), req.socket ? getClientIp(req).slice(0, 45) : null],
    );
  } catch (err) {
    log.error('withPlatformAdmin: the failed admin request could not be audited', {
      adminUserId, ...details, message: err instanceof Error ? err.message : String(err),
    }, 'Auth');
  }
}
