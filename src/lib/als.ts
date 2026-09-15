// src/lib/als.ts
import { AsyncLocalStorage } from 'node:async_hooks';
import { log } from '@/lib/logger';
import type { PoolClient } from 'pg';
import type { ControlPrincipal } from '@/modules/accounting/services/controls/contracts';

export interface RequestContext {
  client: PoolClient;
  userId: string;
  /** Absent for platform-admin requests (admin is global, not tenant-scoped). */
  companyId?: string;
  claims: Record<string, unknown>;
  /** Set only after authentication; financial services reject missing authority. */
  controlPrincipal?: ControlPrincipal;
  /** An indispensable change/effect audit failed; request must not commit. */
  controlWriteFailed?: boolean;
  /**
   * The error that set `controlWriteFailed`, recorded by `recordControlRefusal` so the wrapper can
   * classify it. The ROLLBACK is unconditional either way — this changes WHAT THE CLIENT IS TOLD,
   * never whether the transaction commits. `runJournalControl` poisons every refusal its controlled
   * write raises, because the direct journal routes create their draft journal OUTSIDE that write and
   * a 4xx would COMMIT the orphan; but an approval-required refusal is not an integrity failure, and
   * answering it 500 CONTROL_INTEGRITY_FAILED told the caller nothing it could act on. Only a class
   * registered in `apiRefusal.ts` changes the answer; anything else here stays a 500.
   */
  controlRefusal?: Error;
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
  /**
   * Set by runOwnedContext once the owner's callback has settled. From then on
   * the owner COMMITs or ROLLs BACK and releases `client` to its pool, where the
   * next request is handed the same connection. A query that outlived the
   * request (an un-awaited promise) would otherwise run inside that stranger's
   * transaction, under its claims, or autocommit as the pool's role (R-075).
   * assertTxUsable refuses instead.
   */
  finished?: boolean;
  /**
   * Work to start only after this transaction COMMITs (see `@/lib/afterCommit`).
   * Present only when the owner drains it; a context without it refuses
   * registration rather than dropping the work.
   */
  afterCommit?: Array<{ label: string; fn: () => Promise<unknown> }>;
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
 * Record WHAT poisoned this request, so the wrapper can say whether the caller can act on it.
 *
 * Called beside `controlWriteFailed = true`, never instead of it: the ROLLBACK is unconditional and
 * this only decides what the client is TOLD. Nothing is classified here — which refusals a transport
 * answers with a 4xx is a transport question (`@/lib/apiRefusal`), and the error is stored as it is so
 * `withAuth`/`bearerPipeline` can ask. Everything they do not recognise keeps the 500 that says an
 * integrity guarantee, not a business rule, stopped the request.
 *
 * Best-effort like `markTxUnusable` above, and here for the same reason: it is the same act — writing
 * one field onto the request store from inside an error path, where throwing would mask the original.
 */
export function recordControlRefusal(error: unknown): void {
  try {
    const store = als.getStore();
    if (store && error instanceof Error) store.controlRefusal = error;
  } catch {
    // Never let bookkeeping mask the original refusal.
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
  if (store?.finished) {
    throw new Error(
      'Request transaction has already finished and its connection was released — '
      + 'work that outlives the request must be registered with runAfterCommit (@/lib/afterCommit)',
    );
  }
  if (store?.txUnusable) {
    throw new Error(
      `Request transaction is unusable — a savepoint rollback failed earlier: ${store.txUnusable}`,
    );
  }
}
