// src/lib/als.ts
import { AsyncLocalStorage } from 'node:async_hooks';
import { log } from '@/lib/logger';
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
  /**
   * Set by withSavepoint when its ROLLBACK TO SAVEPOINT itself fails, carrying
   * the ORIGINAL error's message. The connection is aborted at that point, so
   * every later query on it would raise a bare 25P02 ("current transaction is
   * aborted") and lose the real cause. assertTxUsable reads this and throws
   * with the cause named instead. Same shape as criticalAuditFailed above:
   * a flag on the context that a later step is obliged to check.
   */
  txUnusable?: string;
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

/**
 * Record that the request transaction is unusable, and why.
 *
 * Best-effort by design: if there is no ALS store there is no shared
 * transaction to poison, and this must never itself throw from inside an error
 * handler.
 */
export function markTxUnusable(original: unknown, rollbackErr: unknown): void {
  try {
    const store = als.getStore();
    if (!store) return;
    const cause = original instanceof Error ? original.message : String(original);
    const why = rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
    store.txUnusable = `${cause} (and ROLLBACK TO SAVEPOINT then failed: ${why})`;
    log.error(
      'ROLLBACK TO SAVEPOINT failed — request transaction marked unusable',
      { cause, rollbackError: why },
      'DB',
    );
  } catch {
    // Never let bookkeeping mask the original failure.
  }
}

/**
 * Throw if the request transaction has been poisoned by a failed rollback.
 *
 * Called before routing a query through the request-scoped client, so a
 * catch-and-continue caller is told the ORIGINAL cause rather than the bare
 * 25P02 Postgres would answer with.
 */
export function assertTxUsable(): void {
  const store = als.getStore();
  if (store?.txUnusable) {
    throw new Error(
      `Request transaction is unusable — a savepoint rollback failed earlier: ${store.txUnusable}`,
    );
  }
}
