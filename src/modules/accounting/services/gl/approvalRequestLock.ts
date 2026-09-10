/**
 * Row lock for the approval DECIDE path.
 *
 * `decideRequest` computes authority in `assertMayDecide` — one unlocked SELECT
 * of `(requested_by, rule_id, required_role, approver_role, decider_role)` — and
 * then issues a separate status-predicated UPDATE. Nothing pinned the row
 * between them.
 *
 * That was tolerable while `rule_id` on a pending row was immutable. It is not:
 * `rebindPendingRequest` UPDATEs `rule_id` and `required_role` on exactly those
 * rows, so under READ COMMITTED a concurrent re-request can move a request onto
 * a different rule AFTER the decider's authority was checked against the old
 * one, and the decide still commits — the UPDATE blocks on the rebind's row
 * lock, re-checks only `status = 'pending'`, and applies. The ratchet bounds the
 * damage (a rebind can only raise the demand), so the loss is a decision taken
 * under a rule that no longer governs; the lock removes the window entirely.
 *
 * Modelled on `bank/bankTxLock.ts` and `gl/glAccountLock.ts` — same idiom, same
 * 5s budget, deliberately not a third one.
 */
import { sql, withSavepoint } from '@/lib/neon';
import { als, assertTxUsable } from '@/lib/als';

/** Postgres `lock_not_available` — `lock_timeout` elapsed waiting for the row. */
const LOCK_NOT_AVAILABLE = '55P03';

/** Another request held the row longer than the 5s budget. A 409, not a fault. */
export class ApprovalRequestLockTimeoutError extends Error {
  readonly code = 'APPROVAL_REQUEST_LOCK_TIMEOUT';
  constructor(requestId: string) {
    super(`Approval request ${requestId} is being changed by another request — retry in a moment.`);
    this.name = 'ApprovalRequestLockTimeoutError';
  }
}

const isLockTimeout = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && (err as { code?: unknown }).code === LOCK_NOT_AVAILABLE;

/**
 * Lock one approval request for the rest of the surrounding transaction.
 *
 * A missing, foreign or already-decided id simply locks nothing: the caller's
 * own guards report those, and turning "not found" into a lock error here would
 * change three answers the route already gets right.
 *
 * Throws outside a request transaction, where `FOR UPDATE` releases the instant
 * the SELECT returns and the caller would believe it is serialised when it is
 * not.
 */
export async function lockApprovalRequestForUpdate(
  companyId: string,
  requestId: string,
): Promise<void> {
  const client = als.getStore()?.client;
  if (!client) {
    throw new Error(
      'lockApprovalRequestForUpdate requires a request transaction (withAuth / als.run). '
      + 'Outside one, FOR UPDATE is released immediately and locks nothing.',
    );
  }

  // A transaction setting, issued on the request client rather than through
  // `sql`. Re-issued every call: `SET LOCAL` is subtransaction-aware, so a
  // ROLLBACK TO SAVEPOINT restores the previous value — which is `0`, no timeout
  // at all.
  assertTxUsable();
  await client.query("SET LOCAL lock_timeout = '5s'");

  // Savepointed because 55P03 ABORTS the transaction. The caller answers the
  // timeout as a 409 and carries on, and without the rollback every later
  // statement on the connection — including the COMMIT — raises a bare 25P02.
  // Harmless only while this is the first statement of the handler; the
  // savepoint is what keeps it harmless if anything is ever written before it.
  try {
    await withSavepoint('approval_request_lock', async () => {
      await sql`
        SELECT id FROM approval_requests
         WHERE id = ${requestId}::UUID AND company_id = ${companyId} AND status = 'pending'
         FOR UPDATE`;
    });
  } catch (err) {
    if (isLockTimeout(err)) throw new ApprovalRequestLockTimeoutError(requestId);
    throw err;
  }
}
