/**
 * Background work that must start only once the request's transaction has
 * COMMITTED, and must never run on the request's connection.
 *
 * Why not just fire-and-forget: an un-awaited promise keeps the request's ALS
 * context, so every `sql` it issues after the handler returns goes through
 * `store.client` — a connection the owner has already COMMITted and released
 * to the pool. The next request is handed that same connection, so the writes
 * land inside a stranger's transaction under its claims, or autocommit as the
 * pool's role, or die on a reaped client (R-075). And `als.exit` alone is not
 * enough either: the work typically reads rows the request just inserted, which
 * no other connection can see until the COMMIT.
 *
 * So the work is queued on the context, the owner starts it after a successful
 * COMMIT (never after a ROLLBACK), and it runs outside any ALS context: every
 * `sql` inside takes its own pooled connection and autocommits as the pool's
 * role, exactly like the webhook and cron callers of the same services.
 *
 * THE OBLIGATION THIS CREATES. There are no RLS GUCs on that path, so every
 * statement the work issues must scope itself to the tenant — a bare primary
 * key is not enough, because RLS is no longer behind it. Normally that means an
 * explicit `company_id` predicate. Two tables in the current callbacks carry no
 * `company_id` column and are scoped through a parent instead; there the
 * predicate must reproduce what the table's own RLS policy walks:
 *   - `bank_transaction_attachments` -> EXISTS on `bank_transactions.company_id`
 *   - `procurement_documents`        -> the `(entity_type, entity_id)` parent
 *                                       row, all six types its policy walks
 * One callback is genuinely tenant-free: `checkAndAlert` touches only
 * `admin_settings`, a platform-global table with no `company_id` column and no
 * tenant meaning. That is the only shape exempt from the rule.
 *
 * And scoping is not enough on its own: a fenced statement can match zero rows,
 * so log by OUTCOME (the row count), never on reaching the end of the function.
 * A success log over a no-op is the same false "extraction complete" that made
 * R-075 invisible in production.
 *
 * A callback that cannot scope itself does not belong here.
 */
import { als, type RequestContext } from '@/lib/als';
import { log } from '@/lib/logger';

/**
 * `als.run` for the code that OWNS `ctx`'s transaction (withAuth, the bearer
 * pipeline, withPlatformAdmin, …). Marks the context finished as soon as `fn`
 * settles, before the owner COMMITs and releases the client, so anything still
 * holding this context is refused by assertTxUsable from that point on.
 */
export async function runOwnedContext<T>(ctx: RequestContext, fn: () => Promise<T>): Promise<T> {
  try {
    return await als.run(ctx, fn);
  } finally {
    ctx.finished = true;
  }
}

/**
 * Run `fn` after the current request transaction commits.
 *
 * Outside any request context there is no transaction to wait for, so `fn`
 * starts immediately — the behaviour the webhook and API-key callers had. A
 * failure is logged under `label`, never thrown into the caller or into the
 * finished request.
 */
export function runAfterCommit(label: string, fn: () => Promise<unknown>): void {
  const store = als.getStore();
  if (!store) {
    detach(label, fn);
    return;
  }
  if (store.finished || !store.afterCommit) {
    // Loud on purpose: silently dropping the work, or starting it on the
    // request's connection, are the two failures this module exists to stop.
    throw new Error(
      `runAfterCommit(${label}): ${store.finished ? 'the request transaction has already finished'
        : "this transaction's owner does not run after-commit work"}`,
    );
  }
  store.afterCommit.push({ label, fn });
}

/**
 * Start every callback queued on `ctx`. The owner calls this ONLY after its
 * COMMIT succeeded; on ROLLBACK it simply does not, and the queue is dropped
 * with the context.
 */
export function drainAfterCommit(ctx: RequestContext): void {
  const queue = ctx.afterCommit ?? [];
  ctx.afterCommit = undefined;
  for (const { label, fn } of queue) detach(label, fn);
}

function detach(label: string, fn: () => Promise<unknown>): void {
  // als.exit: `fn` and every async continuation it creates see no store, so
  // `sql` inside goes to the pool rather than to a request's client.
  let started: Promise<unknown>;
  try {
    started = als.exit(fn);
  } catch (err) {
    started = Promise.reject(err);
  }
  started.catch((err: unknown) => {
    log.error('after-commit work failed', {
      label,
      error: err instanceof Error ? err.message : String(err),
    }, 'DB');
  });
}
