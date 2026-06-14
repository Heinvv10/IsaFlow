// src/lib/als.ts
import { AsyncLocalStorage } from 'node:async_hooks';
import type { PoolClient } from 'pg';

export interface RequestContext {
  client: PoolClient;
  userId: string;
  /** Absent for platform-admin requests (admin is global, not tenant-scoped). */
  companyId?: string;
  claims: Record<string, unknown>;
  /**
   * Set by auditService.logAdminAction when a CRITICAL_ACTIONS audit write
   * fails. The platform-admin middleware (withPlatformAdmin) checks this before
   * COMMIT and forces a ROLLBACK, so a privileged action can never persist
   * without its audit row — even if a route-level catch swallows the thrown
   * CriticalAuditError. (Pentest M6.)
   */
  criticalAuditFailed?: boolean;
}

export const als = new AsyncLocalStorage<RequestContext>();

export function requireCtx(): RequestContext {
  const ctx = als.getStore();
  if (!ctx) {
    throw new Error(
      'als: no request context — handler called outside withAuth/withPlatformAdmin or background job called sql without wrapping?'
    );
  }
  return ctx;
}
